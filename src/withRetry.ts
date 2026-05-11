// withRetry.ts — exponential-backoff retry for LLM/API calls.
// Mirrors Server/agent/withRetry.ts. Kept in-tree so the CLI stays a
// self-contained npm package with no cross-repo imports.

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;
const DEFAULT_MAX_RETRIES = 4;

export interface RetryNotice {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  error: string;
}

export interface RetryOptions {
  maxRetries?: number;
  signal?: AbortSignal;
  onRetryNotice?: (n: RetryNotice) => void;
  label?: string;
}

function extractStatus(msg: string): number | null {
  const m = msg.match(/API error (\d+)/);
  if (!m) return null;
  const s = parseInt(m[1]!, 10);
  return Number.isFinite(s) ? s : null;
}

function extractRetryAfterMs(msg: string): number | null {
  const m = msg.match(/retry[-\s]?after[:\s]+(\d+)/i);
  if (!m) return null;
  const sec = parseInt(m[1]!, 10);
  return Number.isFinite(sec) ? sec * 1000 : null;
}

export function isRetryableError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error && err.name === 'AbortError') return false;

  const msg = err instanceof Error ? err.message : String(err);

  if (err instanceof Error && err.name === 'StreamIdleTimeoutError') return true;
  if (/Stream idle timeout/i.test(msg)) return true;

  const status = extractStatus(msg);
  if (status !== null) {
    if (status === 408 || status === 409 || status === 429) return true;
    if (status >= 500) return true;
    return false;
  }

  if (
    /ECONNRESET|EPIPE|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(msg) ||
    /socket hang up|socket disconnected|network[_ ]?error|fetch failed|terminated/i.test(msg) ||
    /other side closed|premature close/i.test(msg)
  ) {
    return true;
  }

  return false;
}

function getDelayMs(attempt: number, msg: string): number {
  const retryAfter = extractRetryAfterMs(msg);
  if (retryAfter !== null) return Math.min(retryAfter, MAX_DELAY_MS);
  const base = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  const jitter = Math.random() * 0.25 * base;
  return Math.round(base + jitter);
}

function isAborted(signal?: AbortSignal): boolean {
  return !!signal?.aborted;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isAborted(signal)) { reject(new Error('aborted')); return; }
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const max = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const label = opts.label ?? 'llm';
  let last: unknown;

  for (let attempt = 1; attempt <= max + 1; attempt++) {
    if (isAborted(opts.signal)) throw new Error('aborted');
    try {
      return await operation(attempt);
    } catch (err) {
      last = err;
      const msg = err instanceof Error ? err.message : String(err);

      if (isAborted(opts.signal)) throw err;
      if (attempt > max || !isRetryableError(err)) throw err;

      const delayMs = getDelayMs(attempt, msg);
      console.warn(
        `[withRetry:${label}] attempt ${attempt}/${max + 1} failed: ${msg} — retrying in ${delayMs}ms`,
      );
      opts.onRetryNotice?.({ attempt, maxRetries: max, delayMs, error: msg });

      try {
        await sleep(delayMs, opts.signal);
      } catch {
        throw err;
      }
    }
  }

  throw last;
}
