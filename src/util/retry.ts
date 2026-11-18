export class ProviderError extends Error {
  status?: number;
  retryable: boolean;

  constructor(message: string, opts: { status?: number; retryable?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ProviderError';
    this.status = opts.status;
    this.retryable = opts.retryable ?? (opts.status !== undefined && isRetryableStatus(opts.status));
  }
}

export interface RetryOptions {
  /** Total tries including the first. Default 4. */
  attempts?: number;
  /** Injectable for tests. Default: real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const BASE_DELAY_MS = 2000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function isRetryableError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  if ((e as { retryable?: unknown }).retryable === true) return true;
  const { status, code, message } = e as { status?: unknown; code?: unknown; message?: unknown };
  if (typeof status === 'number' && isRetryableStatus(status)) return true;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT') return true;
  return typeof message === 'string' && message.includes('fetch failed');
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retries fn on retryable errors with exponential backoff (2s, 4s, 8s, ...). */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const sleep = opts.sleep ?? realSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= attempts || !isRetryableError(e)) throw e;
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}
