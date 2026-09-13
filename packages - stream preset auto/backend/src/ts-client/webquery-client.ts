import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import { TSApiError } from '../middleware/error-handler.js';
import { config } from '../config.js';

export class WebQueryClient {
  private http!: AxiosInstance;
  private agent!: http.Agent | https.Agent;
  private lastTransportReset = 0;
  // Circuit breaker: when the server is flood-protecting us, every reset
  // opens yet another query connection and feeds the flood counter. One
  // reset attempt per window, then fail fast.
  private static readonly RESET_COOLDOWN_MS = 5000;

  constructor(
    private host: string,
    private port: number,
    private apiKey: string,
    private useHttps: boolean = false,
  ) {
    this.createTransport();
  }

  // Use a single persistent TCP connection (keep-alive) to the TS WebQuery API.
  // Without this, each concurrent request opens a new TCP connection, and the
  // TS server registers each one as a separate "serveradmin" query client
  // (serveradmin, serveradmin1, serveradmin2, ...).
  private createTransport(): void {
    const protocol = this.useHttps ? 'https' : 'http';

    this.agent = this.useHttps
      ? new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: !config.tsAllowSelfSigned })
      : new http.Agent({ keepAlive: true, maxSockets: 1 });

    this.http = axios.create({
      baseURL: `${protocol}://${this.host}:${this.port}`,
      headers: { 'x-api-key': this.apiKey },
      timeout: 15000,
      httpAgent: this.useHttps ? undefined : this.agent,
      httpsAgent: this.useHttps ? this.agent : undefined,
    });
  }

  // A long-lived agent can rot irrecoverably: its single keep-alive socket
  // may die silently (NAT/conntrack expiry, server-side close without RST)
  // while Node still considers it established, and with maxSockets: 1 every
  // request then funnels through the corpse. Rebuild agent + axios so the
  // retry behaves exactly like a freshly created client.
  private resetTransport(): void {
    try { this.agent.destroy(); } catch { }
    this.createTransport();
    console.warn(`[WebQuery] Transport reset for ${this.host}:${this.port} after a stale-socket error`);
  }

  // The single keep-alive socket can be closed server-side while idle; the
  // next request then fails instantly with ECONNRESET/"socket hang up". The
  // errored socket is discarded from the pool, so one retry on a fresh
  // connection is safe — but only for errors where no response was received.
  private isStaleSocketError(error: any): boolean {
    if (error.response) return false;
    const code = error.code || '';
    const msg = error.message || '';
    return code === 'ECONNRESET' || code === 'EPIPE' || msg.includes('socket hang up');
  }

  private async withStaleSocketRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error: any) {
      if (!this.isStaleSocketError(error)) throw error;
      const now = Date.now();
      if (now - this.lastTransportReset < WebQueryClient.RESET_COOLDOWN_MS) {
        throw error;
      }
      this.lastTransportReset = now;
      this.resetTransport();
      return await fn();
    }
  }

  async execute(sid: number, command: string, params?: Record<string, any>): Promise<any> {
    try {
      // WebQuery URL pattern: /{sid}/{command}
      // For instance-level commands (sid=0): /{command}
      const path = sid > 0 ? `/${sid}/${command}` : `/${command}`;

      const response = await this.withStaleSocketRetry(() =>
        this.http.get(path, { params: this.cleanParams(params) })
      );

      const data = response.data;

      if (data.status && data.status.code !== 0) {
        throw new TSApiError(data.status.code, data.status.message);
      }

      return data.body || data;
    } catch (error: any) {
      if (error instanceof TSApiError) throw error;
      if (error.response?.data?.status) {
        throw new TSApiError(
          error.response.data.status.code,
          error.response.data.status.message,
        );
      }
      throw new TSApiError(-1, error.message || 'Connection failed');
    }
  }

  async executePost(sid: number, command: string, params?: Record<string, any>): Promise<any> {
    try {
      const path = sid > 0 ? `/${sid}/${command}` : `/${command}`;
      const response = await this.withStaleSocketRetry(() =>
        this.http.post(path, null, { params: this.cleanParams(params) })
      );

      const data = response.data;
      if (data.status && data.status.code !== 0) {
        throw new TSApiError(data.status.code, data.status.message);
      }

      return data.body || data;
    } catch (error: any) {
      if (error instanceof TSApiError) throw error;
      if (error.response?.data?.status) {
        throw new TSApiError(
          error.response.data.status.code,
          error.response.data.status.message,
        );
      }
      throw new TSApiError(-1, error.message || 'Connection failed');
    }
  }

  // Remove undefined/null values from params
  private cleanParams(params?: Record<string, any>): Record<string, any> | undefined {
    if (!params) return undefined;
    const cleaned: Record<string, any> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        cleaned[key] = value;
      }
    }
    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }

  // Test connection
  async testConnection(): Promise<boolean> {
    try {
      await this.execute(0, 'version');
      return true;
    } catch {
      return false;
    }
  }

  // Destroy the HTTP agent, closing all keep-alive sockets.
  // Call this for temporary clients (e.g. test connection) to avoid lingering query logins.
  destroy(): void {
    this.agent.destroy();
  }
}
