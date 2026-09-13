import { Router, Request, Response } from 'express';
import type { ConnectionPool } from '../ts-client/connection-pool.js';

export const dashboardRoutes: Router = Router({ mergeParams: true });

const getClient = (req: Request) => {
  const pool: ConnectionPool = req.app.locals.connectionPool;
  return pool.getClient(parseInt(String(req.params.configId)));
};

// One dashboard refresh costs 4 WebQuery commands in a burst, multiplied by
// every open browser tab — a major contributor to the TS server's flood
// counter (error 524). Short shared cache: N tabs cost the same as one.
const dashboardCache = new Map<string, { at: number; payload: any }>();
const DASHBOARD_CACHE_TTL_MS = 5000;

dashboardRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const sid = parseInt(String(req.params.sid));
    const cacheKey = `${req.params.configId}:${sid}`;
    const cached = dashboardCache.get(cacheKey);
    if (cached && Date.now() - cached.at < DASHBOARD_CACHE_TTL_MS) {
      return res.json(cached.payload);
    }

    const client = getClient(req);

    const [serverInfo, clientList, channelList, connectionInfo] = await Promise.all([
      client.execute(sid, 'serverinfo'),
      client.execute(sid, 'clientlist'),
      client.execute(sid, 'channellist'),
      client.execute(sid, 'serverrequestconnectioninfo'),
    ]);

    const info = Array.isArray(serverInfo) ? serverInfo[0] : serverInfo;
    const connInfo = Array.isArray(connectionInfo) ? connectionInfo[0] : connectionInfo;
    const clients = Array.isArray(clientList) ? clientList : [];
    const channels = Array.isArray(channelList) ? channelList : [];

    const onlineClients = clients.filter((c: any) => String(c.client_type) === '0');

    const payload = {
      serverName: info.virtualserver_name,
      platform: info.virtualserver_platform,
      version: info.virtualserver_version,
      onlineUsers: onlineClients.length,
      maxClients: Number(info.virtualserver_maxclients) || 0,
      uptime: Number(info.virtualserver_uptime) || 0,
      channelCount: channels.length,
      bandwidth: {
        incoming: Number(connInfo.connection_bandwidth_received_last_second_total) || 0,
        outgoing: Number(connInfo.connection_bandwidth_sent_last_second_total) || 0,
      },
      packetloss: Number(info.virtualserver_total_packetloss_total) || 0,
      ping: Number(info.virtualserver_total_ping) || 0,
    };

    dashboardCache.set(cacheKey, { at: Date.now(), payload });
    res.json(payload);
  } catch (err) { next(err); }
});
