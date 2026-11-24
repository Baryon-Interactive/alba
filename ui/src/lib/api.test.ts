import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiFailure, setWriteRetryDelayMs } from './api';

describe('api idempotency key and retry behavior', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setWriteRetryDelayMs(0);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setWriteRetryDelayMs(250);
    vi.restoreAllMocks();
  });

  it('reuses the same Idempotency-Key across network and 5xx retries, and generates a fresh key per action', async () => {
    const seenKeys: string[] = [];
    let attempt = 0;

    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const key = headers['Idempotency-Key'];
      expect(key).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
      seenKeys.push(key);
      attempt += 1;
      if (attempt === 1) throw new TypeError('network down');
      if (attempt === 2) {
        return new Response(JSON.stringify({ error: { code: 'internal', message: 'server error' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, tag: 'T1', action: 'queue', stage: 'queued' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const firstResult = await api.act('T1', { project: 'demo', action: 'queue' });
    expect(firstResult.stage).toBe('queued');
    expect(seenKeys).toHaveLength(3);
    // All 3 attempts of the first action reused the exact same Idempotency-Key
    expect(seenKeys[0]).toBe(seenKeys[1]);
    expect(seenKeys[1]).toBe(seenKeys[2]);

    // A second distinct action receives a brand new key
    const secondResult = await api.act('T1', { project: 'demo', action: 'cancel' });
    expect(secondResult.stage).toBe('queued');
    expect(seenKeys).toHaveLength(4);
    expect(seenKeys[3]).not.toBe(seenKeys[0]);
  });

  it('does not retry 4xx errors', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { code: 'conflict', message: 'not allowed' } }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await expect(api.say('T1', { project: 'demo', text: 'hello' })).rejects.toBeInstanceOf(ApiFailure);
    expect(calls).toBe(1);
  });
});
