// launchd integration — `yome daemon install` writes a plist to
// ~/Library/LaunchAgents/work.yome.daemon.plist and loads it via
// launchctl, so the daemon survives reboots / logouts.
//
// We deliberately use a USER LaunchAgent (not a system LaunchDaemon) so
// no sudo is required and the daemon inherits the user's environment
// (Keychain access, ~/.yome/, etc.).

import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { PLIST_LABEL, STDOUT_LOG, STDERR_LOG, DAEMON_ROOT } from './paths.js';

const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = join(LAUNCH_AGENTS_DIR, `${PLIST_LABEL}.plist`);

function buildPlist(yomeBinPath: string): string {
  // ProgramArguments uses absolute paths because launchd doesn't honour
  // the user's interactive PATH. We prepend a wide PATH for the agent's
  // own subprocess spawns (Bash tool / skill OTA backends).
  const homebrewBin = '/opt/homebrew/bin';
  const localBin = '/usr/local/bin';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${yomeBinPath}</string>
    <string>daemon</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
    <key>Crashed</key><true/>
  </dict>
  <key>StandardOutPath</key><string>${STDOUT_LOG}</string>
  <key>StandardErrorPath</key><string>${STDERR_LOG}</string>
  <key>WorkingDirectory</key><string>${homedir()}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${homebrewBin}:${localBin}:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>${homedir()}</string>
  </dict>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

export interface InstallResult {
  ok: boolean;
  plistPath: string;
  message: string;
}

export function installLaunchAgent(yomeBinPath: string): InstallResult {
  if (process.platform !== 'darwin') {
    return { ok: false, plistPath: PLIST_PATH, message: 'launchd is macOS-only' };
  }
  try {
    mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
    mkdirSync(DAEMON_ROOT, { recursive: true });
    const plist = buildPlist(yomeBinPath);
    writeFileSync(PLIST_PATH, plist, 'utf-8');
    // unload first (ignore errors — likely just "not loaded")
    try { execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: 'ignore' }); } catch { /* noop */ }
    execSync(`launchctl load "${PLIST_PATH}"`, { stdio: 'ignore' });
    return { ok: true, plistPath: PLIST_PATH, message: `installed and loaded ${PLIST_PATH}` };
  } catch (e: any) {
    return { ok: false, plistPath: PLIST_PATH, message: `install failed: ${e?.message ?? e}` };
  }
}

export function uninstallLaunchAgent(): InstallResult {
  if (process.platform !== 'darwin') {
    return { ok: false, plistPath: PLIST_PATH, message: 'launchd is macOS-only' };
  }
  try {
    if (existsSync(PLIST_PATH)) {
      try { execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: 'ignore' }); } catch { /* noop */ }
      unlinkSync(PLIST_PATH);
      return { ok: true, plistPath: PLIST_PATH, message: `unloaded and removed ${PLIST_PATH}` };
    }
    return { ok: true, plistPath: PLIST_PATH, message: '(was not installed)' };
  } catch (e: any) {
    return { ok: false, plistPath: PLIST_PATH, message: `uninstall failed: ${e?.message ?? e}` };
  }
}
