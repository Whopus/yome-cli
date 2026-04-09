export const WRITE_TOOL_NAME = 'Write';

export function getWriteToolDescription(): string {
  return `Writes a file to the local filesystem.

Usage:
- This tool creates a new file or overwrites an existing file at file_path.
- If you are updating an existing file, you must read it first so you are working from the current contents.
- Existing files are written back using their current encoding and line endings.
- Prefer Edit for targeted changes. Use Write for new files or complete rewrites.
- NEVER create documentation files or README files unless the user explicitly asks for them.
- Only use emojis if the user explicitly requests them.`;
}
