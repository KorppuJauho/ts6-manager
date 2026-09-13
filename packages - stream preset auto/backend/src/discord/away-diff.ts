export interface AwayClient {
  clid: string;
  cid: string;
  isAway: boolean;
  nickname: string;
}

export interface AwayChange {
  clid: string;
  cid: string;
  nickname: string;
  isAway: boolean;
}

/**
 * Map a raw `clientlist` response into the AwayClient shape used by
 * diffAwayState, filtering out non-regular clients (ServerQuery, etc.) and,
 * when a channel is being watched, clients outside that channel.
 */
export function mapAwayClients(
  list: unknown,
  watchedChannel: string | null | undefined,
): AwayClient[] {
  return (Array.isArray(list) ? list : [])
    .filter((c: any) => String(c.client_type) === '0')
    .filter((c: any) => !watchedChannel || String(c.cid) === watchedChannel)
    .map((c: any) => ({
      clid: String(c.clid),
      cid: String(c.cid),
      isAway: Number(c.client_away) === 1,
      nickname: c.client_nickname || `Client #${c.clid}`,
    }));
}

/**
 * Compare the previous away-state map against the current client list.
 * On first run (empty prev) it seeds without emitting changes, to avoid
 * spamming a notification for every already-away client at startup/reload.
 */
export function diffAwayState(
  prev: Map<string, boolean>,
  current: AwayClient[],
): { changes: AwayChange[]; next: Map<string, boolean>; seeded: boolean } {
  const next = new Map<string, boolean>();
  const seeded = prev.size === 0;
  const changes: AwayChange[] = [];

  for (const client of current) {
    next.set(client.clid, client.isAway);
    if (seeded) continue;
    const was = prev.get(client.clid);
    if (was !== undefined && was !== client.isAway) {
      changes.push({ clid: client.clid, cid: client.cid, nickname: client.nickname, isAway: client.isAway });
    }
  }

  return { changes, next, seeded };
}
