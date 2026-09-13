import { describe, it, expect, vi } from 'vitest';
import { WebQueryClient } from './webquery-client.js';

function staleSocketError(message: string, code?: string) {
  const err: any = new Error(message);
  if (code) err.code = code;
  return err;
}

function okResponse(body: any = { ok: 1 }) {
  return { data: { status: { code: 0, message: 'ok' }, body } };
}

// Pin the mocked transport in place: resetTransport would otherwise replace
// this.http with a real axios instance mid-test.
function pinTransport(client: WebQueryClient, impl: any) {
  (client as any).http = impl;
  return vi.spyOn(client as any, 'resetTransport').mockImplementation(() => {});
}

describe('WebQueryClient stale keep-alive retry', () => {
  it('resets the transport and retries once when the socket was closed server-side', async () => {
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const get = vi.fn()
      .mockRejectedValueOnce(staleSocketError('socket hang up', 'ECONNRESET'))
      .mockResolvedValueOnce(okResponse());
    const reset = pinTransport(client, { get });

    const result = await client.execute(1, 'serverinfo');
    expect(result).toEqual({ ok: 1 });
    expect(get).toHaveBeenCalledTimes(2);
    // The corrupted agent must be rebuilt, not reused: a rotten transport
    // previously failed every request until the server entry was re-added
    expect(reset).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it('does not retry more than once', async () => {
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const get = vi.fn().mockRejectedValue(staleSocketError('socket hang up', 'ECONNRESET'));
    pinTransport(client, { get });

    await expect(client.execute(1, 'serverinfo')).rejects.toThrow(/socket hang up/);
    expect(get).toHaveBeenCalledTimes(2);
    client.destroy();
  });

  it('does not retry TS API errors (HTTP response received)', async () => {
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const get = vi.fn().mockResolvedValue({ data: { status: { code: 1538, message: 'invalid parameter' } } });
    const reset = pinTransport(client, { get });

    await expect(client.execute(1, 'serverinfo')).rejects.toThrow(/invalid parameter/);
    expect(get).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    client.destroy();
  });

  it('does not retry non-socket network errors', async () => {
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const get = vi.fn().mockRejectedValue(staleSocketError('timeout of 15000ms exceeded', 'ECONNABORTED'));
    const reset = pinTransport(client, { get });

    await expect(client.execute(1, 'serverinfo')).rejects.toThrow(/timeout/);
    expect(get).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    client.destroy();
  });

  it('retries POST requests the same way', async () => {
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const post = vi.fn()
      .mockRejectedValueOnce(staleSocketError('read ECONNRESET', 'ECONNRESET'))
      .mockResolvedValueOnce(okResponse());
    const reset = pinTransport(client, { post });

    const result = await client.executePost(1, 'clientaddperm', { foo: 'bar' });
    expect(result).toEqual({ ok: 1 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it('opens the circuit: no reset churn within the cooldown window', async () => {
    // When the TS server flood-protects us (error 524 / connection resets),
    // every reconnection feeds its flood counter — one reset per window max.
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const get = vi.fn().mockRejectedValue(staleSocketError('socket hang up', 'ECONNRESET'));
    const reset = pinTransport(client, { get });

    await expect(client.execute(1, 'serverinfo')).rejects.toThrow(); // reset + retry
    await expect(client.execute(1, 'serverinfo')).rejects.toThrow(); // fail fast, no churn
    expect(get).toHaveBeenCalledTimes(3);
    expect(reset).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it('resetTransport really replaces the agent and axios instance', () => {
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const agentBefore = (client as any).agent;
    const httpBefore = (client as any).http;

    (client as any).resetTransport();

    expect((client as any).agent).not.toBe(agentBefore);
    expect((client as any).http).not.toBe(httpBefore);
    client.destroy();
  });
});
