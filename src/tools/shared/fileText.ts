import { createReadStream } from 'fs';
import { open, readFile, stat, writeFile } from 'fs/promises';
import { StringDecoder } from 'string_decoder';

export type LineEndingType = 'CRLF' | 'LF';

export interface TextFileMetadata {
  content: string;
  encoding: BufferEncoding;
  lineEndings: LineEndingType;
  hasBom: boolean;
  mtimeMs: number;
}

export interface ReadFileRangeResult {
  content: string;
  lineCount: number;
  totalLines: number;
  mtimeMs: number;
}

const FAST_PATH_MAX_SIZE = 10 * 1024 * 1024;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);

export function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n');
}

export function detectLineEndingsForString(content: string): LineEndingType {
  let crlfCount = 0;
  let lfCount = 0;

  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      if (i > 0 && content[i - 1] === '\r') {
        crlfCount++;
      } else {
        lfCount++;
      }
    }
  }

  return crlfCount > lfCount ? 'CRLF' : 'LF';
}

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

export function normalizeQuotes(str: string): string {
  return str
    .replaceAll('‘', "'")
    .replaceAll('’', "'")
    .replaceAll('“', '"')
    .replaceAll('”', '"');
}

export function findActualString(fileContent: string, searchString: string): string | null {
  if (fileContent.includes(searchString)) {
    return searchString;
  }

  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);
  const searchIndex = normalizedFile.indexOf(normalizedSearch);

  if (searchIndex === -1) {
    return null;
  }

  return fileContent.substring(searchIndex, searchIndex + searchString.length);
}

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) {
    return true;
  }

  const prev = chars[index - 1];
  return prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' || prev === '(' || prev === '[' || prev === '{' || prev === '—' || prev === '–';
}

function applyCurlyDoubleQuotes(str: string): string {
  const chars = [...str];
  const result: string[] = [];

  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      result.push(isOpeningContext(chars, i) ? '“' : '”');
    } else {
      result.push(chars[i]!);
    }
  }

  return result.join('');
}

function applyCurlySingleQuotes(str: string): string {
  const chars = [...str];
  const result: string[] = [];

  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      const prev = i > 0 ? chars[i - 1] : undefined;
      const next = i < chars.length - 1 ? chars[i + 1] : undefined;
      const prevIsLetter = prev !== undefined && /\p{L}/u.test(prev);
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next);

      if (prevIsLetter && nextIsLetter) {
        result.push('’');
      } else {
        result.push(isOpeningContext(chars, i) ? '‘' : '’');
      }
    } else {
      result.push(chars[i]!);
    }
  }

  return result.join('');
}

export function preserveQuoteStyle(oldString: string, actualOldString: string, newString: string): string {
  if (oldString === actualOldString) {
    return newString;
  }

  const hasDoubleQuotes = actualOldString.includes('“') || actualOldString.includes('”');
  const hasSingleQuotes = actualOldString.includes('‘') || actualOldString.includes('’');

  let result = newString;
  if (hasDoubleQuotes) {
    result = applyCurlyDoubleQuotes(result);
  }
  if (hasSingleQuotes) {
    result = applyCurlySingleQuotes(result);
  }

  return result;
}

export function applyEditToContent(
  originalContent: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false,
): string {
  const replace = replaceAll
    ? (content: string, search: string, next: string) => content.replaceAll(search, () => next)
    : (content: string, search: string, next: string) => content.replace(search, () => next);

  if (newString !== '') {
    return replace(originalContent, oldString, newString);
  }

  const stripTrailingNewline = !oldString.endsWith('\n') && originalContent.includes(`${oldString}\n`);
  return stripTrailingNewline
    ? replace(originalContent, `${oldString}\n`, newString)
    : replace(originalContent, oldString, newString);
}

export async function getFileTimestamp(filePath: string): Promise<number> {
  const stats = await stat(filePath);
  return stats.mtimeMs;
}

function detectEncoding(buffer: Buffer): BufferEncoding {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return 'utf16le';
  }
  return 'utf8';
}

async function detectFileEncoding(filePath: string): Promise<BufferEncoding> {
  const file = await open(filePath, 'r');
  try {
    const sample = Buffer.alloc(4);
    const { bytesRead } = await file.read(sample, 0, sample.length, 0);
    return detectEncoding(sample.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

function hasBomForEncoding(buffer: Buffer, encoding: BufferEncoding): boolean {
  if (encoding === 'utf16le') {
    return buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
  }
  return buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}

export async function readTextFileWithMetadata(filePath: string): Promise<TextFileMetadata> {
  const [buffer, fileStat] = await Promise.all([readFile(filePath), stat(filePath)]);
  const encoding = detectEncoding(buffer);
  const raw = stripBom(buffer.toString(encoding));

  return {
    content: normalizeLineEndings(raw),
    encoding,
    lineEndings: detectLineEndingsForString(raw.slice(0, 4096)),
    hasBom: hasBomForEncoding(buffer, encoding),
    mtimeMs: fileStat.mtimeMs,
  };
}

export async function writeTextFile(
  filePath: string,
  content: string,
  options: { encoding: BufferEncoding; lineEndings: LineEndingType; hasBom?: boolean },
): Promise<void> {
  let nextContent = content;
  if (options.lineEndings === 'CRLF') {
    nextContent = normalizeLineEndings(content).split('\n').join('\r\n');
  } else {
    nextContent = normalizeLineEndings(content);
  }

  const bom = options.hasBom ? (options.encoding === 'utf16le' ? UTF16LE_BOM : UTF8_BOM) : Buffer.alloc(0);
  const body = Buffer.from(nextContent, options.encoding);
  await writeFile(filePath, Buffer.concat([bom, body]));
}

async function readFileInRangeFast(
  filePath: string,
  mtimeMs: number,
  offset: number,
  maxLines?: number,
): Promise<ReadFileRangeResult> {
  const { content } = await readTextFileWithMetadata(filePath);
  const lines = content.split('\n');
  const selected = maxLines === undefined ? lines.slice(offset) : lines.slice(offset, offset + maxLines);

  return {
    content: selected.join('\n'),
    lineCount: selected.length,
    totalLines: lines.length,
    mtimeMs,
  };
}

async function readFileInRangeStreaming(
  filePath: string,
  mtimeMs: number,
  offset: number,
  maxLines?: number,
): Promise<ReadFileRangeResult> {
  const encoding = await detectFileEncoding(filePath);
  const stream = createReadStream(filePath);
  const decoder = new StringDecoder(encoding);
  const selected: string[] = [];
  let totalLines = 0;
  let firstLine = true;
  const endLine = maxLines === undefined ? Infinity : offset + maxLines;
  let partial = '';

  const pushLine = (rawLine: string): void => {
    let line = rawLine;
    if (firstLine) {
      firstLine = false;
      line = stripBom(line);
    }

    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }

    if (totalLines >= offset && totalLines < endLine) {
      selected.push(line);
    }

    totalLines++;
  };

  try {
    for await (const chunk of stream) {
      const data = partial + decoder.write(chunk as Buffer);
      let start = 0;

      for (let i = 0; i < data.length; i++) {
        if (data[i] === '\n') {
          pushLine(data.slice(start, i));
          start = i + 1;
        }
      }

      partial = data.slice(start);
    }

    const finalChunk = partial + decoder.end();
    pushLine(finalChunk);
  } finally {
    stream.destroy();
  }

  return {
    content: selected.join('\n'),
    lineCount: selected.length,
    totalLines,
    mtimeMs,
  };
}

export async function readFileInRange(
  filePath: string,
  offset: number = 0,
  maxLines?: number,
): Promise<ReadFileRangeResult> {
  const fileStat = await stat(filePath);

  if (fileStat.isDirectory()) {
    throw new Error(`EISDIR: illegal operation on a directory, read '${filePath}'`);
  }

  if (!fileStat.isFile()) {
    throw new Error(`Unsupported file type: ${filePath}`);
  }

  const mtimeMs = fileStat.mtimeMs;
  if (fileStat.size < FAST_PATH_MAX_SIZE) {
    return readFileInRangeFast(filePath, mtimeMs, offset, maxLines);
  }

  return readFileInRangeStreaming(filePath, mtimeMs, offset, maxLines);
}
