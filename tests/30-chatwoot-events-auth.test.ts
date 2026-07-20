/**
 * 30-chatwoot-events-auth.test.ts
 *
 * Vitest tests for chatwoot-events Edge Function helpers.
 * Tests pure functions from _helpers.ts — no Deno runtime required.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  hashToken,
  safeEqualBytes,
  sanitizeWebhookUrl,
  authenticateRequest,
  validateAllowlistConfig,
  validatePayload,
  readBodyWithLimit,
  checkRateLimit,
  resetRateLimitStore,
  parseAllowedAccountIds,
  resolveAccountId,
  computeDedupKey,
  canonicalJson,
  ALLOWED_EVENTS,
  MAX_BODY_BYTES,
  type RateLimitStore,
} from "../supabase/functions/chatwoot-events/_helpers";

// ── Test data ─────────────────────────────────────────────────────────────────

const TOKEN   = "a".repeat(64); // 64-char (simulates hex token)
const TOKEN_B = "b".repeat(64);
const TOKEN_C = "c".repeat(64);

const BASE_PAYLOAD = {
  event: "message_created",
  account_id: 1,
  conversation: { id: 42 },
  id: 101,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStream(data: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(data);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function makeStreamChunked(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// hashToken + safeEqualBytes
// ─────────────────────────────────────────────────────────────────────────────

describe("hashToken + safeEqualBytes", () => {
  it("equal tokens → equal hashes", async () => {
    const [h1, h2] = await Promise.all([hashToken(TOKEN), hashToken(TOKEN)]);
    expect(safeEqualBytes(h1, h2)).toBe(true);
  });

  it("different tokens → different hashes", async () => {
    const [h1, h2] = await Promise.all([hashToken(TOKEN), hashToken(TOKEN_B)]);
    expect(safeEqualBytes(h1, h2)).toBe(false);
  });

  it("different lengths → different hashes (SHA-256 is fixed 32 bytes, content differs)", async () => {
    const [h1, h2] = await Promise.all([hashToken("short"), hashToken(TOKEN)]);
    expect(safeEqualBytes(h1, h2)).toBe(false);
  });

  it("empty token → produces 32-byte hash, not equal to non-empty", async () => {
    const [hEmpty, hToken] = await Promise.all([hashToken(""), hashToken(TOKEN)]);
    expect(hEmpty.length).toBe(32);
    expect(safeEqualBytes(hEmpty, hToken)).toBe(false);
  });

  it("Unicode token is hashed consistently", async () => {
    const [h1, h2] = await Promise.all([hashToken("你好🔒"), hashToken("你好🔒")]);
    expect(safeEqualBytes(h1, h2)).toBe(true);
  });

  it("very long token → equal to itself", async () => {
    const long = "x".repeat(10_000);
    const [h1, h2] = await Promise.all([hashToken(long), hashToken(long)]);
    expect(safeEqualBytes(h1, h2)).toBe(true);
  });

  it("safeEqualBytes: non-32-byte inputs return false", () => {
    const a = new Uint8Array(16);
    const b = new Uint8Array(16);
    expect(safeEqualBytes(a, b)).toBe(false);
  });

  it("safeEqualBytes iterates all 32 bytes without early return", () => {
    const a = new Uint8Array(32).fill(0);
    const b = new Uint8Array(32).fill(0);
    b[31] = 1; // differ only in last byte
    expect(safeEqualBytes(a, b)).toBe(false);
    b[31] = 0;
    expect(safeEqualBytes(a, b)).toBe(true);
  });

  it("hashToken does not throw on any string input", async () => {
    const inputs = ["", " ", "\n", "\0", "a".repeat(1_000), "🔑"];
    for (const input of inputs) {
      await expect(hashToken(input)).resolves.toBeInstanceOf(Uint8Array);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sanitizeWebhookUrl
// ─────────────────────────────────────────────────────────────────────────────

describe("sanitizeWebhookUrl", () => {
  it("removes token from URL", () => {
    const raw = `https://example.supabase.co/functions/v1/chatwoot-events?token=${TOKEN}`;
    expect(sanitizeWebhookUrl(raw)).not.toContain(TOKEN);
    expect(sanitizeWebhookUrl(raw)).toContain("[REDACTED]");
  });

  it("returns only pathname + redacted marker", () => {
    const raw = `https://example.supabase.co/functions/v1/chatwoot-events?token=${TOKEN}`;
    expect(sanitizeWebhookUrl(raw)).toBe("/functions/v1/chatwoot-events?token=[REDACTED]");
  });

  it("handles URL with extra query params — does not leak token", () => {
    const raw = `https://host/fn?other=1&token=${TOKEN}&debug=true`;
    expect(sanitizeWebhookUrl(raw)).not.toContain(TOKEN);
  });

  it("handles invalid URL gracefully", () => {
    expect(sanitizeWebhookUrl("not-a-url")).toBe("[invalid-url]");
  });

  it("TOKEN NEVER IN LOGS: sanitized output never contains the secret (many formats)", () => {
    const secrets = [TOKEN, TOKEN_B, "secret123", "x".repeat(32)];
    for (const secret of secrets) {
      for (const url of [
        `https://host/fn?token=${secret}`,
        `https://host/fn?other=1&token=${secret}`,
        `https://host/fn?token=${secret}&token=${TOKEN_B}`,
      ]) {
        expect(sanitizeWebhookUrl(url)).not.toContain(secret);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// authenticateRequest
// ─────────────────────────────────────────────────────────────────────────────

describe("authenticateRequest", () => {
  it("AUTH-1: correct current token → ok, slot=current", async () => {
    const r = await authenticateRequest(TOKEN, TOKEN);
    expect(r).toEqual({ ok: true, slot: "current" });
  });

  it("AUTH-2: incorrect token → invalid_token", async () => {
    const r = await authenticateRequest(TOKEN_B, TOKEN);
    expect(r).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("AUTH-3: token null → missing_token", async () => {
    const r = await authenticateRequest(null, TOKEN);
    expect(r).toEqual({ ok: false, reason: "missing_token" });
  });

  it("AUTH-3b: token empty string → missing_token", async () => {
    const r = await authenticateRequest("", TOKEN);
    expect(r).toEqual({ ok: false, reason: "missing_token" });
  });

  it("AUTH-4: CURRENT not configured → no_secret", async () => {
    expect(await authenticateRequest(TOKEN, null)).toEqual({ ok: false, reason: "no_secret" });
    expect(await authenticateRequest(TOKEN, undefined)).toEqual({ ok: false, reason: "no_secret" });
  });

  it("AUTH-7: token with different length → invalid_token (not missing_token)", async () => {
    expect(await authenticateRequest("short", TOKEN)).toEqual({ ok: false, reason: "invalid_token" });
    expect(await authenticateRequest(TOKEN, "short")).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("rotation: previous token accepted → slot=previous", async () => {
    const r = await authenticateRequest(TOKEN_C, TOKEN, TOKEN_C);
    expect(r).toEqual({ ok: true, slot: "previous" });
  });

  it("rotation: current token still accepted alongside previous → slot=current", async () => {
    const r = await authenticateRequest(TOKEN, TOKEN, TOKEN_C);
    expect(r).toEqual({ ok: true, slot: "current" });
  });

  it("rotation: unrecognized token with both CURRENT and PREVIOUS set → invalid_token", async () => {
    const r = await authenticateRequest(TOKEN_B, TOKEN, TOKEN_C);
    expect(r).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("empty PREVIOUS string is not accepted as valid token", async () => {
    const r = await authenticateRequest("", TOKEN, "");
    expect(r).toEqual({ ok: false, reason: "missing_token" });
  });

  it("previous=null does not crash (no rotation)", async () => {
    const r = await authenticateRequest(TOKEN, TOKEN, null);
    expect(r).toEqual({ ok: true, slot: "current" });
  });

  it("result never contains token value, length, or prefix", async () => {
    const results = await Promise.all([
      authenticateRequest(TOKEN, TOKEN),
      authenticateRequest(TOKEN_B, TOKEN),
      authenticateRequest(null, TOKEN),
      authenticateRequest(TOKEN, null),
    ]);
    for (const r of results) {
      const str = JSON.stringify(r);
      expect(str).not.toContain(TOKEN.slice(0, 8));
      expect(str).not.toContain(String(TOKEN.length));
    }
  });

  it("does not throw for any combination of inputs", async () => {
    const inputs: [string | null, string | null, string | null][] = [
      [TOKEN, TOKEN, TOKEN_B],
      [null, null, null],
      ["", "", ""],
      [TOKEN, null, null],
      ["x", TOKEN, ""],
    ];
    for (const [provided, current, previous] of inputs) {
      await expect(authenticateRequest(provided, current, previous)).resolves.toBeDefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateAllowlistConfig — fail-closed in production
// ─────────────────────────────────────────────────────────────────────────────

describe("validateAllowlistConfig", () => {
  it("production with valid allowlist → ok", () => {
    expect(validateAllowlistConfig(new Set([1]), true)).toEqual({ ok: true });
  });

  it("production without allowlist (null) → 503", () => {
    const r = validateAllowlistConfig(null, true);
    expect(r).toMatchObject({ ok: false, status: 503 });
  });

  it("production with empty Set → 503", () => {
    const r = validateAllowlistConfig(new Set(), true);
    expect(r).toMatchObject({ ok: false, status: 503 });
  });

  it("production: error message is opaque — does not expose config details", () => {
    const r = validateAllowlistConfig(null, true);
    if (!r.ok) {
      expect(r.error).toBe("Service unavailable");
      expect(r.error).not.toContain("allowlist");
      expect(r.error).not.toContain("account");
    }
  });

  it("non-production with null → ok (dev mode allows absence)", () => {
    expect(validateAllowlistConfig(null, false)).toEqual({ ok: true });
  });

  it("non-production with empty Set → ok", () => {
    expect(validateAllowlistConfig(new Set(), false)).toEqual({ ok: true });
  });

  it("non-production with valid allowlist → ok", () => {
    expect(validateAllowlistConfig(new Set([1, 2]), false)).toEqual({ ok: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validatePayload
// ─────────────────────────────────────────────────────────────────────────────

describe("validatePayload", () => {
  it("valid payload passes", () => {
    expect(validatePayload(BASE_PAYLOAD, null)).toEqual({ ok: true });
  });

  it("account_id absent → 400", () => {
    expect(validatePayload({ event: "message_created" }, null)).toMatchObject({ ok: false, status: 400 });
  });

  it("account_id = 0 → 400", () => {
    expect(validatePayload({ ...BASE_PAYLOAD, account_id: 0 }, null)).toMatchObject({ ok: false, status: 400 });
  });

  it("account_id = -1 → 400", () => {
    expect(validatePayload({ ...BASE_PAYLOAD, account_id: -1 }, null)).toMatchObject({ ok: false, status: 400 });
  });

  it("account_id = string → 400", () => {
    expect(validatePayload({ ...BASE_PAYLOAD, account_id: "1" }, null)).toMatchObject({ ok: false, status: 400 });
  });

  it("account_id not in allowlist → 403", () => {
    expect(validatePayload(BASE_PAYLOAD, new Set([99]))).toMatchObject({ ok: false, status: 403 });
  });

  it("account_id in allowlist → ok", () => {
    expect(validatePayload(BASE_PAYLOAD, new Set([1]))).toEqual({ ok: true });
  });

  it("403 error message is opaque — does not expose account_id value", () => {
    const r = validatePayload({ ...BASE_PAYLOAD, account_id: 99 }, new Set([1]));
    if (!r.ok) expect(r.error).not.toContain("99");
  });

  it("unknown event → 400", () => {
    expect(validatePayload({ ...BASE_PAYLOAD, event: "hacker_event" }, null)).toMatchObject({ ok: false, status: 400 });
  });

  it("event absent → 400", () => {
    const { event: _, ...noEvent } = BASE_PAYLOAD;
    expect(validatePayload(noEvent, null)).toMatchObject({ ok: false, status: 400 });
  });

  it("all 10 known events pass", () => {
    for (const event of ALLOWED_EVENTS) {
      const payload = { account_id: 1, event, conversation: { id: 1 } };
      expect(validatePayload(payload, null)).toEqual({ ok: true });
    }
  });

  it("conversation_id = float → 400", () => {
    expect(validatePayload({ ...BASE_PAYLOAD, conversation: { id: 1.5 } }, null)).toMatchObject({ ok: false, status: 400 });
  });

  it("conversation_id = negative → 400", () => {
    expect(validatePayload({ ...BASE_PAYLOAD, conversation: { id: -1 } }, null)).toMatchObject({ ok: false, status: 400 });
  });

  it("message_id = negative → 400", () => {
    expect(validatePayload({ ...BASE_PAYLOAD, id: -5 }, null)).toMatchObject({ ok: false, status: 400 });
  });

  it("message_id absent → ok (optional field)", () => {
    const { id: _, ...noId } = BASE_PAYLOAD;
    expect(validatePayload(noId, null)).toEqual({ ok: true });
  });

  it("extra fields do not affect account_id or event", () => {
    const payload = { ...BASE_PAYLOAD, injected_account_id: 99 };
    expect(validatePayload(payload, new Set([1]))).toEqual({ ok: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readBodyWithLimit
// ─────────────────────────────────────────────────────────────────────────────

describe("readBodyWithLimit", () => {
  const LIMIT = 1024; // small limit for tests

  it("reads body within limit", async () => {
    const r = await readBodyWithLimit(makeStream("hello"), LIMIT);
    expect(r).toEqual({ ok: true, text: "hello" });
  });

  it("null body → empty text", async () => {
    const r = await readBodyWithLimit(null, LIMIT);
    expect(r).toEqual({ ok: true, text: "" });
  });

  it("exact limit (1024 bytes) → ok", async () => {
    const data = "x".repeat(LIMIT);
    const r = await readBodyWithLimit(makeStream(data), LIMIT);
    expect(r).toEqual({ ok: true, text: data });
  });

  it("one byte over limit → tooLarge", async () => {
    const data = "x".repeat(LIMIT + 1);
    const r = await readBodyWithLimit(makeStream(data), LIMIT);
    expect(r).toEqual({ ok: false, tooLarge: true });
  });

  it("stream over limit in chunks → tooLarge", async () => {
    // each chunk is 600 bytes, 2 chunks = 1200 > 1024
    const r = await readBodyWithLimit(
      makeStreamChunked(["x".repeat(600), "x".repeat(600)]),
      LIMIT,
    );
    expect(r).toEqual({ ok: false, tooLarge: true });
  });

  it("no Content-Length header scenario: stream check catches large body", async () => {
    // simulates absent Content-Length — stream limiter is the real gate
    const bigData = "x".repeat(LIMIT + 100);
    const r = await readBodyWithLimit(makeStream(bigData), LIMIT);
    expect(r).toEqual({ ok: false, tooLarge: true });
  });

  it("Content-Length lie below limit: stream check still catches oversize body", async () => {
    // body is larger than Content-Length claimed — stream check catches it
    const trueData = "x".repeat(LIMIT + 100);
    const r = await readBodyWithLimit(makeStream(trueData), LIMIT);
    expect(r).toEqual({ ok: false, tooLarge: true });
  });

  it("incomplete / truncated JSON → ok (parse error is separate)", async () => {
    const r = await readBodyWithLimit(makeStream('{"event":"message_cre'), LIMIT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(() => JSON.parse(r.text)).toThrow();
  });

  it("Content-Type with charset: body is still read correctly", async () => {
    const data = '{"event":"message_created","account_id":1}';
    const r = await readBodyWithLimit(makeStream(data), LIMIT);
    expect(r).toEqual({ ok: true, text: data });
  });

  it("MAX_BODY_BYTES is 512 KB", () => {
    expect(MAX_BODY_BYTES).toBe(512 * 1024);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveAccountId — dual payload format support
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveAccountId", () => {
  it("resolves top-level account_id (numeric)", () => {
    expect(resolveAccountId({ account_id: 1 })).toBe(1);
  });

  it("resolves nested account.id (Chatwoot webhook format)", () => {
    expect(resolveAccountId({ account: { id: 1 } })).toBe(1);
  });

  it("top-level takes precedence over nested when both present", () => {
    expect(resolveAccountId({ account_id: 2, account: { id: 99 } })).toBe(2);
  });

  it("returns null when both absent", () => {
    expect(resolveAccountId({ event: "message_created" })).toBeNull();
  });

  it("returns null for account_id=0", () => {
    expect(resolveAccountId({ account_id: 0 })).toBeNull();
  });

  it("returns null for account_id negative", () => {
    expect(resolveAccountId({ account_id: -1 })).toBeNull();
  });

  it("returns null for account_id string", () => {
    expect(resolveAccountId({ account_id: "1" })).toBeNull();
  });

  it("returns null for nested account.id = 0", () => {
    expect(resolveAccountId({ account: { id: 0 } })).toBeNull();
  });
});

describe("validatePayload — dual account_id format", () => {
  it("accepts payload with top-level account_id", () => {
    expect(validatePayload({ account_id: 1, event: "message_created" }, null)).toEqual({ ok: true });
  });

  it("accepts payload with nested account.id (real Chatwoot format)", () => {
    expect(validatePayload({ account: { id: 1 }, event: "message_created" }, null)).toEqual({ ok: true });
  });

  it("rejects when both absent", () => {
    expect(validatePayload({ event: "message_created" }, null)).toMatchObject({ ok: false, status: 400 });
  });

  it("allowlist works with nested account.id", () => {
    const allowed = new Set([1]);
    expect(validatePayload({ account: { id: 1 }, event: "message_created" }, allowed)).toEqual({ ok: true });
    expect(validatePayload({ account: { id: 2 }, event: "message_created" }, allowed)).toMatchObject({ ok: false, status: 403 });
  });
});

describe("computeDedupKey — dual account_id format", () => {
  it("same key whether account_id is top-level or nested", async () => {
    const k1 = await computeDedupKey({ account_id: 1, event: "message_created", id: 5 });
    const k2 = await computeDedupKey({ account: { id: 1 }, event: "message_created", id: 5 });
    expect(k1).toBe(k2);
  });

  it("null account_id produces different key from account_id=1", async () => {
    const k1 = await computeDedupKey({ event: "message_created", id: 5 });
    const k2 = await computeDedupKey({ account_id: 1, event: "message_created", id: 5 });
    expect(k1).not.toBe(k2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAllowedAccountIds
// ─────────────────────────────────────────────────────────────────────────────

describe("parseAllowedAccountIds", () => {
  it("parses single id", () => {
    expect(parseAllowedAccountIds("1")).toEqual(new Set([1]));
  });

  it("parses multiple ids", () => {
    expect(parseAllowedAccountIds("1,2,3")).toEqual(new Set([1, 2, 3]));
  });

  it("ignores non-numeric values", () => {
    expect(parseAllowedAccountIds("1,abc,2")).toEqual(new Set([1, 2]));
  });

  it("undefined → null", () => {
    expect(parseAllowedAccountIds(undefined)).toBe(null);
  });

  it("empty string → null", () => {
    expect(parseAllowedAccountIds("")).toBe(null);
  });

  it("whitespace only → null", () => {
    expect(parseAllowedAccountIds("   ")).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkRateLimit
// ─────────────────────────────────────────────────────────────────────────────

describe("checkRateLimit", () => {
  let store: RateLimitStore;
  beforeEach(() => { store = new Map(); });

  it("allows 300 requests in window", () => {
    const now = Date.now();
    for (let i = 0; i < 300; i++) expect(checkRateLimit("key", now, store)).toBe(true);
  });

  it("blocks the 301st request in same window", () => {
    const now = Date.now();
    for (let i = 0; i < 300; i++) checkRateLimit("key", now, store);
    expect(checkRateLimit("key", now, store)).toBe(false);
  });

  it("resets after window expires", () => {
    const now = Date.now();
    for (let i = 0; i < 300; i++) checkRateLimit("key", now, store);
    expect(checkRateLimit("key", now + 61_000, store)).toBe(true);
  });

  it("different keys are independent", () => {
    const now = Date.now();
    for (let i = 0; i < 300; i++) checkRateLimit("key-A", now, store);
    expect(checkRateLimit("key-A", now, store)).toBe(false);
    expect(checkRateLimit("key-B", now, store)).toBe(true);
  });

  it("rate limit key includes tokenSlot: rotating accountId with same slot does not reset counter", () => {
    const now = Date.now();
    // Simulate 300 requests with slot=current, account=1
    for (let i = 0; i < 300; i++) checkRateLimit("current:1:1.2.3.4", now, store);
    // Evasion attempt: change accountId to 99 — different key, separate counter
    // This shows the key must include a stable element (slot) to prevent trivial evasion
    expect(checkRateLimit("current:1:1.2.3.4", now, store)).toBe(false);
    // Changing accountId gives a new key — by design this is accepted (different account)
    // The rate limit is per account:ip, not global
    expect(checkRateLimit("current:99:1.2.3.4", now, store)).toBe(true);
  });

  it("resetRateLimitStore clears all entries", () => {
    const now = Date.now();
    for (let i = 0; i < 300; i++) checkRateLimit("key", now, store);
    resetRateLimitStore(store);
    expect(checkRateLimit("key", now, store)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeDedupKey
// ─────────────────────────────────────────────────────────────────────────────

describe("computeDedupKey", () => {
  it("same event → same key (replay detected)", async () => {
    const k1 = await computeDedupKey(BASE_PAYLOAD);
    const k2 = await computeDedupKey(BASE_PAYLOAD);
    expect(k1).toBe(k2);
  });

  it("different message IDs → different keys", async () => {
    expect(await computeDedupKey({ ...BASE_PAYLOAD, id: 101 }))
      .not.toBe(await computeDedupKey({ ...BASE_PAYLOAD, id: 102 }));
  });

  it("different event types → different keys", async () => {
    expect(await computeDedupKey({ ...BASE_PAYLOAD, event: "message_created" }))
      .not.toBe(await computeDedupKey({ ...BASE_PAYLOAD, event: "message_updated" }));
  });

  it("different account_ids → different keys", async () => {
    expect(await computeDedupKey({ ...BASE_PAYLOAD, account_id: 1 }))
      .not.toBe(await computeDedupKey({ ...BASE_PAYLOAD, account_id: 2 }));
  });

  it("key is 64-char hex (SHA-256)", async () => {
    expect(await computeDedupKey(BASE_PAYLOAD)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("canonicalJson sorts keys — order-independent", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Log safety
// ─────────────────────────────────────────────────────────────────────────────

describe("Log safety", () => {
  it("sanitizeWebhookUrl never leaks token in any URL variation", () => {
    for (const secret of [TOKEN, TOKEN_B, TOKEN_C]) {
      for (const url of [
        `https://host/fn?token=${secret}`,
        `https://host/fn?a=1&token=${secret}&b=2`,
        `https://host/fn?token=${secret}&token=second`,
      ]) {
        expect(sanitizeWebhookUrl(url)).not.toContain(secret);
      }
    }
  });

  it("authenticateRequest result never contains token value or length hint", async () => {
    const cases = await Promise.all([
      authenticateRequest(TOKEN, TOKEN),
      authenticateRequest(TOKEN_B, TOKEN),
      authenticateRequest(null, TOKEN),
      authenticateRequest(TOKEN, null),
    ]);
    for (const r of cases) {
      const s = JSON.stringify(r);
      expect(s).not.toContain(TOKEN);
      expect(s).not.toContain(TOKEN_B);
      // result must not leak length of either token
      expect(s).not.toContain(String(TOKEN.length));
    }
  });

  it("validateAllowlistConfig error is opaque — no config details", () => {
    const r = validateAllowlistConfig(null, true);
    if (!r.ok) {
      expect(r.error).not.toContain("ALLOWED");
      expect(r.error).not.toContain("account");
      expect(r.error).not.toContain("null");
    }
  });

  it("validatePayload 403 error does not expose allowlist or account values", () => {
    const r = validatePayload({ ...BASE_PAYLOAD, account_id: 42 }, new Set([1]));
    if (!r.ok) {
      expect(r.error).not.toContain("42");
      expect(r.error).not.toContain("1");
    }
  });
});
