import { describe, expect, it, vi } from 'vitest';
import { isRetryableError, ProviderError, withRetry } from '../../src/util/retry.js';

describe('withRetry', () => {
  it('retries a 429 and succeeds on attempt 3', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ProviderError('rate', { status: 429 }))
      .mockRejectedValueOnce(new ProviderError('rate', { status: 429 }))
      .mockResolvedValueOnce('ok');
    await expect(withRetry(fn, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000]);
  });

  it('stops after the default 4 attempts with 2s, 4s, 8s delays', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const err = new ProviderError('down', { status: 503 });
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(err);
    await expect(withRetry(fn, { sleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000, 8000]);
  });

  it('honours a custom attempts count', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new ProviderError('x', { status: 500 }));
    await expect(withRetry(fn, { attempts: 2, sleep })).rejects.toThrow('x');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-retryable error', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const err = new ProviderError('bad', { status: 400, retryable: false });
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(err);
    await expect(withRetry(fn, { sleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('ProviderError', () => {
  it('derives retryable from status when not given', () => {
    expect(new ProviderError('a', { status: 429 }).retryable).toBe(true);
    expect(new ProviderError('a', { status: 502 }).retryable).toBe(true);
    expect(new ProviderError('a', { status: 400 }).retryable).toBe(false);
    expect(new ProviderError('a').retryable).toBe(false);
  });

  it('keeps status and cause', () => {
    const cause = new Error('inner');
    const e = new ProviderError('a', { status: 500, cause });
    expect(e.status).toBe(500);
    expect(e.cause).toBe(cause);
  });
});

describe('isRetryableError', () => {
  it('is true for 429 and >= 500 statuses', () => {
    expect(isRetryableError(Object.assign(new Error('x'), { status: 429 }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('x'), { status: 500 }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('x'), { status: 400 }))).toBe(false);
  });

  it('is true for retryable: true', () => {
    expect(isRetryableError(new ProviderError('x', { retryable: true }))).toBe(true);
  });

  it('is true for network codes and fetch failed', () => {
    expect(isRetryableError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe(true);
    expect(isRetryableError(new TypeError('fetch failed'))).toBe(true);
  });

  it('is false for ordinary errors and non-errors', () => {
    expect(isRetryableError(new Error('boom'))).toBe(false);
    expect(isRetryableError('nope')).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });
});
