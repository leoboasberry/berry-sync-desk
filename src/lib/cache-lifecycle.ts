import { getDb } from "./db";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BroadcastEnvelope<T = unknown> = {
  version: 1;
  env: string;
  userId: string;
  accountId?: number;
  tabId: string;
  timestamp: number;
  payload: T;
};

export type BroadcastPayload =
  | { type: "LOGOUT" }
  | { type: "CACHE_UPDATED"; status: string }
  | { type: "SYNC_STARTED"; status: string }
  | { type: "SYNC_FINISHED"; status: string; fetchedAt: number }
  | { type: "CLEAR_CACHE" };

export type SyncLease = {
  ownerTabId: string;
  acquiredAt: number;
  expiresAt: number;
};

export type CacheLifecycleHandlers = {
  onLogout?: () => void;
  onCacheUpdated?: (payload: { status: string }) => void;
  onSyncStarted?: (payload: { status: string }) => void;
  onSyncFinished?: (payload: { status: string; fetchedAt: number }) => void;
};

export type CacheLifecycle = {
  tabId: string;
  channelName: string;
  broadcast: (payload: BroadcastPayload, evtAccountId?: number) => void;
  runWithSyncLock: (
    lockKey: string,
    fn: () => Promise<void>,
    options?: { signal?: AbortSignal }
  ) => Promise<void>;
  close: () => void;
};

// ── Constants ─────────────────────────────────────────────────────────────────

export const LEASE_TTL_MS = 30_000;
export const LEASE_RENEWAL_INTERVAL_MS = Math.floor(LEASE_TTL_MS / 3); // 10 000 ms
const LEASE_META_PREFIX = "sync_lease:";

// ── Tab identity ──────────────────────────────────────────────────────────────

function generateTabId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ── Envelope validation ───────────────────────────────────────────────────────
// Discards events from: wrong version, wrong env, wrong user, own tab, malformed payload.

export function isValidEnvelope(
  data: unknown,
  expectedEnv: string,
  expectedUserId: string,
  ownTabId: string
): data is BroadcastEnvelope<BroadcastPayload> {
  if (!data || typeof data !== "object") return false;
  const e = data as Record<string, unknown>;
  if (e.version !== 1) return false;
  if (e.env !== expectedEnv) return false;
  if (e.userId !== expectedUserId) return false;
  if (e.tabId === ownTabId) return false;           // don't process own events
  if (typeof e.timestamp !== "number") return false;
  if (!e.payload || typeof e.payload !== "object") return false;
  if (typeof (e.payload as Record<string, unknown>).type !== "string") return false;
  return true;
}

// ── Lease helpers (IndexedDB fallback when Web Locks unavailable) ─────────────

async function acquireLease(
  env: string,
  userId: string,
  accountId: number,
  lockKey: string,
  tabId: string
): Promise<boolean> {
  const db = getDb(env, userId);
  const metaKey = `${LEASE_META_PREFIX}${lockKey}`;
  const now = Date.now();

  const existing = await db.meta.get([accountId, metaKey]);
  if (existing) {
    const lease = existing.value as SyncLease;
    // Valid lease held by another tab → skip
    if (lease.expiresAt > now && lease.ownerTabId !== tabId) {
      return false;
    }
    // Expired or held by this same tab → take it
  }

  const lease: SyncLease = {
    ownerTabId: tabId,
    acquiredAt: now,
    expiresAt: now + LEASE_TTL_MS,
  };
  await db.meta.put({ accountId, key: metaKey, value: lease });
  return true;
}

export async function renewLease(
  env: string,
  userId: string,
  accountId: number,
  lockKey: string,
  tabId: string
): Promise<boolean> {
  const db = getDb(env, userId);
  const metaKey = `${LEASE_META_PREFIX}${lockKey}`;
  const existing = await db.meta.get([accountId, metaKey]);
  if (!existing) return false;
  const lease = existing.value as SyncLease;
  if (lease.ownerTabId !== tabId) return false; // another tab owns it — do not renew
  const now = Date.now();
  const renewed: SyncLease = {
    ownerTabId: tabId,
    acquiredAt: lease.acquiredAt,
    expiresAt: now + LEASE_TTL_MS,
  };
  await db.meta.put({ accountId, key: metaKey, value: renewed });
  return true;
}

async function releaseLease(
  env: string,
  userId: string,
  accountId: number,
  lockKey: string,
  tabId: string
): Promise<void> {
  const db = getDb(env, userId);
  const metaKey = `${LEASE_META_PREFIX}${lockKey}`;
  const existing = await db.meta.get([accountId, metaKey]);
  // Only release if this tab still owns it (guards against stale cleanup)
  if (existing && (existing.value as SyncLease).ownerTabId === tabId) {
    await db.meta.delete([accountId, metaKey]);
  }
}

export async function readLease(
  env: string,
  userId: string,
  accountId: number,
  lockKey: string
): Promise<SyncLease | null> {
  const db = getDb(env, userId);
  const metaKey = `${LEASE_META_PREFIX}${lockKey}`;
  const row = await db.meta.get([accountId, metaKey]);
  return row ? (row.value as SyncLease) : null;
}

// ── hasWebLocks — testable abstraction ───────────────────────────────────────

function hasWebLocks(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator !== null &&
    "locks" in navigator &&
    Boolean((navigator as any).locks)
  );
}

// ── createCacheLifecycle ───────────────────────────────────────────────────────

export function createCacheLifecycle(params: {
  env: string;
  userId: string;
  accountId: number;
  handlers: CacheLifecycleHandlers;
}): CacheLifecycle {
  const { env, userId, accountId, handlers } = params;
  const tabId = generateTabId();
  const channelName = `berry-sync:${env}:${userId}`;

  let channel: BroadcastChannel | null = null;
  let closed = false;

  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(channelName);
    channel.onmessage = (event: MessageEvent) => {
      if (closed) return;
      if (!isValidEnvelope(event.data, env, userId, tabId)) return;

      const envelope = event.data as BroadcastEnvelope<BroadcastPayload>;
      const p = envelope.payload;

      if (p.type === "LOGOUT") {
        handlers.onLogout?.();
      } else if (p.type === "CACHE_UPDATED") {
        if (envelope.accountId === accountId) {
          handlers.onCacheUpdated?.({ status: p.status });
        }
      } else if (p.type === "SYNC_STARTED") {
        if (envelope.accountId === accountId) {
          handlers.onSyncStarted?.({ status: p.status });
        }
      } else if (p.type === "SYNC_FINISHED") {
        if (envelope.accountId === accountId) {
          handlers.onSyncFinished?.({ status: p.status, fetchedAt: p.fetchedAt });
        }
      }
      // CLEAR_CACHE handled by caller if needed
    };
  }

  // ── broadcast ──────────────────────────────────────────────────────────────
  const broadcast = (payload: BroadcastPayload, evtAccountId?: number): void => {
    if (closed || !channel) return;
    const envelope: BroadcastEnvelope<BroadcastPayload> = {
      version: 1,
      env,
      userId,
      accountId: evtAccountId ?? accountId,
      tabId,
      timestamp: Date.now(),
      payload,
    };
    channel.postMessage(envelope);
  };

  // ── runWithSyncLock ────────────────────────────────────────────────────────
  const runWithSyncLock = async (
    lockKey: string,
    fn: () => Promise<void>,
    options?: { signal?: AbortSignal }
  ): Promise<void> => {
    if (closed) return;
    const fullLockName = `berry-sync:${env}:${userId}:${accountId}:${lockKey}`;

    if (hasWebLocks()) {
      // Web Locks API: ifAvailable=true → callback receives null if lock is taken
      const reqOptions: Record<string, unknown> = { ifAvailable: true };
      if (options?.signal) reqOptions.signal = options.signal;

      await (navigator as any).locks.request(
        fullLockName,
        reqOptions,
        async (lock: { name: string } | null) => {
          if (!lock) return; // another tab holds it — skip
          try {
            await fn();
          } catch {
            // lock released automatically when callback returns/throws
          }
        }
      );
      return;
    }

    // Fallback: IndexedDB lease
    if (options?.signal?.aborted) return;

    const acquired = await acquireLease(env, userId, accountId, lockKey, tabId);
    if (!acquired) return;

    // Renew the lease periodically so long-running fns don't let it expire.
    // Renewal stops in the finally block regardless of success/error/abort.
    const renewalTimer = setInterval(() => {
      if (closed || options?.signal?.aborted) {
        clearInterval(renewalTimer);
        return;
      }
      renewLease(env, userId, accountId, lockKey, tabId).catch(() => {});
    }, LEASE_RENEWAL_INTERVAL_MS);

    try {
      if (options?.signal?.aborted) return;
      await fn();
    } catch {
      // errors must not block lease release or renewal cleanup
    } finally {
      clearInterval(renewalTimer);
      await releaseLease(env, userId, accountId, lockKey, tabId);
    }
  };

  // ── close ──────────────────────────────────────────────────────────────────
  // Must be called on unmount, logout, hot-reload, or account switch.
  const close = (): void => {
    closed = true;       // block all callbacks before closing channel
    channel?.close();
    channel = null;
  };

  return { tabId, channelName, broadcast, runWithSyncLock, close };
}
