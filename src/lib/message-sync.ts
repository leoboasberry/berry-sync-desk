// ── message-sync.ts ───────────────────────────────────────────────────────────
// Cache-first message sync — mirrors the structure of conversation-sync.ts.
//
// Flow:
//   1. Serve IndexedDB cache immediately (onCacheLoaded)
//   2. Fetch from Chatwoot API
//   3. Field-by-field merge with existing cache
//   4. Write merged result to IndexedDB
//   5. Call onComplete with network data

import {
  type CacheScope,
  getActiveMessagesFromCache,
  upsertMessages,
} from "./db";
import { isValidMessagePayload, mergeMessagePayload } from "./message-merge";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MessageFetchResult = {
  msgs: unknown[];
  can_reply: boolean;
};

export type MessageSyncCallbacks = {
  // Fired immediately with cached data — before any network call.
  // canReply is null at this stage (not yet known from cache).
  onCacheLoaded?: (msgs: unknown[]) => void;
  // Fired after network fetch, merge, and DB write.
  onComplete?: (msgs: unknown[], canReply: boolean) => void;
};

export type MessageSyncParams = {
  scope: CacheScope;
  conversationId: number;
  fetchMessages: (signal: AbortSignal) => Promise<MessageFetchResult>;
  signal: AbortSignal;
  // Extra guard checked at every await point. Return false to abort.
  isStillCurrent?: () => boolean;
  callbacks: MessageSyncCallbacks;
  // Injected write fn — replaces upsertMessages for testing only.
  _writeMessages?: (
    scope: CacheScope,
    msgs: unknown[],
    conversationId: number
  ) => Promise<void>;
};

// ── stale check helper ────────────────────────────────────────────────────────

function isStale(params: Pick<MessageSyncParams, "signal" | "isStillCurrent">): boolean {
  if (params.signal.aborted) return true;
  if (params.isStillCurrent && !params.isStillCurrent()) return true;
  return false;
}

// ── syncMessages ─────────────────────────────────────────────────────────────
// Orchestrates cache-first + network sync for a single conversation's messages.
// Preserves B08 semantics: callers must pass a correct isStillCurrent closure.

export async function syncMessages(params: MessageSyncParams): Promise<void> {
  const { scope, conversationId, fetchMessages, callbacks } = params;

  // ── Step 1: Serve IndexedDB cache immediately ─────────────────────────────
  let cachedRows: Awaited<ReturnType<typeof getActiveMessagesFromCache>> = [];
  try {
    if (!isStale(params)) {
      cachedRows = await getActiveMessagesFromCache(scope, conversationId);
      if (!isStale(params) && cachedRows.length > 0) {
        callbacks.onCacheLoaded?.(cachedRows.map((r) => r.data));
      }
    }
  } catch {
    // IndexedDB unavailable — proceed to network silently.
    // cachedRows stays empty; merge will just use incoming data.
  }

  if (isStale(params)) return;

  // ── Step 2: Fetch from network ────────────────────────────────────────────
  let result: MessageFetchResult;
  try {
    result = await fetchMessages(params.signal);
  } catch {
    // Network error — preserve whatever is in cache; stop cleanly.
    return;
  }

  if (isStale(params)) return;

  // ── Step 3: Validate and merge ────────────────────────────────────────────
  const incoming = (result.msgs as unknown[]).filter(isValidMessagePayload) as Record<
    string,
    unknown
  >[];

  // Build an id→cached-payload map from the initial cache read.
  // Used for field-level merge so a richer cached record is never overwritten
  // by a partial incoming payload.
  const existingById = new Map<number, Record<string, unknown>>(
    cachedRows.map((r) => [r.id, r.data as Record<string, unknown>])
  );

  const merged = incoming.map((m) =>
    mergeMessagePayload(existingById.get(m.id as number) ?? null, m)
  );

  // ── Step 4: Write to IndexedDB ────────────────────────────────────────────
  const writeFn = params._writeMessages ?? upsertMessages;
  try {
    if (merged.length > 0) {
      await writeFn(scope, merged, conversationId);
    }
  } catch {
    // Write failed — render from network data anyway (see onComplete below).
  }

  // ── Step 5: Notify caller with network data ───────────────────────────────
  if (!isStale(params)) {
    callbacks.onComplete?.(incoming, result.can_reply);
  }
}
