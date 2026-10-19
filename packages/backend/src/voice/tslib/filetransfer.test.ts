import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import net from 'net';
import { parseCommand } from './commands.js';
import { deleteFile, FileTransferError, sendConfirmed, uploadFile } from './filetransfer.js';

/** A TCP file transfer port that records what each connection sent. */
async function transferPort(): Promise<{ port: number; received: Promise<Buffer>; close: () => void }> {
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

/** A client whose server answers each command with `answer`. */
function fakeClient(answer: (cmd: ReturnType<typeof parseCommand>, client: EventEmitter) => void) {
  const sent: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    sendCommand(cmd: string) {
      sent.push(cmd);
      queueMicrotask(() => answer(parseCommand(cmd), client));
    },
  });
  return { client, sent };
}

const ok = (c: ReturnType<typeof parseCommand>) => ({ name: 'error', params: { id: '0', msg: 'ok', return_code: c.params.return_code } });

let closers: Array<() => void> = [];
afterEach(() => { closers.forEach((c) => c()); closers = []; });

describe('uploadFile', () => {
  it('asks for the upload, then sends the key and the file to the port the server names', async () => {
    const ft = await transferPort();
    closers.push(ft.close);
    const { client, sent } = fakeClient((c, cl) => {
      if (c.name !== 'ftinitupload') return;
      cl.emit('command', { name: 'notifystartupload', params: { clientftfid: c.params.clientftfid, serverftfid: '9', ftkey: 'KEY123', port: String(ft.port), seekpos: '0' } });
      cl.emit('command', ok(c));
    });
    const data = Buffer.from('picture bytes');

    await uploadFile(client, '127.0.0.1', 0, '/avatar', data);

    const init = parseCommand(sent[0]);
    expect(init.name).toBe('ftinitupload');
    expect(init.params).toMatchObject({ name: '/avatar', cid: '0', cpw: '', size: String(data.length), overwrite: '1', resume: '0' });
    expect(await ft.received).toEqual(Buffer.concat([Buffer.from('KEY123'), data]));
  });

  it('rejects with the server\'s error id when it refuses the upload', async () => {
    const { client } = fakeClient((c, cl) => {
      cl.emit('command', { name: 'error', params: { id: '2568', msg: 'insufficient client permissions', failed_permid: '170', return_code: c.params.return_code } });
    });
    const err = await uploadFile(client, '127.0.0.1', 0, '/avatar', Buffer.from('x')).catch((e) => e);
    expect(err).toBeInstanceOf(FileTransferError);
    expect(err.code).toBe(2568);
    expect(err.message).toBe('insufficient client permissions');
  });

  it('rejects when the transfer is refused after it started', async () => {
    const { client } = fakeClient((c, cl) => {
      cl.emit('command', { name: 'notifystatusfiletransfer', params: { clientftfid: c.params.clientftfid, status: '2565', msg: 'invalid size' } });
    });
    await expect(uploadFile(client, '127.0.0.1', 0, '/avatar', Buffer.from('x'))).rejects.toMatchObject({ code: 2565 });
  });

  it('ignores answers that belong to other commands', async () => {
    const ft = await transferPort();
    closers.push(ft.close);
    const { client } = fakeClient((c, cl) => {
      cl.emit('command', { name: 'error', params: { id: '2568', msg: 'someone else', return_code: 'other-1' } });
      cl.emit('command', { name: 'notifystartupload', params: { clientftfid: '65000', ftkey: 'WRONG', port: '1' } });
      cl.emit('command', { name: 'notifystartupload', params: { clientftfid: c.params.clientftfid, ftkey: 'K', port: String(ft.port) } });
    });
    await uploadFile(client, '127.0.0.1', 0, '/avatar', Buffer.from('y'));
    expect(await ft.received).toEqual(Buffer.from('Ky'));
  });

  it('fails cleanly when nothing listens on the transfer port', async () => {
    const ft = await transferPort();
    ft.close();
    const { client } = fakeClient((c, cl) => {
      cl.emit('command', { name: 'notifystartupload', params: { clientftfid: c.params.clientftfid, ftkey: 'K', port: String(ft.port) } });
    });
    await expect(uploadFile(client, '127.0.0.1', 0, '/avatar', Buffer.from('z'))).rejects.toMatchObject({ code: 0 });
  });

  it('stops waiting when the connection closes', async () => {
    const { client } = fakeClient((_c, cl) => cl.emit('disconnected'));
    await expect(uploadFile(client, '127.0.0.1', 0, '/avatar', Buffer.from('z'))).rejects.toThrow('connection closed');
  });
});

describe('sendConfirmed and deleteFile', () => {
  it('resolve on the server\'s ok to that command', async () => {
    const { client, sent } = fakeClient((c, cl) => cl.emit('command', ok(c)));
    await sendConfirmed(client, 'clientupdate', { client_flag_avatar: 'abc' });
    await deleteFile(client, 0, '/avatar_abc');
    expect(parseCommand(sent[0]).params.client_flag_avatar).toBe('abc');
    expect(parseCommand(sent[1])).toMatchObject({ name: 'ftdeletefile', params: { cid: '0', cpw: '', name: '/avatar_abc' } });
  });

  it('reject with the error id when refused', async () => {
    const { client } = fakeClient((c, cl) => {
      cl.emit('command', { name: 'error', params: { id: '2051', msg: 'file not found', return_code: c.params.return_code } });
    });
    await expect(deleteFile(client, 0, '/avatar_abc')).rejects.toMatchObject({ code: 2051 });
  });
});
