// systemd --user unit integration — `yome daemon install` on Linux
// writes a unit to ~/.config/systemd/user/yome-mesh.service and
// enables it via `systemctl --user enable --now`, so the mesh daemon
// survives reboots / logouts (when lingering is enabled).
//
// We deliberately use a USER unit (not a system-wide one) so:
//   - No sudo required (parallel with launchd LaunchAgent on macOS).
//   - The unit inherits the user's $HOME and reads ~/.yome/{auth,device}.json.
//   - Stopping `yome mesh` doesn't risk taking down anything system-wide.

import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

const UNIT_NAME = 'yome-mesh.service';
const USER_UNIT_DIR = join(homedir(), '.config', 'systemd', 'user');
const UNIT_PATH = join(USER_UNIT_DIR, UNIT_NAME);

function buildUnit(yomeBinPath: string, nodePath: string): string {
  return `[Unit]
Description=Yome mesh device daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodePath} ${yomeBinPath} mesh start --foreground
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal
Environment=HOME=${homedir()}

[Install]
WantedBy=default.target
`;
}

export interface SystemdInstallResult {
  ok: boolean;
  unitPath: string;
  message: string;
}

export function installSystemdUnit(yomeBinPath: string): SystemdInstallResult {
  if (process.platform !== 'linux') {
    return { ok: false, unitPath: UNIT_PATH, message: 'systemd is Linux-only' };
  }
  if (!hasSystemctl()) {
    return { ok: false, unitPath: UNIT_PATH, message: 'systemctl not found on PATH' };
  }
  try {
    mkdirSync(USER_UNIT_DIR, { recursive: true });
    writeFileSync(UNIT_PATH, buildUnit(yomeBinPath, process.execPath), 'utf-8');
    execSync(`systemctl --user daemon-reload`, { stdio: 'ignore' });
    execSync(`systemctl --user enable --now ${UNIT_NAME}`, { stdio: 'ignore' });
    return { ok: true, unitPath: UNIT_PATH, message: `installed and started ${UNIT_PATH}` };
  } catch (e) {
    return { ok: false, unitPath: UNIT_PATH, message: `install failed: ${(e as Error).message}` };
  }
}

export function uninstallSystemdUnit(): SystemdInstallResult {
  if (process.platform !== 'linux') {
    return { ok: false, unitPath: UNIT_PATH, message: 'systemd is Linux-only' };
  }
  if (!hasSystemctl()) {
    return { ok: false, unitPath: UNIT_PATH, message: 'systemctl not found on PATH' };
  }
  try {
    try { execSync(`systemctl --user disable --now ${UNIT_NAME}`, { stdio: 'ignore' }); } catch { /* ignore */ }
    if (existsSync(UNIT_PATH)) unlinkSync(UNIT_PATH);
    try { execSync(`systemctl --user daemon-reload`, { stdio: 'ignore' }); } catch { /* ignore */ }
    return { ok: true, unitPath: UNIT_PATH, message: `disabled and removed ${UNIT_PATH}` };
  } catch (e) {
    return { ok: false, unitPath: UNIT_PATH, message: `uninstall failed: ${(e as Error).message}` };
  }
}

function hasSystemctl(): boolean {
  try {
    execSync('command -v systemctl', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
