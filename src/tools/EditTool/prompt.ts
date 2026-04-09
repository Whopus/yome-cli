export const EDIT_TOOL_NAME = 'Edit';

export function getEditToolDescription(): string {
  return `Performs exact string replacements in files.

Usage:
- Read the file first. Existing files must be fully read before they can be edited.
- Preserve the exact indentation from the file when constructing old_string and new_string.
- The tool can match curly quotes from the file even if you provide straight quotes.
- Prefer editing existing files instead of rewriting them with Write.
- The edit fails if old_string is not unique, unless you set replace_all=true.
- Use replace_all for repeated string replacements across the file.
- Use Write instead when you need to create a new file or replace a file wholesale.`;
}
