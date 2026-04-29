// swift-tools-version:5.9
//
// yome-calwatch — long-lived EventKit watcher that drives the
// `--on calendar:*` triggers in the Yome daemon.
//
// Build:
//   cd cli/native/calwatch
//   swift build -c release
//   cp .build/release/yome-calwatch ../../bin/yome-calwatch
//
// We intentionally have no external Swift package dependencies: the
// helper must be tiny, fast, and trivially auditable. EventKit is a
// system framework (no SwiftPM dep declaration needed; the linker
// finds it via -framework EventKit).

import PackageDescription

let package = Package(
    name: "yome-calwatch",
    platforms: [
        .macOS(.v13),
    ],
    targets: [
        .executableTarget(
            name: "yome-calwatch",
            path: "Sources",
            linkerSettings: [
                .linkedFramework("EventKit"),
                .linkedFramework("Foundation"),
            ]
        ),
    ]
)
