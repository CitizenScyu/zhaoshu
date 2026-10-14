import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { neon } from '@neondatabase/serverless';
import type { SourceTransport } from './engine';

export type HostOccupancySql = ReturnType<typeof neon>;

export class HostOccupiedError extends Error {
  readonly code = 'HOST_OCCUPIED';
  constructor(readonly host: string) {
    super('host occupied: ' + host);
    this.name = 'HostOccupiedError';
  }
}

export class HostOccupancyUnavailableError extends Error {
  readonly code = 'HOST_OCCUPANCY_UNAVAILABLE';
  constructor(cause: unknown) {
    super('host occupancy unavailable');
    this.name = 'HostOccupancyUnavailableError';
    this.cause = cause;
  }
}

type GateFn = (signal: AbortSignal, url: string) => void | Promise<void>;
interface OccupancyScope {
  readonly kind: 'download' | 'prefetch';
  readonly taskId: number | null;
  readonly holder: string;
  readonly signal: AbortSignal;
  closed: boolean;
  readonly hosts: Set<string>;
}

export interface HostOccupancy {
  runDownload<T>(taskId: number, signal: AbortSignal, operation: () => Promise<T>): Promise<T>;
  wrapTransport(transport: SourceTransport): SourceTransport;
}
export interface HostOccupancyOptions {
  downloadTtlMs: number;
  scanTtlMs: number;
}

export function createHostOccupancy(sql: HostOccupancySql, options: HostOccupancyOptions): HostOccupancy {
  for (const name of ['downloadTtlMs', 'scanTtlMs'] as const) {
    const value = options[name];
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  }
  const scopes = new AsyncLocalStorage<OccupancyScope>();
  const occupy = (scope: OccupancyScope, host: string, signal: AbortSignal) => {
    const ttl = scope.kind === 'download' ? options.downloadTtlMs : options.scanTtlMs;
    return sql.transaction(tx => [tx`
      INSERT INTO download_host_occupancy (host, holder, kind, task_id, claimed_at, expires_at)
      VALUES (${host}, ${scope.holder}, ${scope.kind}, ${scope.taskId}, now(),
              now() + (${ttl}::bigint * interval '1 millisecond'))
      ON CONFLICT (host) DO UPDATE
        SET holder = ${scope.holder}, kind = ${scope.kind}, task_id = ${scope.taskId},
            claimed_at = now(), expires_at = now() + (${ttl}::bigint * interval '1 millisecond')
        WHERE download_host_occupancy.expires_at <= now()
           OR download_host_occupancy.holder = ${scope.holder}
      RETURNING host`], { fetchOptions: { signal } }) as unknown as Promise<{ host: string }[][]>;
  };
  const releaseHosts = async (holder: string, hosts: readonly string[]): Promise<void> => {
    for (const host of hosts) {
      try {
        await sql`DELETE FROM download_host_occupancy WHERE host = ${host} AND holder = ${holder}`;
      } catch { /* Expiry recovers a lease when release cannot reach the database. */ }
    }
  };
  const closeScope = (scope: OccupancyScope): Promise<void> => {
    if (scope.closed) return Promise.resolve();
    scope.closed = true;
    return releaseHosts(scope.holder, [...scope.hosts]);
  };
  const occupyPhysical: GateFn = async (signal, url) => {
    const scope = scopes.getStore();
    if (!scope) return;
    if (scope.closed) throw new Error('HOST_SCOPE_CLOSED');
    scope.signal.throwIfAborted();
    signal.throwIfAborted();
    let host: string;
    try { host = new URL(url).hostname; } catch { return; }
    if (!host) return;
    let row: { host: string } | undefined;
    try {
      row = (await occupy(scope, host, signal))[0]?.[0];
    } catch (error) {
      if (scope.closed) await releaseHosts(scope.holder, [host]);
      else scope.hosts.add(host);
      signal.throwIfAborted();
      scope.signal.throwIfAborted();
      throw new HostOccupancyUnavailableError(error);
    }
    if (!row) throw new HostOccupiedError(host);
    if (scope.closed) {
      await releaseHosts(scope.holder, [host]);
      throw new Error('HOST_SCOPE_CLOSED');
    }
    scope.hosts.add(host);
    signal.throwIfAborted();
    scope.signal.throwIfAborted();
  };
  const gate = (inner: GateFn | undefined): GateFn => async (signal, url) => {
    await inner?.(signal, url);
    await occupyPhysical(signal, url);
  };
  return {
    async runDownload<T>(taskId: number, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
      const scope: OccupancyScope = {
        kind: 'download', taskId, holder: randomUUID(), signal, closed: false, hosts: new Set(),
      };
      return scopes.run(scope, async () => {
        try { return await operation(); }
        finally { await closeScope(scope); }
      });
    },
    wrapTransport(transport: SourceTransport): SourceTransport {
      return (url, options) => {
        const gated = {
          ...options, beforeFetch: gate(options.beforeFetch), afterAcquire: gate(options.afterAcquire),
        };
        if (scopes.getStore()) return transport(url, gated);
        const scope: OccupancyScope = {
          kind: 'prefetch', taskId: null, holder: randomUUID(),
          signal: options.signal, closed: false, hosts: new Set(),
        };
        return scopes.run(scope, async () => {
          try { return await transport(url, gated); }
          finally { await closeScope(scope); }
        });
      };
    },
  };
}
