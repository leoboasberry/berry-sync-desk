import {
  type CacheScope,
  getConversationsFromCache,
  mergeScopedConversations,
  replaceScopedConversations,
} from "./db";
import { type CacheLifecycle } from "./cache-lifecycle";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PageResult = {
  convs: unknown[];
  total: number;
  retryAfterMs?: number; // non-zero when server returned 429
};

export type SyncCallbacks = {
  onCacheLoaded?: (convs: unknown[]) => void;
  onPageLoaded?: (convs: unknown[], progress: number) => void;
  onComplete?: (convs: unknown[], complete: boolean) => void;
};

export type SyncParams = {
  scope: CacheScope;
  status: string;
  lifecycle?: CacheLifecycle | null;
  fetchPage: (page: number, signal: AbortSignal) => Promise<PageResult>;
  signal: AbortSignal;
  generation: number;
  generationRef: { current: number };
  callbacks: SyncCallbacks;
  // Extra guard called immediately before the DB write transaction starts.
  // Returns false → skip the write (generation already changed between the
  // last stale-check and the actual transaction).
  isStillCurrent?: () => boolean;
};

// ── isValidConversation — minimal payload guard before DB write ───────────────

function isValidConversation(c: unknown): boolean {
  if (!c || typeof c !== "object") return false;
  const id = (c as Record<string, unknown>).id;
  return typeof id === "number" && Number.isFinite(id) && id > 0;
}

// ── stale check ───────────────────────────────────────────────────────────────

function isGenerationStale(params: Pick<SyncParams, "generation" | "generationRef">): boolean {
  return params.generation !== params.generationRef.current;
}

// ── syncConversations — orchestrates cache-first + paginated network sync ─────

export async function syncConversations(params: SyncParams): Promise<void> {
  const { scope, status, lifecycle, fetchPage, signal, callbacks } = params;

  // 1. Serve cache immediately (before any network call)
  try {
    if (!signal.aborted && !isGenerationStale(params)) {
      const cached = await getConversationsFromCache(scope, status);
      if (!signal.aborted && !isGenerationStale(params) && cached.length > 0) {
        callbacks.onCacheLoaded?.(cached.map((r) => r.data));
      }
    }
  } catch {
    // DB unavailable — proceed to network silently
  }

  // 2. Run network sync inside the distributed lock (one tab at a time)
  const runSync = async () => {
    if (signal.aborted || isGenerationStale(params)) return;

    const allFetched: unknown[] = [];
    let page = 1;
    let total = 0;
    let loaded = 0;
    let complete = false;

    while (true) {
      if (signal.aborted || isGenerationStale(params)) return;

      let result: PageResult;
      try {
        result = await fetchPage(page, signal);
      } catch {
        // Network error — keep whatever was in cache, abort sync cleanly
        return;
      }

      if (signal.aborted || isGenerationStale(params)) return;

      // 429: wait and retry this page
      if (result.retryAfterMs && result.retryAfterMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, result.retryAfterMs);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        if (signal.aborted || isGenerationStale(params)) return;
        continue; // retry same page
      }

      if (page === 1) total = result.total;

      // Filter invalid payloads before accumulating
      const valid = (result.convs as unknown[]).filter(isValidConversation);
      allFetched.push(...valid);
      loaded += result.convs.length;

      const progress = total > 0 ? Math.round((loaded / total) * 100) : 100;
      callbacks.onPageLoaded?.(allFetched.slice(), Math.min(progress, 99));

      if (result.convs.length < 25) {
        complete = true;
        break;
      }
      page++;
    }

    if (signal.aborted || isGenerationStale(params)) return;

    // Extra guard immediately before the DB write: if the caller's scope is
    // no longer current (tab/account/user changed between the last check and
    // now), skip the write. The scope itself is always correct (captured at
    // effect start), but we avoid unnecessary writes for stale requests.
    if (params.isStillCurrent && !params.isStillCurrent()) return;

    // 3. Write to IndexedDB (merge or soft-replace)
    try {
      if (complete) {
        const confirmedIds = new Set(
          allFetched
            .filter(isValidConversation)
            .map((c) => (c as Record<string, unknown>).id as number)
        );
        // replaceScopedConversations now marks missing rows stale (never deletes).
        await replaceScopedConversations(scope, status, confirmedIds, allFetched);
      } else {
        await mergeScopedConversations(scope, allFetched);
      }
    } catch {
      // Write failed — render from network data anyway (see onComplete below)
    }

    if (!signal.aborted && !isGenerationStale(params)) {
      callbacks.onComplete?.(allFetched, complete);
    }
  };

  if (lifecycle) {
    await lifecycle.runWithSyncLock(`convs:${status}`, runSync, { signal });
  } else {
    await runSync();
  }
}
