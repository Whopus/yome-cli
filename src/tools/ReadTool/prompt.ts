export const READ_TOOL_NAME = 'Read';
export const MAX_LINES_TO_READ = 2000;

export function getReadToolDescription(): string {
  return `Reads a file from the local filesystem.

Usage:
- The file_path parameter must be an absolute path to the file to read.
- By default, it reads up to ${MAX_LINES_TO_READ} lines starting from the beginning of the file.
- You can optionally provide offset and limit when you only need part of a large file.
- Results are returned with 1-based line numbers.
- This tool only reads files. To inspect directories, use LS.
- Use this tool before editing or overwriting an existing file so you work from the current contents.
- Read the whole file first when you plan to edit or overwrite it later.`;
}
