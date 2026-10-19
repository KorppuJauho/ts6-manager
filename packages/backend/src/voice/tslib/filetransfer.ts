// File transfer over the bot's own TeamSpeak connection: what a bot avatar
// needs (upload, delete) and a command that waits for the server's answer.
//
// The request goes over the command connection (ftinitupload). The server
// answers with notifystartupload carrying a key and a port, and the bytes then
// go over a separate TCP connection to that port (30033 by default) on the
// server's host: first the key, then the file.
//
// Every command carries a return_code, which the server echoes on its
// "error id=… return_code=…" reply, so the answer to this command is told
// apart from errors other commands draw in the same window.

import net from 'net';
import type { EventEmitter } from 'events';
import { buildCommand, type ParsedCommand } from './commands.js';

/** What this needs from a client: send a command, and see every command that comes back. */
export interface FileTransferClient extends EventEmitter {
  sendCommand(cmd: string): void;
}

export class FileTransferError extends Error {
  /** TeamSpeak's error id (2568 = insufficient permissions), or 0 when the problem is ours or the network's. */
  constructor(message: string, public readonly code = 0) {
    super(message);
    this.name = 'FileTransferError';
  }
}

/** "insufficient client permissions" */
export const ERROR_NO_PERMISSION = 2568;
/** "invalid size": over the server's max avatar file size for this client. */
export const ERROR_INVALID_SIZE = 2565;

const ANSWER_MS = 15_000;
const TRANSFER_MS = 60_000;

let counter = 0;
// clientftfid is 16-bit on the wire.
const nextTransferId = () => (counter = (counter % 65535) + 1);
const nextReturnCode = (prefix: string) => `${prefix}-${nextTransferId()}`;

/** Waits for the first command `pick` returns a value for (or throws on), the client's disconnect, or the time limit. */
function waitFor<T>(client: FileTransferClient, pick: (cmd: ParsedCommand) => T | undefined, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      client.off('command', onCommand);
      client.off('disconnected', onGone);
    };
    const onCommand = (cmd: ParsedCommand) => {
      let value: T | undefined;
      try {
        value = pick(cmd);
      } catch (e) {
        finish();
        reject(e);
        return;
      }
      if (value !== undefined) {
        finish();
        resolve(value);
      }
    };
    const onGone = () => {
      finish();
      reject(new FileTransferError('the TeamSpeak connection closed'));
    };
    const timer = setTimeout(() => {
      finish();
      reject(new FileTransferError('TeamSpeak did not answer'));
    }, ms);
    client.on('command', onCommand);
    client.on('disconnected', onGone);
  });
}

function answerTo(cmd: ParsedCommand, returnCode: string): { id: number; msg: string } | undefined {
  if (cmd.name !== 'error' || cmd.params.return_code !== returnCode) return undefined;
  return { id: parseInt(cmd.params.id || '0') || 0, msg: cmd.params.msg || '' };
}

/**
 * Sends a command and settles with the server's answer to it: resolves on
 * "ok", rejects with the server's error id otherwise.
 */
export async function sendConfirmed(
  client: FileTransferClient,
  name: string,
  params: Record<string, string | number | boolean | undefined>,
): Promise<void> {
  const returnCode = nextReturnCode(name);
  const answer = waitFor(client, (cmd) => answerTo(cmd, returnCode), ANSWER_MS);
  client.sendCommand(buildCommand(name, { ...params, return_code: returnCode }));
  const { id, msg } = await answer;
  if (id !== 0) throw new FileTransferError(msg || `${name} refused`, id);
}

interface StartAnswer {
  ftkey: string;
  port: number;
}

/**
 * Uploads `data` as `name` (a full path such as "/avatar") into channel
 * `cid`'s files, replacing a file of that name when `overwrite`.
 *
 * `host` is the server's address as the bot reaches it. The port is the one
 * the server names in its answer.
 */
export async function uploadFile(
  client: FileTransferClient,
  host: string,
  cid: number,
  name: string,
  data: Buffer,
  overwrite = true,
): Promise<void> {
  const clientftfid = nextTransferId();
  const returnCode = nextReturnCode('ftinitupload');
  const answer = waitFor<StartAnswer>(client, (cmd) => {
    const p = cmd.params;
    if (cmd.name === 'notifystartupload' && parseInt(p.clientftfid) === clientftfid) {
      const port = parseInt(p.port);
      if (!p.ftkey || !(port > 0 && port < 65536)) throw new FileTransferError('TeamSpeak gave no transfer address');
      return { ftkey: p.ftkey, port };
    }
    // A refusal arrives either as the command's own error or, once the
    // transfer exists, as its status.
    if (cmd.name === 'notifystatusfiletransfer' && parseInt(p.clientftfid) === clientftfid) {
      throw new FileTransferError(p.msg || 'upload refused', parseInt(p.status || '0') || 0);
    }
    const own = answerTo(cmd, returnCode);
    if (own && own.id !== 0) throw new FileTransferError(own.msg || 'upload refused', own.id);
    return undefined;
  }, ANSWER_MS);
  client.sendCommand(buildCommand('ftinitupload', {
    clientftfid,
    name,
    cid,
    cpw: '',
    size: data.length,
    overwrite: overwrite ? 1 : 0,
    resume: 0,
    return_code: returnCode,
  }));
  const start = await answer;

  await new Promise<void>((resolve, reject) => {
    let sent = false;
    const socket = net.connect({ host, port: start.port });
    const timer = setTimeout(() => {
      socket.destroy();
      // Everything was handed over; the server just did not close its side.
      if (sent) resolve();
      else reject(new FileTransferError('the upload took too long'));
    }, TRANSFER_MS);
    socket.on('connect', () => {
      socket.write(Buffer.from(start.ftkey, 'ascii'));
      socket.end(data, () => { sent = true; });
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(new FileTransferError(`upload connection to ${host}:${start.port} failed: ${e.message}`));
    });
    socket.on('close', (hadError) => {
      clearTimeout(timer);
      if (hadError) return; // 'error' already rejected
      if (sent) resolve();
      else reject(new FileTransferError('the upload connection closed early'));
    });
  });
}

/** Deletes `name` (a full path) from channel `cid`'s files. */
export function deleteFile(client: FileTransferClient, cid: number, name: string): Promise<void> {
  return sendConfirmed(client, 'ftdeletefile', { cid, cpw: '', name });
}
