import Dexie, { type Table } from "dexie";

// ── Scope & types ──────────────────────────────────────────────────────────────

export type CacheEnv = "production" | "development" | "staging" | "preview";

export interface CacheScope {
  env: CacheEnv;
  userId: string;
  accountId: number;
}

export interface CachedConversation {
  accountId: number;
  id: number;
  status: string;
  last_activity_at: number;
  data: unknown;
  cachedAt: number;
  // Soft-delete fields — conversations are never deleted automatically.
  // Missing from a complete sync → stale=true; reappearing → stale=false.
  stale?: boolean;
  staleReason?: "not_returned" | "status_changed" | "permission_changed" | "deleted_remotely" | "unknown";
  lastSeenAt?: number;
  inaccessibleAt?: number;
}

export interface CachedMessage {
  accountId: number;
  conversationId: number;
  id: number;
  created_at: number;
  data: unknown;
  cachedAt: number;
  // Soft-delete fields — messages are never deleted automatically.
  // Absent from a response does NOT mean deleted; require explicit event.
  stale?: boolean;
  staleReason?: "not_returned" | "deleted_remotely" | "permission_changed" | "unknown";
  lastSeenAt?: number;
  deletedAt?: number;
}

export interface CachedContact {
  accountId: number;
  phone: string;
  hubspot_owner_id: string | null;
  cachedAt: number;
}

export interface SyncMeta {
  accountId: number;
  key: string;
  value: unknown;
}

export type LegacyMigrationReport = {
  legacyDatabaseFound: boolean;
  conversationsFound: number;
  messagesFound: number;
  contactsFound: number;
  metaFound: number;
  migrated: number;
  skippedAmbiguous: number;
  skippedInvalid: number;
  errors: Array<{ entity: string; legacyKey: string; reason: string }>;
};

// ── TTL constants ─────────────────────────────────────────────────────────────

export const TTL_CONVERSATIONS_MS = 7 * 24 * 60 * 60_000;  // 7 days
export const TTL_MESSAGES_MS      = 7 * 24 * 60 * 60_000;  // 7 days
export const TTL_CONTACTS_MS      = 30 * 60_000;            // 30 min

// TTL check: record is "expired" → do not serve as current data.
// Expired records are NOT deleted immediately; use purgeExpiredRecords() explicitly.
export function isExpired(cachedAt: number, ttlMs: number): boolean {
  return Date.now() - cachedAt > ttlMs;
}

// ── DB naming ─────────────────────────────────────────────────────────────────

export const LEGACY_DB_NAME = "berry-sync-desk";

export function scopedDbName(env: string, userId: string): string {
  return `berry-sync:${env}:${userId}`;
}

// ── Dexie class ───────────────────────────────────────────────────────────────

class BerrySyncDB extends Dexie {
  conversations!: Table<CachedConversation, [number, number]>;
  messages!: Table<CachedMessage, [number, number, number]>;
  contacts!: Table<CachedContact, [number, string]>;
  meta!: Table<SyncMeta, [number, string]>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      // Compound PK [accountId+id] ensures no cross-account collision.
      // Secondary indexes include standalone `accountId` for bulk-delete and `cachedAt` for TTL purge.
      conversations: "[accountId+id], [accountId+status+last_activity_at], accountId, cachedAt",
      messages:      "[accountId+conversationId+id], [accountId+conversationId+created_at], accountId, cachedAt",
      contacts:      "[accountId+phone], accountId, cachedAt",
      meta:          "[accountId+key], accountId",
    });
  }
}

// ── DB singleton per user+env ─────────────────────────────────────────────────
// One DB per user. accountId is encoded in keys, not the DB name, so switching
// accounts within the same session reuses the same DB connection.

const _instances = new Map<string, BerrySyncDB>();

export function getDb(env: string, userId: string): BerrySyncDB {
  const name = scopedDbName(env, userId);
  if (!_instances.has(name)) {
    _instances.set(name, new BerrySyncDB(name));
  }
  return _instances.get(name)!;
}

export function closeDb(env: string, userId: string): void {
  const name = scopedDbName(env, userId);
  const db = _instances.get(name);
  if (db) {
    db.close();
    _instances.delete(name);
  }
}

// ── Logout lifecycle ──────────────────────────────────────────────────────────
// Closes the DB and removes the in-process handle. The IndexedDB data on disk
// is preserved — another login by the same userId reopens it safely.
// To wipe data call clearScopedDb() with explicit confirmation.
export function onLogout(env: string, userId: string): void {
  closeDb(env, userId);
}

// ── clearScopedDb — explicit wipe with confirmation ───────────────────────────
// Removes all rows for a specific accountId from the scoped DB.
// Requires a literal confirmation string to prevent accidental calls.
export async function clearScopedDb(params: {
  env: string;
  userId: string;
  accountId: number;
  reason: string;
  confirmation: "I_UNDERSTAND_THIS_IS_IRREVERSIBLE";
}): Promise<{ conversations: number; messages: number; contacts: number; meta: number }> {
  if (params.confirmation !== "I_UNDERSTAND_THIS_IS_IRREVERSIBLE") {
    throw new Error("clearScopedDb: confirmation string does not match");
  }
  const db = getDb(params.env, params.userId);
  const [c, m, ct, mt] = await Promise.all([
    db.conversations.where("accountId").equals(params.accountId).delete(),
    db.messages.where("accountId").equals(params.accountId).delete(),
    db.contacts.where("accountId").equals(params.accountId).delete(),
    db.meta.where("accountId").equals(params.accountId).delete(),
  ]);
  return { conversations: c, messages: m, contacts: ct, meta: mt };
}

// ── purgeExpiredRecords — intentional TTL cleanup ─────────────────────────────
// Removes records past their TTL from the specified account's cache.
// Must be called explicitly; never triggered automatically.
export async function purgeExpiredRecords(
  scope: Pick<CacheScope, "env" | "userId" | "accountId">
): Promise<{ conversations: number; messages: number; contacts: number }> {
  const db = getDb(scope.env, scope.userId);
  const now = Date.now();
  const [c, m, ct] = await Promise.all([
    db.conversations
      .where("cachedAt").below(now - TTL_CONVERSATIONS_MS)
      .filter((r) => r.accountId === scope.accountId)
      .delete(),
    db.messages
      .where("cachedAt").below(now - TTL_MESSAGES_MS)
      .filter((r) => r.accountId === scope.accountId)
      .delete(),
    db.contacts
      .where("cachedAt").below(now - TTL_CONTACTS_MS)
      .filter((r) => r.accountId === scope.accountId)
      .delete(),
  ]);
  return { conversations: c, messages: m, contacts: ct };
}

// ── Conversation helpers ──────────────────────────────────────────────────────

// Returns non-expired, non-stale conversations for the given (accountId, status).
// Stale rows remain in the DB but are excluded from normal display.
export async function getConversationsFromCache(
  scope: Pick<CacheScope, "env" | "userId" | "accountId">,
  status: string
): Promise<CachedConversation[]> {
  const db = getDb(scope.env, scope.userId);
  const rows = await db.conversations
    .where("[accountId+status+last_activity_at]")
    .between(
      [scope.accountId, status, Dexie.minKey],
      [scope.accountId, status, Dexie.maxKey]
    )
    .reverse()
    .toArray();
  return rows.filter((r) => !isExpired(r.cachedAt, TTL_CONVERSATIONS_MS) && !r.stale);
}

// Alias — explicit name for places that need only active (non-stale) conversations.
export const getActiveCachedConversations = getConversationsFromCache;

// Returns stale conversations preserved in the DB for the given (accountId, status).
export async function getStaleCachedConversations(
  scope: Pick<CacheScope, "env" | "userId" | "accountId">,
  status: string
): Promise<CachedConversation[]> {
  const db = getDb(scope.env, scope.userId);
  const rows = await db.conversations
    .where("[accountId+status+last_activity_at]")
    .between(
      [scope.accountId, status, Dexie.minKey],
      [scope.accountId, status, Dexie.maxKey]
    )
    .reverse()
    .toArray();
  return rows.filter((r) => r.stale === true && !isExpired(r.cachedAt, TTL_CONVERSATIONS_MS));
}

export async function upsertConversations(
  scope: Pick<CacheScope, "env" | "userId" | "accountId">,
  convs: unknown[]
): Promise<void> {
  if (!convs.length) return;
  const db = getDb(scope.env, scope.userId);
  const now = Date.now();
  await db.conversations.bulkPut(
    (convs as any[]).map((c) => ({
      accountId: scope.accountId,
      id: c.id as number,
      status: (c.status as string) ?? "open",
      last_activity_at: (c.last_activity_at as number) ?? 0,
      data: c,
      cachedAt: now,
      // Confirmed present in this sync — clear any previous stale mark.
      stale: false,
      lastSeenAt: now,
    }))
  );
}

// ── merge: add/update without removing anything ───────────────────────────────
export async function mergeScopedConversations(
  scope: Pick<CacheScope, "env" | "userId" | "accountId">,
  convs: unknown[]
): Promise<void> {
  await upsertConversations(scope, convs);
}

// ── markMissingConversationsStale ─────────────────────────────────────────────
// Marks conversations NOT in confirmedIds as stale=true for (accountId, status).
// Never deletes records. Reason defaults to "not_returned" — we don't know why
// the API stopped returning the conversation (resolved, moved, deleted, etc.).
// Scope is limited to (accountId + status) — never touches other statuses or accounts.
export async function markMissingConversationsStale(
  scope: Pick<CacheScope, "env" | "userId" | "accountId">,
  status: string,
  confirmedIds: Set<number>
): Promise<number> {
  const db = getDb(scope.env, scope.userId);
  const existing = await db.conversations
    .where("[accountId+status+last_activity_at]")
    .between(
      [scope.accountId, status, Dexie.minKey],
      [scope.accountId, status, Dexie.maxKey]
    )
    .toArray();

  const toMark = existing.filter((r) => !confirmedIds.has(r.id) && !r.stale);
  if (toMark.length === 0) return 0;

  const now = Date.now();
  await db.conversations.bulkPut(
    toMark.map((r) => ({
      ...r,
      stale: true,
      staleReason: "not_returned" as const,
      inaccessibleAt: r.inaccessibleAt ?? now,
    }))
  );
  return toMark.length;
}

// ── replace: soft-delete missing rows, then upsert confirmed ──────────────────
// Rows absent from confirmedIds are marked stale (not deleted).
// Rows present in confirmedIds are upserted with stale=false.
// Scope is limited to (accountId + status) — never touches other statuses or accounts.
export async function replaceScopedConversations(
  scope: Pick<CacheScope, "env" | "userId" | "accountId">,
  status: string,
  confirmedIds: Set<number>,
  convs: unknown[]
): Promise<void> {
  await markMissingConversationsStale(scope, status, confirmedIds);
  await upsertConversations(scope, convs);
}

// ── Message helpers ───────────────────────────────────────────────────────────

// Returns non-expired, non-stale messages for the given (accountId, conversationId).
// Stale rows remain in the DB but are excluded from normal display.
export async function getMessagesFromCache(
  scope: Pick<CacheScope, "env" | "userId" | "accountId">,
  conversationId: number
): Promise<CachedMessage[]> {
  const db = getDb(scope.env, scope.userId);
  const rows = await db.messages
    .where("[accountId+conversationId+created_at]")
    .between(
      [scope.accountId, conversationId, Dexie.minKey],
      [scope.accountId, conversationId, Dexie.maxKey]
    )
    .toArray();
  return rows.filter((r) => !isExpired(r.cachedAt, TTL_MESSAGES_MS) && !r.stale);
}

// Alias — explicit name for places that need only active (non-stale) messages.
export const getActiveMessagesFromCache = getMessagesFromCache;

export async function upsertMessages(
  scope: Pick<CacheScope, "env" | "userId" | "accountId">,
  msgs: unknown[],
  conversationId: number
): Promise<void> {
  if (!msgs.length) return;
  const db = getDb(scope.env, scope.userId);
  const now = Date.now();
  await db.messages.bulkPut(
    (msgs as any[]).map((m) => ({
      accountId: scope.accountId,
      conversationId,
      id: m.id as number,
      created_at: (m.created_at as number) ?? 0,
      data: m,
      cachedAt: now,
      // Confirmed present — clear any previous stale mark.
      stale: false,
      lastSeenAt: now,
    }))
  );
}

/**
 * Marca uma mensagem como stale (soft-delete).
 * Nunca apaga o registro do IndexedDB — apenas sinaliza que ele não deve ser exibido.
 * Usado ao receber evento `message_deleted` do Realtime.
 */
export async function markMessageStale(
  scope: Pick<CacheScope, "env" | "userId" | "accountId">,
  conversationId: number,
  messageId: number,
  reason: CachedMessage["staleReason"] = "deleted_remotely"
): Promise<void> {
  const db = getDb(scope.env, scope.userId);
  const existing = await db.messages.get([scope.accountId, conversationId, messageId]);
  if (!existing) return; // não está no cache — nada a fazer
  await db.messages.put({
    ...existing,
    stale: true,
    staleReason: reason,
    deletedAt: Date.now(),
  });
}

// ── Contact helpers ───────────────────────────────────────────────────────────

export async function getContactFromCache(
  scope: Pick<CacheScope, "env" | "userId" | "accountId">,
  phone: string
): Promise<CachedContact | null> {
  const db = getDb(scope.env, scope.userId);
  const row = await db.contacts.get([scope.accountId, phone]);
  if (!row) return null;
  if (isExpired(row.cachedAt, TTL_CONTACTS_MS)) return null; // expired — don't serve
  return row;
}

export async function upsertContact(
  scope: Pick<CacheScope, "env" | "userId" | "accountId">,
  phone: string,
  hubspot_owner_id: string | null
): Promise<void> {
  const db = getDb(scope.env, scope.userId);
  await db.contacts.put({ accountId: scope.accountId, phone, hubspot_owner_id, cachedAt: Date.now() });
}

export async function upsertContactsBatch(
  scope: Pick<CacheScope, "env" | "userId" | "accountId">,
  rows: Array<{ phone: string; hubspot_owner_id: string | null }>
): Promise<void> {
  if (!rows.length) return;
  const db = getDb(scope.env, scope.userId);
  await db.contacts.bulkPut(
    rows.map((r) => ({ accountId: scope.accountId, phone: r.phone, hubspot_owner_id: r.hubspot_owner_id, cachedAt: Date.now() }))
  );
}

// ── Meta helpers ──────────────────────────────────────────────────────────────

export async function getSyncMeta(
  scope: Pick<CacheScope, "env" | "userId" | "accountId">,
  key: string
): Promise<number> {
  const db = getDb(scope.env, scope.userId);
  const row = await db.meta.get([scope.accountId, key]);
  return (row?.value as number) ?? 0;
}

export async function setSyncMeta(
  scope: Pick<CacheScope, "env" | "userId" | "accountId">,
  key: string,
  value: unknown
): Promise<void> {
  const db = getDb(scope.env, scope.userId);
  await db.meta.put({ accountId: scope.accountId, key, value });
}

// ── Legacy DB — read-only access via raw IDBDatabase ─────────────────────────
// Never uses Dexie. Never writes. Never deletes. Never upgrades.

async function openRawLegacyDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: IDBDatabase | null) => {
      if (!settled) { settled = true; resolve(v); }
    };

    const req = indexedDB.open(LEGACY_DB_NAME);

    req.onsuccess = () => settle(req.result);
    req.onerror = () => settle(null);

    // onupgradeneeded fires when DB doesn't exist (newVersion becomes 1).
    // Abort the transaction immediately — we must not create the legacy DB.
    req.onupgradeneeded = (e) => {
      try { (e as IDBVersionChangeEvent & { target: IDBOpenDBRequest }).target.transaction?.abort(); } catch {}
      settle(null);
    };

    setTimeout(() => settle(null), 3_000);
  });
}

async function readAllFromStore(db: IDBDatabase, storeName: string): Promise<unknown[]> {
  if (!db.objectStoreNames.contains(storeName)) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

// Inventory: counts records and identifies ambiguous ones (missing accountId).
// Reads only. No writes. No deletes.
export async function inventoryLegacyDb(): Promise<LegacyMigrationReport> {
  const report: LegacyMigrationReport = {
    legacyDatabaseFound: false,
    conversationsFound: 0,
    messagesFound: 0,
    contactsFound: 0,
    metaFound: 0,
    migrated: 0,
    skippedAmbiguous: 0,
    skippedInvalid: 0,
    errors: [],
  };

  const db = await openRawLegacyDb();
  if (!db) return report;

  report.legacyDatabaseFound = true;

  const [convs, msgs, contacts, meta] = await Promise.all([
    readAllFromStore(db, "conversations"),
    readAllFromStore(db, "messages"),
    readAllFromStore(db, "contacts"),
    readAllFromStore(db, "meta"),
  ]);

  report.conversationsFound = convs.length;
  report.messagesFound = msgs.length;
  report.contactsFound = contacts.length;
  report.metaFound = meta.length;

  // Old schema had no accountId — every record is ambiguous
  for (const c of convs) {
    const rec = c as any;
    if (!rec.accountId) {
      report.skippedAmbiguous++;
      report.errors.push({
        entity: "conversation",
        legacyKey: String(rec.id ?? "unknown"),
        reason: "missing accountId — cannot determine tenant",
      });
    }
  }
  for (const m of msgs) {
    const rec = m as any;
    if (!rec.accountId) {
      report.skippedAmbiguous++;
      report.errors.push({
        entity: "message",
        legacyKey: String(rec.id ?? "unknown"),
        reason: "missing accountId — cannot determine tenant",
      });
    }
  }

  db.close();
  return report;
}

// openLegacyDbReadOnly: returns a handle for audit/recovery purposes only.
// Callers MUST NOT write, delete, or upgrade through this handle.
export async function openLegacyDbReadOnly(): Promise<{
  found: boolean;
  storeNames: string[];
  readStore: (name: string) => Promise<unknown[]>;
  close: () => void;
}> {
  const db = await openRawLegacyDb();
  if (!db) {
    return { found: false, storeNames: [], readStore: async () => [], close: () => {} };
  }
  return {
    found: true,
    storeNames: Array.from(db.objectStoreNames),
    readStore: (name: string) => readAllFromStore(db, name),
    close: () => db.close(),
  };
}
