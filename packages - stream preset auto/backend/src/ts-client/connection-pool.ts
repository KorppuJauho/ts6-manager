import { PrismaClient } from '../../generated/prisma/index.js';
import { WebQueryClient } from './webquery-client.js';
import { decrypt } from '../utils/crypto.js';

export class ConnectionPool {
  private clients: Map<number, WebQueryClient> = new Map();

  constructor(private prisma: PrismaClient) {}

  async initialize(): Promise<void> {
    const servers = await this.prisma.tsServerConfig.findMany({
      where: { enabled: true },
    });

    for (const server of servers) {
      try {
        // H8: Decrypt API key before use
        this.addClient(server.id, server.host, server.webqueryPort, decrypt(server.apiKey), server.useHttps);
      } catch (err: any) {
        // One undecryptable row (e.g. ENCRYPTION_KEY changed) must not prevent
        // the backend from starting; re-saving the API key repairs the row.
        console.error(`[ConnectionPool] Skipping server config ID ${server.id}: ${err.message}`);
      }
    }

    console.log(`[ConnectionPool] Initialized ${this.clients.size} server connection(s)`);
  }

  addClient(id: number, host: string, port: number, apiKey: string, useHttps: boolean): void {
    const existing = this.clients.get(id);
    if (existing) existing.destroy();
    const client = new WebQueryClient(host, port, apiKey, useHttps);
    this.clients.set(id, client);
  }

  removeClient(id: number): void {
    const client = this.clients.get(id);
    if (client) {
      client.destroy();
      this.clients.delete(id);
    }
  }

  getClient(configId: number): WebQueryClient {
    const client = this.clients.get(configId);
    if (!client) {
      throw new Error(`No connection configured for server config ID ${configId}`);
    }
    return client;
  }

  hasClient(configId: number): boolean {
    return this.clients.has(configId);
  }

  /**
   * Like getClient, but on a cache miss falls back to the DB (source of
   * truth) and hydrates the pool. This makes the pool self-healing: an
   * enabled connection present in the DB always works, even if the in-memory
   * pool diverged (missed registration, partial startup, etc.) — previously
   * that state persisted until the backend was restarted.
   */
  async getOrLoad(configId: number): Promise<WebQueryClient> {
    const cached = this.clients.get(configId);
    if (cached) return cached;

    const server = await this.prisma.tsServerConfig.findUnique({
      where: { id: configId },
    });
    if (!server || !server.enabled) {
      throw new Error(`No connection configured for server config ID ${configId}`);
    }

    this.addClient(server.id, server.host, server.webqueryPort, decrypt(server.apiKey), server.useHttps);
    console.log(`[ConnectionPool] Lazily hydrated connection for server config ID ${configId}`);
    return this.clients.get(configId)!;
  }

  async refreshClient(configId: number): Promise<void> {
    const server = await this.prisma.tsServerConfig.findUnique({
      where: { id: configId },
    });
    if (server && server.enabled) {
      this.addClient(server.id, server.host, server.webqueryPort, decrypt(server.apiKey), server.useHttps);
    } else {
      this.removeClient(configId);
    }
  }

  destroy(): void {
    for (const client of this.clients.values()) {
      client.destroy();
    }
    this.clients.clear();
  }
}
