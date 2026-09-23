import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamOfferCapture, redactSdp, type CaptureClient } from './offer-capture.js';

const OWN_CLID = 7;

// An offer shaped like libwebrtc's, with the parts that must not leak.
const OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 192.168.1.90',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'm=video 9 UDP/TLS/RTP/SAVPF 102 45',
  'c=IN IP4 84.251.200.91',
  'a=ice-ufrag:abcd',
  'a=ice-pwd:0123456789abcdefghijklmn',
  'a=fingerprint:sha-256 AB:CD:EF',
  'a=candidate:1 1 udp 2130706431 192.168.1.90 50000 typ host',
  'a=candidate:2 1 udp 1694498815 2001:db8::1 50001 typ srflx',
  'a=rtpmap:102 H264/90000',
  'a=rtcp-fb:102 nack pli',
  'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  'a=rtpmap:45 AV1/90000',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP6 2001:db8::1',
  'a=rtpmap:111 opus/48000/2',
].join('\r\n');

class FakeClient extends EventEmitter implements CaptureClient {
  sent: string[] = [];
  sendCommand(cmd: string): void {
    this.sent.push(cmd);
  }
  getClientId(): number {
    return OWN_CLID;
  }
  command(name: string, params: Record<string, string>): void {
    this.emit('command', { name, params });
  }
}

describe('redactSdp', () => {
  it('keeps what describes the codecs', () => {
    const out = redactSdp(OFFER);
    expect(out).toContain('m=video 9 UDP/TLS/RTP/SAVPF 102 45');
    expect(out).toContain('a=rtpmap:102 H264/90000');
    expect(out).toContain('a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f');
    expect(out).toContain('a=rtcp-fb:102 nack pli');
    expect(out).toContain('a=rtpmap:45 AV1/90000');
  });

  // The log is meant to be pasted into a chat or an issue.
  it('removes addresses, ICE credentials and the fingerprint', () => {
    const out = redactSdp(OFFER);
    for (const leak of ['84.251.200.91', '192.168.1.90', '2001:db8::1', 'abcd', '0123456789abcdefghijklmn', 'AB:CD:EF']) {
      expect(out).not.toContain(leak);
    }
    expect(out).not.toMatch(/^a=candidate/m);
    expect(out).toContain('c=IN IP4 <redacted>');
    expect(out).toContain('c=IN IP6 <redacted>');
  });
});

describe('StreamOfferCapture', () => {
  let client: FakeClient;
  let logs: string[];
  let capture: StreamOfferCapture;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new FakeClient();
    logs = [];
    capture = new StreamOfferCapture(client, (m) => logs.push(m));
    capture.start();
    client.sent = [];
  });

  afterEach(() => {
    capture.stop();
    vi.useRealTimers();
  });

  it('asks to watch a stream another client starts, in the native command shape', () => {
    client.command('notifystreamstarted', { id: 'abc-123', clid: '95' });
    expect(client.sent).toEqual(['joinstreamrequest id=abc-123 clid=95 msg= is_remove=0']);
  });

  it('ignores its own stream', () => {
    client.command('notifystreamstarted', { id: 'own', clid: String(OWN_CLID) });
    expect(client.sent).toEqual([]);
  });

  it('logs the redacted offer and withdraws the request', () => {
    client.command('notifystreamstarted', { id: 'abc-123', clid: '95' });
    client.sent = [];
    client.command('notifyrespondjoinstreamrequest', { id: 'abc-123', clid: '95', decision: '1', offer: OFFER });

    const logged = logs.join('\n');
    expect(logged).toContain('profile-level-id=42e01f');
    expect(logged).not.toContain('84.251.200.91');
    expect(client.sent).toEqual(['joinstreamrequest id=abc-123 clid=95 msg= is_remove=1']);
  });

  // StreamSignaling sees the same commands; a response to someone else's
  // request is not this tool's to log or withdraw.
  it('ignores responses it did not ask for', () => {
    client.command('notifyrespondjoinstreamrequest', { id: 'other', clid: '95', decision: '1', offer: OFFER });
    expect(logs.join('\n')).not.toContain('H264');
    expect(client.sent).toEqual([]);
  });

  it('reports a declined request without withdrawing it', () => {
    client.command('notifystreamstarted', { id: 'abc-123', clid: '95' });
    client.sent = [];
    client.command('notifyrespondjoinstreamrequest', { id: 'abc-123', clid: '95', decision: '0' });
    expect(logs.join('\n')).toContain('declined');
    expect(client.sent).toEqual([]);
  });

  it('gives up on a stream that never answers', () => {
    client.command('notifystreamstarted', { id: 'abc-123', clid: '95' });
    vi.advanceTimersByTime(30_000);
    expect(logs.join('\n')).toContain('No answer for stream abc-123');
    // A late answer is then treated as unrequested.
    client.command('notifyrespondjoinstreamrequest', { id: 'abc-123', clid: '95', decision: '1', offer: OFFER });
    expect(logs.join('\n')).not.toContain('End of offer');
  });

  it('asks once per stream', () => {
    client.command('notifystreamstarted', { id: 'abc-123', clid: '95' });
    client.command('notifystreamstarted', { id: 'abc-123', clid: '95' });
    expect(client.sent).toHaveLength(1);
  });

  it('stops listening when stopped', () => {
    capture.stop();
    client.command('notifystreamstarted', { id: 'abc-123', clid: '95' });
    expect(client.sent).toEqual([]);
  });

  // start() runs on every connection; it must not stack listeners.
  it('does not double up across restarts', () => {
    capture.start();
    client.sent = [];
    client.command('notifystreamstarted', { id: 'abc-123', clid: '95' });
    expect(client.sent).toHaveLength(1);
  });
});
