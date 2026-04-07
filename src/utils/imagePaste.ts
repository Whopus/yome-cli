import { execSync } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export interface PastedImage {
  base64: string;
  mediaType: string;
}

const SCREENSHOT_PATH = join(tmpdir(), 'yome_clipboard_image.png');

/**
 * Check if clipboard contains an image (macOS only).
 */
export function hasImageInClipboard(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execSync("osascript -e 'the clipboard as «class PNGf»'", { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract image from clipboard and return as base64 (macOS only).
 */
export function getImageFromClipboard(): PastedImage | null {
  if (process.platform !== 'darwin') return null;
  try {
    execSync(
      `osascript -e 'set png_data to (the clipboard as «class PNGf»)' -e 'set fp to open for access POSIX file "${SCREENSHOT_PATH}" with write permission' -e 'write png_data to fp' -e 'close access fp'`,
      { stdio: 'pipe' },
    );
    const buffer = readFileSync(SCREENSHOT_PATH);
    try { unlinkSync(SCREENSHOT_PATH); } catch {}
    if (buffer.length === 0) return null;

    const base64 = buffer.toString('base64');
    const mediaType = detectMediaType(buffer);
    return { base64, mediaType };
  } catch {
    return null;
  }
}

function detectMediaType(buffer: Buffer): string {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'image/webp';
  return 'image/png';
}
