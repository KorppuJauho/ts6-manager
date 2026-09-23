/**
 * Captures the SDP offer a real TeamSpeak client sends when asked to share its
 * stream — a diagnostic, off unless TS6_CAPTURE_STREAM_OFFERS=1.
 *
 * The bot's H.264 reaches the TeamSpeak client, is accepted in the answer, and
 * then gets NullVideoDecoder: libwebrtc's placeholder for "the application's
 * decoder factory returned nothing for the negotiated format". The same client
 * decodes H.264 from other TeamSpeak clients with FFmpeg (h264_cuvid), and
 * rejects Main and High from us outright. So whatever a TeamSpeak client puts
 * in its own H.264 offer is the one thing left to compare against, and asking
 * to watch a stream is how a client is made to produce one.
 *
 * The exchange is the viewer half of TS6's stream signaling, as recovered by
 * webspeak3 from TeamSpeak.dll: `joinstreamrequest id clid msg is_remove` is
 * answered by `notifyrespondjoinstreamrequest` carrying the streamer's offer.
 * The offer is logged and the request withdrawn with `is_remove=1`; it is never
 * answered, so no media flows.
 */

import { buildCommand } from '../tslib/commands.js';

interface ParsedCommand {
  name: string;
  params: Record<string, string>;
}

/** The slice of Ts3Client this needs, so it can be tested without a server. */
export interface CaptureClient {
  on(event: 'command', listener: (parsed: ParsedCommand) => void): unknown;
  removeListener(event: 'command', listener: (parsed: ParsedCommand) => void): unknown;
  sendCommand(cmd: string): void;
  getClientId(): number;
}

/** How long to wait for the streamer's client to answer a join request. */
const RESPONSE_TIMEOUT_MS = 30_000;

/**
 * Removes what an SDP says about where and who, keeping what it says about
 * codecs. The offer carries the streamer's addresses, ICE credentials and DTLS
 * fingerprint; none of that bears on why a decoder is or is not built, and the
 * output is meant to be pasted somewhere.
 */
export function redactSdp(sdp: string): string {
  return sdp
    .split(/\r?\n/)
    .filter((line) => !/^a=(candidate|ice-ufrag|ice-pwd|fingerprint):/.test(line))
    .map((line) => line.replace(/IN IP([46]) \S+/g, 'IN IP$1 <redacted>'))
    .join('\n')
    .trim();
}

export class StreamOfferCapture {
  private client: CaptureClient;
  private log: (msg: string) => void;
  /** Stream id → the timer that gives up on it. */
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private onCommand = (parsed: ParsedCommand) => this.handle(parsed);

  constructor(client: CaptureClient, log: (msg: string) => void = console.log) {
    this.client = client;
    this.log = log;
  }

  /** Call once connected: registration is per connection. */
  start(): void {
    this.client.removeListener('command', this.onCommand);
    this.client.on('command', this.onCommand);
    // Stream notifications only arrive for these registrations — the same
    // ones StreamSignaling makes when the bot streams itself.
    for (const event of ['channel', 'server', 'textchannel']) {
      this.client.sendCommand(buildCommand('servernotifyregister', { event }));
    }
    this.log('[OfferCapture] Enabled: will request the SDP offer of any stream started where this bot can see it');
  }

  stop(): void {
    this.client.removeListener('command', this.onCommand);
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  private handle(parsed: ParsedCommand): void {
    const p = parsed.params ?? {};
    if (parsed.name === 'notifystreamstarted') {
      this.requestOffer(p);
    } else if (parsed.name === 'notifyrespondjoinstreamrequest') {
      this.receiveOffer(p);
    }
  }

  private requestOffer(p: Record<string, string>): void {
    const id = p.id || '';
    const clid = parseInt(p.clid, 10) || 0;
    // Its own stream would only report back the offer this bot built.
    if (!id || !clid || clid === this.client.getClientId() || this.pending.has(id)) return;

    this.log(`[OfferCapture] Stream ${id} started by clid=${clid}; requesting its offer`);
    this.sendJoin(id, clid, false);
    this.pending.set(
      id,
      setTimeout(() => {
        this.pending.delete(id);
        this.log(`[OfferCapture] No answer for stream ${id} within ${RESPONSE_TIMEOUT_MS / 1000}s`);
      }, RESPONSE_TIMEOUT_MS),
    );
  }

  private receiveOffer(p: Record<string, string>): void {
    const id = p.id || p.stream_id || '';
    const timer = this.pending.get(id);
    // A response to a request this did not make belongs to someone else.
    if (timer === undefined) return;
    clearTimeout(timer);
    this.pending.delete(id);

    const clid = parseInt(p.clid, 10) || 0;
    if (p.decision !== '1' || !p.offer) {
      this.log(`[OfferCapture] clid=${clid} declined the request for stream ${id} (decision=${p.decision ?? 'none'})`);
      return;
    }

    this.log(
      `[OfferCapture] Offer from clid=${clid} for stream ${id} ` +
        `(addresses, ICE credentials and fingerprint removed):\n` +
        `${redactSdp(p.offer)}\n[OfferCapture] End of offer`,
    );
    // Withdraw rather than leave the streamer's client holding a viewer that
    // will never answer.
    if (clid) this.sendJoin(id, clid, true);
  }

  private sendJoin(id: string, clid: number, remove: boolean): void {
    // Parameter names and order as webspeak3 recovered them; msg is sent even
    // when empty so the command has the native client's shape.
    this.client.sendCommand(
      buildCommand('joinstreamrequest', { id, clid, msg: '', is_remove: remove }),
    );
  }
}
