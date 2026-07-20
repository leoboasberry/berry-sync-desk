// ── message-merge.ts ─────────────────────────────────────────────────────────
// Field-by-field merge rules for cached Chatwoot message payloads.
// Never uses { ...existing, ...incoming } wholesale — a partial incoming
// payload must NOT overwrite richer existing data.
//
// Isolation: callers must already have verified that (accountId, conversationId,
// messageId) match between existing and incoming before calling these helpers.

// ── Delivery status ordering: higher rank = more final ───────────────────────

const STATUS_RANK: Record<string, number> = {
  failed: 4,
  read: 3,
  delivered: 2,
  sent: 1,
};

function bestDeliveryStatus(a: unknown, b: unknown): unknown {
  const ra = STATUS_RANK[String(a ?? "")] ?? 0;
  const rb = STATUS_RANK[String(b ?? "")] ?? 0;
  if (rb > ra) return b;
  if (ra > rb) return a;
  // Same rank — prefer non-null
  return a ?? b;
}

// ── Attachment merge: prefer the array with more items ────────────────────────

function mergeAttachments(existing: unknown, incoming: unknown): unknown {
  const ea = Array.isArray(existing) ? existing : null;
  const ia = Array.isArray(incoming) ? incoming : null;
  if (!ea && !ia) return existing ?? incoming;
  if (!ea) return ia;
  if (!ia) return ea;
  // Both present: prefer the more complete array (more items = more information)
  return ia.length >= ea.length ? ia : ea;
}

// ── content_attributes: deep merge preserving existing sub-objects ────────────

function mergeContentAttributes(existing: unknown, incoming: unknown): unknown {
  if (!existing || typeof existing !== "object") return incoming ?? existing;
  if (!incoming || typeof incoming !== "object") return existing;
  // Incoming wins per top-level key; existing sub-objects not in incoming are kept.
  return { ...(existing as object), ...(incoming as object) };
}

// ── Timestamp helpers ─────────────────────────────────────────────────────────

function minTimestamp(a: unknown, b: unknown): unknown {
  const ta = typeof a === "number" && a > 0 ? a : null;
  const tb = typeof b === "number" && b > 0 ? b : null;
  if (ta === null) return tb;
  if (tb === null) return ta;
  return Math.min(ta, tb);
}

function maxTimestamp(a: unknown, b: unknown): unknown {
  const ta = typeof a === "number" && a > 0 ? a : null;
  const tb = typeof b === "number" && b > 0 ? b : null;
  if (ta === null) return tb ?? undefined;
  if (tb === null) return ta;
  return Math.max(ta, tb);
}

// ── isValidMessagePayload ─────────────────────────────────────────────────────
// Minimal guard before any DB write. A message must have a positive numeric id.

export function isValidMessagePayload(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return typeof m.id === "number" && Number.isFinite(m.id) && m.id > 0;
}

// ── mergeMessagePayload ───────────────────────────────────────────────────────
// Returns the best combination of existing (from cache) and incoming (from API).
// If existing is null (first write), returns incoming unchanged.
//
// Rules — by field:
//   content           prefer non-null, non-empty incoming; else keep existing
//   attachments       prefer the array with more items
//   sender            prefer non-null incoming; else keep existing
//   status            prefer more advanced delivery status
//   content_attributes deep merge; existing sub-objects kept if not overridden
//   created_at        min (timestamps cannot go backward)
//   message_type      incoming wins if not undefined/null
//   content_type      incoming wins if not undefined/null
//   private           once true, stays true (private never becomes public)
//   source_id         prefer non-null incoming; else existing
//   updated_at        max (prefer most recent)
//   id                always incoming (authoritative)
//   conversation_id   always incoming (authoritative)

export function mergeMessagePayload(
  existing: Record<string, unknown> | null,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  if (!existing) return incoming;

  return {
    // Start with existing as the base so unknown fields are preserved
    ...existing,

    // Authoritative fields — incoming always wins
    id: incoming.id,
    conversation_id: incoming.conversation_id ?? existing.conversation_id,

    // content: prefer non-null, non-empty incoming
    content:
      incoming.content !== null && incoming.content !== undefined && incoming.content !== ""
        ? incoming.content
        : existing.content,

    // attachments: prefer the more complete array
    attachments: mergeAttachments(existing.attachments, incoming.attachments),

    // sender: prefer non-null incoming
    sender: incoming.sender != null ? incoming.sender : existing.sender,

    // delivery status: prefer more advanced / final
    status: bestDeliveryStatus(existing.status, incoming.status),

    // content_attributes: deep merge — preserve existing whatsapp/sub-objects
    content_attributes: mergeContentAttributes(
      existing.content_attributes,
      incoming.content_attributes
    ),

    // created_at: keep earliest — timestamps can't go backward
    created_at: minTimestamp(existing.created_at, incoming.created_at),

    // message_type: incoming wins when defined
    message_type:
      incoming.message_type !== undefined && incoming.message_type !== null
        ? incoming.message_type
        : existing.message_type,

    // content_type: incoming wins when defined
    content_type:
      incoming.content_type !== undefined && incoming.content_type !== null
        ? incoming.content_type
        : existing.content_type,

    // private: once true, permanently true (private messages never become public)
    private: existing.private === true ? true : (incoming.private ?? existing.private),

    // source_id: prefer non-null incoming
    source_id: incoming.source_id != null ? incoming.source_id : existing.source_id,

    // updated_at: prefer most recent timestamp
    updated_at: maxTimestamp(existing.updated_at, incoming.updated_at),
  };
}
