import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import {
  RELAY_TTL_MS, createRelayRoutes, lookupRelay, parseRelayInfo, registerRelay, relayArgs, relayBaseUrl,
} from './yt-relay.js';
import { SOURCE_SEPARATOR } from './types.js';

const PAGE = 'https://www.youtube.com/watch?v=abc';

function tokenOf(url: string): string {
  return url.split('/internal/relay/')[1].split('/')[0];
}

const info = (o: object) => JSON.stringify(o);

describe('parseRelayInfo', () => {
  it('reads codec, both formats of a DASH pair and the height', () => {
    const r = parseRelayInfo(info({ vcodec: 'vp9', format_id: '303+251', height: 1080 }) + '\n');
    expect(r).toMatchObject({ vcodec: 'vp9', formatIds: ['303', '251'], height: 1080 });
  });

  it('reads a progressive format', () => {
    expect(parseRelayInfo(info({ vcodec: 'avc1.42001E', format_id: '18', height: 360 })))
      .toMatchObject({ vcodec: 'avc1.42001E', formatIds: ['18'], height: 360 });
  });

  it('keeps format ids that contain dashes', () => {
    expect(parseRelayInfo(info({ vcodec: 'avc1', format_id: 'hls-1080p60', height: 1080 })).formatIds).toEqual(['hls-1080p60']);
  });

  it('reports no height when yt-dlp has none', () => {
    expect(parseRelayInfo(info({ vcodec: 'vp9', format_id: '303+251', height: null })).height).toBeNull();
  });

  it('returns the JSON line for --load-info-json, ignoring stray lines', () => {
    const line = info({ vcodec: 'vp9', format_id: '248+251', height: 1080, id: 'abc' });
    const r = parseRelayInfo('[info] something\n' + line);
    expect(r.formatIds).toEqual(['248', '251']);
    expect(r.infoJson).toBe(line);
  });

  it('refuses output with no JSON', () => {
    expect(() => parseRelayInfo('')).toThrow();
  });
});

describe('relay registry', () => {
  it('gives one URL per format, joined like a DASH pair', () => {
    const { source, release } = registerRelay(PAGE, ['303', '251']);
    const parts = source.split(SOURCE_SEPARATOR);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/\/internal\/relay\/[A-Za-z0-9_-]{32}\/0$/);
    expect(parts[1]).toMatch(/\/1$/);
    expect(lookupRelay(tokenOf(parts[0]), 1)).toEqual({ pageUrl: PAGE, formatId: '251', infoPath: null });
    release();
  });

  it('forgets a source once released', () => {
    const { source, release } = registerRelay(PAGE, ['18']);
    release();
    expect(lookupRelay(tokenOf(source), 0)).toBeNull();
  });

  it('expires a source that was never released', () => {
    const now = 1_000_000;
    const { source } = registerRelay(PAGE, ['18'], null, now);
    expect(lookupRelay(tokenOf(source), 0, now + RELAY_TTL_MS - 1)).not.toBeNull();
    expect(lookupRelay(tokenOf(source), 0, now + RELAY_TTL_MS)).toBeNull();
  });

  it('refuses an index past the formats and an unknown token', () => {
    const { source, release } = registerRelay(PAGE, ['18']);
    expect(lookupRelay(tokenOf(source), 1)).toBeNull();
    expect(lookupRelay('not-a-token', 0)).toBeNull();
    release();
  });

  it('issues a different token every time', () => {
    const a = registerRelay(PAGE, ['18']);
    const b = registerRelay(PAGE, ['18']);
    expect(tokenOf(a.source)).not.toBe(tokenOf(b.source));
    a.release(); b.release();
  });

  it('refuses a source with no format', () => {
    expect(() => registerRelay(PAGE, [])).toThrow();
  });

  it('keeps the info JSON in a private file until released', () => {
    const { source, release } = registerRelay(PAGE, ['18'], '{"id":"abc"}');
    const found = lookupRelay(tokenOf(source), 0)!;
    expect(fs.readFileSync(found.infoPath!, 'utf8')).toBe('{"id":"abc"}');
    if (process.platform !== 'win32') expect(fs.statSync(found.infoPath!).mode & 0o777).toBe(0o600);
    release();
    return vi.waitFor(() => expect(fs.existsSync(found.infoPath!)).toBe(false));
  });

  it('deletes the info JSON of an expired source', () => {
    const now = 2_000_000;
    const { source } = registerRelay(PAGE, ['18'], '{"id":"abc"}', now);
    const { infoPath } = lookupRelay(tokenOf(source), 0, now)!;
    expect(lookupRelay(tokenOf(source), 0, now + RELAY_TTL_MS)).toBeNull();
    return vi.waitFor(() => expect(fs.existsSync(infoPath!)).toBe(false));
  });
});

describe('relayBaseUrl', () => {
  afterEach(() => {
    delete process.env.BACKEND_INTERNAL_URL;
    delete process.env.SIDECAR_URL;
  });

  it('uses the compose service name when the sidecar is its own container', () => {
    process.env.SIDECAR_URL = 'http://ts6-sidecar:9800';
    expect(relayBaseUrl()).toBe('http://backend:3001');
  });

  it('uses the loopback address when the sidecar is spawned locally', () => {
    expect(relayBaseUrl()).toBe('http://127.0.0.1:3001');
  });

  it('takes BACKEND_INTERNAL_URL over both, without a trailing slash', () => {
    process.env.SIDECAR_URL = 'http://ts6-sidecar:9800';
    process.env.BACKEND_INTERNAL_URL = 'http://ts6-backend:3001/';
    expect(relayBaseUrl()).toBe('http://ts6-backend:3001');
  });
});

describe('relayArgs', () => {
  it('writes one format to stdout and keeps the page URL after --', () => {
    const args = relayArgs(PAGE, '251');
    expect(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2)).toEqual(['-f', '251']);
    expect(args.slice(args.indexOf('-o'), args.indexOf('-o') + 2)).toEqual(['-o', '-']);
    expect(args.slice(-2)).toEqual(['--', PAGE]);
  });

  it('loads the saved info JSON instead of extracting the page again', () => {
    const { source, release } = registerRelay(PAGE, ['251'], '{"id":"abc"}');
    const { infoPath } = lookupRelay(tokenOf(source), 0)!;
    const args = relayArgs(PAGE, '251', infoPath);
    expect(args.slice(-2)).toEqual(['--load-info-json', infoPath]);
    expect(args).not.toContain(PAGE);
    release();
  });

  it('extracts the page when the info file is gone', () => {
    expect(relayArgs(PAGE, '251', '/nonexistent/info.json').slice(-2)).toEqual(['--', PAGE]);
  });
});

/** A child process stand-in whose stdout the test writes to. */
function fakeProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = vi.fn(() => {
    proc.signalCode = 'SIGKILL';
    proc.stdout.end();
    setImmediate(() => proc.emit('close', null));
    return true;
  });
  return proc;
}

describe('GET /internal/relay/:token/:index', () => {
  let server: Server;
  let baseUrl: string;
  let proc: ReturnType<typeof fakeProcess>;
  const spawnFn = vi.fn((_cmd: string, _args: string[]) => {
    proc = fakeProcess();
    return proc;
  });

  beforeAll(async () => {
    const app = express();
    app.use('/internal/relay', createRelayRoutes(spawnFn));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => spawnFn.mockClear());

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function relayPath(source: string, index = 0): string {
    return `${baseUrl}/internal/relay/${tokenOf(source.split(SOURCE_SEPARATOR)[index])}/${index}`;
  }

  it('answers 404 for an unknown token without starting yt-dlp', async () => {
    const res = await fetch(`${baseUrl}/internal/relay/nope/0`);
    expect(res.status).toBe(404);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('streams what yt-dlp writes for the requested format', async () => {
    const { source, release } = registerRelay(PAGE, ['303', '251']);
    const pending = fetch(relayPath(source, 1));
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledOnce());
    const [cmd, args] = spawnFn.mock.calls[0];
    expect(cmd).toBe('yt-dlp');
    expect(args).toEqual(relayArgs(PAGE, '251'));

    proc.stdout.write(Buffer.from('media bytes'));
    proc.stdout.end();
    proc.exitCode = 0;
    proc.emit('close', 0);

    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('media bytes');
    release();
  });

  it('kills yt-dlp when the sidecar hangs up', async () => {
    const { source, release } = registerRelay(PAGE, ['18']);
    const ctl = new AbortController();
    const pending = fetch(relayPath(source), { signal: ctl.signal });
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledOnce());
    proc.stdout.write(Buffer.from('first chunk'));
    const res = await pending;
    const reader = res.body!.getReader();
    await reader.read();
    ctl.abort();
    await vi.waitFor(() => expect(proc.kill).toHaveBeenCalledWith('SIGKILL'));
    release();
  });

  it('serves a released source no more', async () => {
    const { source, release } = registerRelay(PAGE, ['18']);
    release();
    expect((await fetch(relayPath(source))).status).toBe(404);
  });
});
