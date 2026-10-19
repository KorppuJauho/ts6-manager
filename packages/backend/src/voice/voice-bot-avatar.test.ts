import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'net';
import { createHash } from 'crypto';
import { VoiceBot } from './voice-bot.js';
import { parseCommand } from './tslib/commands.js';

// The bot against a scripted TeamSpeak server: commands are answered the way
// a TeamSpeak 6 server answers them, and uploads land on a local TCP port
// standing in for the file transfer port.

const OWN_CLID = 7;
const OWN_HASH = 'abcdefghijklmnopabcdefghijklmnopabcdefghijklmnop';

interface Script {
  /** Error id for ftinitupload; 0 accepts it. */
  uploadError?: number;
  ftPort?: number;
}

function scriptedBot(getAvatar: () => Promise<{ data: Buffer; md5: string } | null>, script: Script = {}) {
  const bot = new VoiceBot({
    id: 1, serverConfigId: 1, name: 'test', serverHost: '127.0.0.1', serverPort: 9987,
    nickname: 'MusicBot', volume: 50, getAvatar,
  });
  const client = (bot as any).client;
  const sent: string[] = [];
  vi.spyOn(client, 'getClientId').mockReturnValue(OWN_CLID);
  const emitReply = (params: Record<string, string>) => {
    client.emit('command', { name: 'error', params });
    if (params.id !== '0') client.emit('ts3error', params);
  };
  vi.spyOn(client, 'sendCommand').mockImplementation((raw: any) => {
    sent.push(raw);
    const cmd = parseCommand(raw);
    const rc = cmd.params.return_code;
    queueMicrotask(() => {
      if (cmd.name === 'ftinitupload') {
        if (script.uploadError) {
          emitReply({ id: String(script.uploadError), msg: 'insufficient client permissions', return_code: rc });
          return;
        }
        client.emit('command', { name: 'notifystartupload', params: { clientftfid: cmd.params.clientftfid, ftkey: 'FTKEY', port: String(script.ftPort) } });
        emitReply({ id: '0', msg: 'ok', return_code: rc });
      } else if (rc) {
        emitReply({ id: '0', msg: 'ok', return_code: rc });
      }
    });
  });
  // Connecting: the server lists the bot itself right after initserver.
  vi.spyOn(client, 'connect').mockImplementation(async () => {
    queueMicrotask(() => client.emit('command', {
      name: 'notifycliententerview',
      params: {},
      groups: [
        { clid: '3', client_nickname: 'someone', client_flag_avatar: 'x' },
        { clid: String(OWN_CLID), client_base64HashClientUID: OWN_HASH, client_flag_avatar: '' },
      ],
    }));
  });
  vi.spyOn(client, 'disconnect').mockImplementation(() => {});
  const commands = () => sent.map((s) => parseCommand(s));
  const statuses: any[] = [];
  bot.on('avatarStatus', (s) => statuses.push(s));
  const settled = () => vi.waitFor(() => {
    expect(statuses.at(-1)?.state).toMatch(/applied|cleared|failed/);
  });
  return { bot, sent, commands, statuses, settled };
}

async function transferPort() {
  let deliver!: (b: Buffer) => void;
  const received = new Promise<Buffer>((r) => { deliver = r; });
  const server = net.createServer((socket) => {
    const parts: Buffer[] = [];
    socket.on('data', (c) => parts.push(c));
    socket.on('end', () => { deliver(Buffer.concat(parts)); socket.end(); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as net.AddressInfo).port, received, close: () => server.close() };
}

const picture = Buffer.from('\x89PNG\r\n\x1a\n picture', 'latin1');
const avatarOf = (data: Buffer) => ({ data, md5: createHash('md5').update(data).digest('hex') });

let closers: Array<() => void> = [];
afterEach(() => { closers.forEach((c) => c()); closers = []; });

describe('VoiceBot avatar', () => {
  it('uploads its avatar on connect and sets client_flag_avatar to its MD5', async () => {
    const ft = await transferPort();
    closers.push(ft.close);
    const avatar = avatarOf(picture);
    const { bot, commands, statuses, settled } = scriptedBot(async () => avatar, { ftPort: ft.port });

    await bot.start();
    await settled();

    expect(statuses.map((s) => s.state)).toEqual(['pending', 'applied']);
    expect(await ft.received).toEqual(Buffer.concat([Buffer.from('FTKEY'), picture]));
    const init = commands().find((c) => c.name === 'ftinitupload')!;
    expect(init.params).toMatchObject({ name: '/avatar', cid: '0', overwrite: '1', size: String(picture.length) });
    const update = commands().find((c) => c.name === 'clientupdate')!;
    expect(update.params.client_flag_avatar).toBe(avatar.md5);
    expect(bot.avatarStatus?.state).toBe('applied');
  });

  it('uploads again on every connect', async () => {
    const ft = await transferPort();
    closers.push(ft.close);
    const { bot, commands, statuses } = scriptedBot(async () => avatarOf(picture), { ftPort: ft.port });
    await bot.start();
    await vi.waitFor(() => expect(statuses.filter((s) => s.state === 'applied')).toHaveLength(1));
    (bot as any)._status = 'stopped';
    await bot.start();
    await vi.waitFor(() => expect(statuses.filter((s) => s.state === 'applied')).toHaveLength(2));
    expect(commands().filter((c) => c.name === 'ftinitupload')).toHaveLength(2);
  });

  it('stays connected when the server refuses the upload, and says why', async () => {
    const { bot, commands, settled } = scriptedBot(async () => avatarOf(picture), { uploadError: 2568 });
    const fatal = vi.fn();
    bot.on('fatalError', fatal);

    await bot.start();
    await settled();

    expect(bot.avatarStatus).toMatchObject({ state: 'failed', reason: 'noPermission' });
    expect(bot.avatarStatus?.detail).toContain('2568');
    expect(bot.status).toBe('connected');
    expect(fatal).not.toHaveBeenCalled();
    // No flag for a file the server does not have.
    expect(commands().some((c) => c.name === 'clientupdate')).toBe(false);
  });

  it('reports an avatar over the server\'s size limit', async () => {
    const { bot, settled } = scriptedBot(async () => avatarOf(picture), { uploadError: 2565 });
    await bot.start();
    await settled();
    expect(bot.avatarStatus).toMatchObject({ state: 'failed', reason: 'tooBig' });
  });

  it('reports a stored avatar that cannot be read', async () => {
    const { bot, settled } = scriptedBot(async () => { throw new Error('ENOENT: bot-1.teamspeak.png'); });
    await bot.start();
    await settled();
    expect(bot.avatarStatus).toMatchObject({ state: 'failed', reason: 'missingFile' });
    expect(bot.status).toBe('connected');
  });

  it('with none, clears the flag on connect and leaves the file alone when there was no avatar', async () => {
    const { bot, commands, settled } = scriptedBot(async () => null);
    await bot.start();
    await settled();
    expect(bot.avatarStatus?.state).toBe('cleared');
    expect(commands().find((c) => c.name === 'clientupdate')?.params.client_flag_avatar).toBe('');
    expect(commands().some((c) => c.name === 'ftdeletefile')).toBe(false);
    expect(commands().some((c) => c.name === 'ftinitupload')).toBe(false);
  });

  it('switching to none clears the flag and deletes the file the server keeps for the bot', async () => {
    const ft = await transferPort();
    closers.push(ft.close);
    let current: { data: Buffer; md5: string } | null = avatarOf(picture);
    const { bot, commands, statuses } = scriptedBot(async () => current, { ftPort: ft.port });
    await bot.start();
    await vi.waitFor(() => expect(statuses.at(-1)?.state).toBe('applied'));

    current = null;
    await bot.refreshAvatar();

    expect(bot.avatarStatus?.state).toBe('cleared');
    const updates = commands().filter((c) => c.name === 'clientupdate');
    expect(updates.at(-1)?.params.client_flag_avatar).toBe('');
    expect(commands().find((c) => c.name === 'ftdeletefile')?.params).toMatchObject({ cid: '0', name: `/avatar_${OWN_HASH}` });
  });

  it('a change while stopped waits for the next connect', async () => {
    const getAvatar = vi.fn(async () => avatarOf(picture));
    const { bot, sent } = scriptedBot(getAvatar);
    await bot.refreshAvatar();
    expect(getAvatar).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(bot.avatarStatus).toBeNull();
  });

  it('makes changes asked for during an upload once, after it', async () => {
    const ft = await transferPort();
    closers.push(ft.close);
    const getAvatar = vi.fn(async () => avatarOf(picture));
    const { bot, commands, statuses } = scriptedBot(getAvatar, { ftPort: ft.port });
    await bot.start();
    await vi.waitFor(() => expect(statuses[0]?.state).toBe('pending'));
    const changes = [bot.refreshAvatar(), bot.refreshAvatar(), bot.refreshAvatar()];
    await Promise.all(changes);
    await vi.waitFor(() => expect(statuses.filter((s) => s.state === 'applied')).toHaveLength(2));
    expect(getAvatar).toHaveBeenCalledTimes(2);
    expect(commands().filter((c) => c.name === 'ftinitupload')).toHaveLength(2);
  });
});
