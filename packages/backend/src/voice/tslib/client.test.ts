import { describe, expect, it, vi } from 'vitest';
import { Ts3Client, CONNECTION_REFUSED_ERRORS } from './client.js';

/**
 * Feeds the client one command line as the server sends it and reports what
 * it did. The lines are the replies a TeamSpeak 6 server (6.0.0-beta13.1)
 * actually gave, in the protocol's own escaping.
 */
function receive(line: string) {
  const client = new Ts3Client();
  const disconnect = vi.spyOn(client, 'disconnect').mockImplementation(() => { });
  const errors: string[] = [];
  const replies: Record<string, string>[] = [];
  client.on('error', (e: Error) => errors.push(e.message));
  client.on('ts3error', (p: Record<string, string>) => replies.push(p));
  (client as any).processCommand(Buffer.from(line, 'utf-8'));
  return { disconnected: disconnect.mock.calls.length > 0, errors, replies };
}

describe('Ts3Client error replies', () => {
  it('leaves a command the client may not run to that command (2568)', () => {
    const r = receive('error id=2568 msg=insufficient\\sclient\\spermissions return_code=perm failed_permid=54');

    // 2568 used to be taken for "invalid password": one refused command
    // disconnected the bot.
    expect(r.disconnected).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.replies).toEqual([expect.objectContaining({ id: '2568', return_code: 'perm' })]);
  });

  it.each([
    ['1027', 'server\\smaxclient\\sreached', 'server maxclient reached'],
    ['1028', 'invalid\\sserver\\spassword', 'invalid server password'],
    ['3329', 'connection\\sfailed,\\syou\\sare\\sbanned', 'connection failed, you are banned'],
  ])('ends the connection at once when the server refuses it (%s)', (id, escaped, text) => {
    const r = receive(`error id=${id} msg=${escaped}`);

    // A wrong password and a full server were not recognised before, and
    // waited out the connect timeout — then were retried.
    expect(r.disconnected).toBe(true);
    expect(r.errors).toEqual([`TS3 error ${id}: ${text}`]);
  });

  it('does nothing further for an ordinary "ok"', () => {
    const r = receive('error id=0 msg=ok return_code=x');

    expect(r.disconnected).toBe(false);
    expect(r.errors).toEqual([]);
  });

  it('refuses exactly the three connection-level codes', () => {
    expect([...CONNECTION_REFUSED_ERRORS].sort()).toEqual([1027, 1028, 3329]);
  });
});
