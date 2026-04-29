// yome-calwatch — EventKit watcher for the Yome daemon.
//
// Modes:
//   yome-calwatch --check-access
//       Probe Calendar permission, exit 0 ok / 2 denied / 3 not-yet.
//
//   yome-calwatch --config <path>
//       Long-lived. Reads a JSON file describing one watch spec
//       (events[], titleRegex?, calendar?), then loops:
//         1. Look at the next ~24h of events in matching calendars.
//         2. Filter by title regex (if any).
//         3. For each event still in the future:
//              - 'event-start' fires at (start - leadMs).
//              - 'event-end' fires at end.
//         4. 'event-added' fires whenever EKEventStoreChanged fires
//            and a brand-new (id never seen before) matching event
//            appears in the next 24h window.
//         5. Re-scan on .EKEventStoreChanged or after each fire.
//
// Idempotency: a Set<String> of "<eventId>|<kind>" entries lives in
// memory. The daemon respawns this helper on crash/restart, so we also
// persist that set to <stateDir>/fired.json (next to the config) so a
// daemon restart doesn't double-fire events that already fired.
//
// Output: one JSON line per emit, written to stdout, flushed eagerly.
//   {"type":"ready","permission":"granted"}
//   {"type":"event","kind":"event-start","eventId":"abc","title":"Standup","calendar":"Work","startMs":..,"endMs":..,"taskId":"tsk_..."}
//   {"type":"heartbeat","ts":..}
//   {"type":"error","message":"...","fix":"..."}

import EventKit
import Foundation

// MARK: - JSON line emitter

let stdoutLock = NSLock()
func emit(_ obj: [String: Any]) {
    stdoutLock.lock(); defer { stdoutLock.unlock() }
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

func emitError(_ message: String, fix: String? = nil, code: String? = nil) {
    var o: [String: Any] = ["type": "error", "message": message]
    if let fix { o["fix"] = fix }
    if let code { o["code"] = code }
    emit(o)
}

// MARK: - Permission

enum AccessStatus { case granted, denied, notDetermined, restricted, unknown }

func currentAccessStatus() -> AccessStatus {
    let status = EKEventStore.authorizationStatus(for: .event)
    switch status {
    case .authorized:               return .granted
    case .denied:                   return .denied
    case .notDetermined:            return .notDetermined
    case .restricted:               return .restricted
    case .fullAccess:               return .granted
    case .writeOnly:                return .granted
    @unknown default:               return .unknown
    }
}

/// Synchronous wrapper around the async EventKit access prompt.
/// Uses a DispatchSemaphore so we can call it from sync contexts
/// (we don't want our `main` to be `async`, see entry point below).
func requestAccessBlocking(store: EKEventStore) -> AccessStatus {
    let sem = DispatchSemaphore(value: 0)
    var result: AccessStatus = .unknown
    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents { granted, _ in
            result = granted ? .granted : .denied
            sem.signal()
        }
    } else {
        store.requestAccess(to: .event) { granted, _ in
            result = granted ? .granted : .denied
            sem.signal()
        }
    }
    sem.wait()
    return result
}

// MARK: - Spec

struct WatchSpec: Decodable {
    let taskId: String
    let events: [String]                // "event-start" | "event-end" | "event-added"
    let leadMs: Int?                    // for event-start; default 0
    let titleRegex: String?
    let calendar: String?               // calendar display name (case-insensitive contains)
    let stateDir: String                // where fired.json lives
}

func loadSpec(path: String) throws -> WatchSpec {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    return try JSONDecoder().decode(WatchSpec.self, from: data)
}

// MARK: - Fired-IDs persistence

final class FiredStore {
    private let path: String
    private var ids: Set<String> = []

    init(stateDir: String) {
        self.path = (stateDir as NSString).appendingPathComponent("fired.json")
        load()
    }

    func contains(_ key: String) -> Bool { ids.contains(key) }

    func record(_ key: String) {
        ids.insert(key)
        save()
    }

    /// Drop entries older than 7 days (key encodes start time after `@`).
    func gc(now: TimeInterval) {
        let cutoff = now - 7 * 86_400
        let kept = ids.filter { key in
            guard let atIdx = key.lastIndex(of: "@") else { return true }
            let tail = String(key[key.index(after: atIdx)...])
            guard let t = Double(tail) else { return true }
            return t >= cutoff
        }
        if kept.count != ids.count {
            ids = kept
            save()
        }
    }

    private func load() {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [String]
        else { return }
        ids = Set(arr)
    }

    private func save() {
        try? FileManager.default.createDirectory(
            atPath: (path as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true
        )
        guard let data = try? JSONSerialization.data(withJSONObject: Array(ids).sorted(), options: []) else { return }
        // Atomic write via tmp+rename so a crash mid-save can't corrupt.
        let tmp = path + ".tmp"
        do {
            try data.write(to: URL(fileURLWithPath: tmp))
            try? FileManager.default.removeItem(atPath: path)
            try FileManager.default.moveItem(atPath: tmp, toPath: path)
        } catch {
            // Don't crash; missed persistence just risks a re-fire on restart.
        }
    }
}

// MARK: - Watcher

final class CalendarWatcher {
    let store = EKEventStore()
    let spec: WatchSpec
    let fired: FiredStore
    let titleRegex: NSRegularExpression?
    var observer: NSObjectProtocol?
    var nextTimer: Timer?
    var heartbeatTimer: Timer?
    var seenEventIds: Set<String> = []   // for event-added: known IDs as of last scan

    init(spec: WatchSpec) {
        self.spec = spec
        self.fired = FiredStore(stateDir: spec.stateDir)
        if let r = spec.titleRegex, !r.isEmpty {
            self.titleRegex = try? NSRegularExpression(pattern: r, options: [.caseInsensitive])
        } else {
            self.titleRegex = nil
        }
    }

    func start() {
        observer = NotificationCenter.default.addObserver(
            forName: .EKEventStoreChanged, object: store, queue: .main
        ) { [weak self] _ in
            self?.rescan(reason: "store-changed")
        }
        // Initial seed of seenEventIds so we don't fire 'event-added'
        // for everything that already exists.
        seenEventIds = Set(matchingEvents(now: Date()).map { $0.eventIdentifier ?? $0.calendarItemIdentifier })

        emit([
            "type": "ready",
            "permission": "granted",
            "taskId": spec.taskId,
            "events": spec.events,
            "leadMs": spec.leadMs ?? 0,
            "titleRegex": spec.titleRegex ?? "",
            "calendar": spec.calendar ?? "",
        ])

        rescan(reason: "initial")
        scheduleHeartbeat()
    }

    func stop() {
        if let o = observer { NotificationCenter.default.removeObserver(o); observer = nil }
        nextTimer?.invalidate(); nextTimer = nil
        heartbeatTimer?.invalidate(); heartbeatTimer = nil
    }

    // MARK: - Querying

    private func matchingCalendars() -> [EKCalendar] {
        let all = store.calendars(for: .event)
        guard let needle = spec.calendar?.lowercased(), !needle.isEmpty else { return all }
        return all.filter { $0.title.lowercased().contains(needle) }
    }

    /// Events in [now, now+24h] in matching calendars whose title also
    /// matches the regex (if any).
    private func matchingEvents(now: Date) -> [EKEvent] {
        let cals = matchingCalendars()
        if cals.isEmpty { return [] }
        let end = now.addingTimeInterval(24 * 3600)
        let predicate = store.predicateForEvents(withStart: now.addingTimeInterval(-3600), end: end, calendars: cals)
        let raw = store.events(matching: predicate)
        guard let regex = titleRegex else { return raw }
        return raw.filter { ev in
            let t = ev.title ?? ""
            let r = NSRange(location: 0, length: (t as NSString).length)
            return regex.firstMatch(in: t, options: [], range: r) != nil
        }
    }

    // MARK: - Rescan loop

    func rescan(reason: String) {
        let now = Date()
        fired.gc(now: now.timeIntervalSince1970)

        let events = matchingEvents(now: now)

        // 1. event-added: any new ID we haven't seen this session.
        if spec.events.contains("event-added") {
            for ev in events {
                let id = ev.eventIdentifier ?? ev.calendarItemIdentifier
                if !seenEventIds.contains(id) && (ev.startDate ?? .distantPast) >= now {
                    fire(kind: "event-added", event: ev)
                }
            }
        }
        seenEventIds = Set(events.map { $0.eventIdentifier ?? $0.calendarItemIdentifier })

        // 2. event-start / event-end: fire any that are already due.
        let lead = TimeInterval((spec.leadMs ?? 0)) / 1000.0
        for ev in events {
            guard let s = ev.startDate else { continue }
            if spec.events.contains("event-start") {
                let dueAt = s.addingTimeInterval(-lead)
                if dueAt <= now { tryFire(kind: "event-start", event: ev, anchor: s) }
            }
            if spec.events.contains("event-end"), let e = ev.endDate, e <= now {
                tryFire(kind: "event-end", event: ev, anchor: e)
            }
        }

        // 3. Schedule next wakeup at the earliest "future" trigger.
        var next: Date? = nil
        for ev in events {
            guard let s = ev.startDate else { continue }
            if spec.events.contains("event-start") {
                let dueAt = s.addingTimeInterval(-lead)
                if dueAt > now { next = min2(next, dueAt) }
            }
            if spec.events.contains("event-end"), let e = ev.endDate, e > now {
                next = min2(next, e)
            }
        }

        nextTimer?.invalidate(); nextTimer = nil
        guard let nextAt = next else {
            // Nothing in the next 24h — re-check in 5 min anyway (the
            // window slides forward, new events might land via sync).
            nextTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: false) { [weak self] _ in
                self?.rescan(reason: "idle-tick")
            }
            return
        }
        let delay = max(nextAt.timeIntervalSinceNow, 0.5)
        nextTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            self?.rescan(reason: "due")
        }
    }

    private func tryFire(kind: String, event ev: EKEvent, anchor: Date) {
        let key = firedKey(eventId: ev.eventIdentifier ?? ev.calendarItemIdentifier, kind: kind, anchor: anchor)
        if fired.contains(key) { return }
        fired.record(key)
        fire(kind: kind, event: ev)
    }

    private func fire(kind: String, event ev: EKEvent) {
        emit([
            "type": "event",
            "kind": kind,
            "taskId": spec.taskId,
            "eventId": ev.eventIdentifier ?? ev.calendarItemIdentifier,
            "title": ev.title ?? "",
            "calendar": ev.calendar?.title ?? "",
            "startMs": Int((ev.startDate ?? .distantPast).timeIntervalSince1970 * 1000),
            "endMs": Int((ev.endDate ?? .distantPast).timeIntervalSince1970 * 1000),
            "location": ev.location ?? "",
            "notes": ev.notes ?? "",
        ])
    }

    private func firedKey(eventId: String, kind: String, anchor: Date) -> String {
        // Include start time so a recurring event series instance fires
        // independently from siblings (eventIdentifier is shared across
        // the series for some calendars).
        return "\(eventId)|\(kind)@\(anchor.timeIntervalSince1970)"
    }

    private func scheduleHeartbeat() {
        heartbeatTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
            emit(["type": "heartbeat", "ts": Int(Date().timeIntervalSince1970 * 1000)])
        }
    }
}

// MARK: - Helpers

func min2(_ a: Date?, _ b: Date) -> Date {
    guard let a else { return b }
    return a < b ? a : b
}

// MARK: - Argument parsing

func argValue(_ name: String) -> String? {
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: name), i + 1 < args.count { return args[i + 1] }
    return nil
}

// MARK: - Entry

// We keep `main` synchronous so `RunLoop.main.run()` is reachable.
// The few places that need async (EventKit access prompt) are wrapped
// in a DispatchSemaphore.
func runApp() {
    let args = CommandLine.arguments

    // Mode: --check-access (one-shot probe).
    if args.contains("--check-access") {
        let store = EKEventStore()
        switch currentAccessStatus() {
        case .granted:
            emit(["type": "access", "status": "granted"])
            exit(0)
        case .denied:
            emit(["type": "access", "status": "denied",
                  "fix": "open System Settings → Privacy & Security → Calendars and grant access to yome-calwatch"])
            exit(2)
        case .restricted:
            emit(["type": "access", "status": "restricted",
                  "fix": "calendar access is blocked by a profile/MDM; cannot proceed"])
            exit(2)
        case .notDetermined:
            // First contact — trigger the system prompt and wait.
            let result = requestAccessBlocking(store: store)
            if result == .granted {
                emit(["type": "access", "status": "granted"])
                exit(0)
            } else {
                emit(["type": "access", "status": "denied",
                      "fix": "you declined the prompt; re-grant in System Settings → Privacy & Security → Calendars"])
                exit(2)
            }
        case .unknown:
            emit(["type": "access", "status": "unknown"])
            exit(3)
        }
    }

    // Mode: watch.
    guard let configPath = argValue("--config") else {
        emitError("missing --config <path>", fix: "yome-calwatch --config /path/to/spec.json")
        exit(64)
    }

    let spec: WatchSpec
    do {
        spec = try loadSpec(path: configPath)
    } catch {
        emitError("failed to load spec: \(error.localizedDescription)")
        exit(65)
    }

    // Permission gate at startup (option C).
    let store = EKEventStore()
    switch currentAccessStatus() {
    case .granted: break
    case .notDetermined:
        let r = requestAccessBlocking(store: store)
        if r != .granted {
            emitError("calendar permission denied",
                      fix: "grant access in System Settings → Privacy & Security → Calendars",
                      code: "no_permission")
            exit(2)
        }
    default:
        emitError("calendar permission not granted",
                  fix: "grant access in System Settings → Privacy & Security → Calendars",
                  code: "no_permission")
        exit(2)
    }

    let watcher = CalendarWatcher(spec: spec)

    // SIGTERM handler: clean exit so the daemon's spawn() resolves.
    let sigSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    signal(SIGTERM, SIG_IGN)
    sigSrc.setEventHandler {
        watcher.stop()
        emit(["type": "shutdown", "reason": "sigterm"])
        exit(0)
    }
    sigSrc.resume()

    watcher.start()
    RunLoop.main.run()  // blocks forever; timers fire on main queue
}

runApp()
