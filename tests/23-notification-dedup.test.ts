/**
 * Tests 23 — Deduplicação de notificações (som + push)
 *
 * Cobre: mesmo evento não emite duas notificações; eventos diferentes com
 * mesmo conteúdo mas messageId diferente passam; janela expira corretamente.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  shouldNotify,
  clearAllNotifState,
  clearNotifEntry,
  _testSeenSize,
} from "@/lib/notification-dedup";

beforeEach(() => {
  clearAllNotifState();
  vi.useRealTimers();
});

describe("ND-1 — Mesmo evento não emite duas notificações", () => {
  it("primeiro shouldNotify → true; segundo com mesmo key → false", () => {
    const key = { accountId: 1, eventType: "message_created", messageId: 42 };
    expect(shouldNotify(key)).toBe(true);
    expect(shouldNotify(key)).toBe(false);
  });

  it("terceira chamada com mesmo key → false", () => {
    const key = { accountId: 1, eventType: "message_created", messageId: 100 };
    expect(shouldNotify(key)).toBe(true);
    expect(shouldNotify(key)).toBe(false);
    expect(shouldNotify(key)).toBe(false);
  });
});

describe("ND-2 — Eventos diferentes passam mesmo com conteúdo igual", () => {
  it("mesmo conteúdo mas messageId 10 vs 11 → ambos passam", () => {
    const k1 = { accountId: 1, eventType: "message_created", messageId: 10 };
    const k2 = { accountId: 1, eventType: "message_created", messageId: 11 };
    expect(shouldNotify(k1)).toBe(true);
    expect(shouldNotify(k2)).toBe(true); // ID diferente → não é duplicata
  });

  it("accounts diferentes com mesmo messageId → independentes", () => {
    const k1 = { accountId: 1, eventType: "message_created", messageId: 42 };
    const k2 = { accountId: 2, eventType: "message_created", messageId: 42 };
    expect(shouldNotify(k1)).toBe(true);
    expect(shouldNotify(k2)).toBe(true); // conta diferente → não é duplicata
  });

  it("eventType diferente com mesmo messageId → independentes", () => {
    const k1 = { accountId: 1, eventType: "message_created", messageId: 42 };
    const k2 = { accountId: 1, eventType: "message_updated", messageId: 42 };
    expect(shouldNotify(k1)).toBe(true);
    expect(shouldNotify(k2)).toBe(true);
  });
});

describe("ND-3 — Janela de deduplicação expira", () => {
  it("após janela de 10s, o mesmo evento é aceito novamente", () => {
    vi.useFakeTimers();

    const key = { accountId: 1, eventType: "message_created", messageId: 55 };
    expect(shouldNotify(key)).toBe(true);
    expect(shouldNotify(key)).toBe(false); // dentro da janela

    vi.advanceTimersByTime(10_001); // avança além da janela
    expect(shouldNotify(key)).toBe(true); // expirou — aceito novamente
  });
});

describe("ND-4 — clearAllNotifState reseta estado entre sessões", () => {
  it("clearAllNotifState → estado limpo após logout", () => {
    const key = { accountId: 1, eventType: "message_created", messageId: 99 };
    shouldNotify(key);
    expect(_testSeenSize()).toBe(1);

    clearAllNotifState();
    expect(_testSeenSize()).toBe(0);
    expect(shouldNotify(key)).toBe(true); // aceito de novo após reset
  });
});

describe("ND-5 — clearNotifEntry para entrada específica", () => {
  it("clearNotifEntry remove somente a chave especificada", () => {
    const k1 = { accountId: 1, eventType: "message_created", messageId: 1 };
    const k2 = { accountId: 1, eventType: "message_created", messageId: 2 };
    shouldNotify(k1);
    shouldNotify(k2);
    expect(_testSeenSize()).toBe(2);

    clearNotifEntry(k1);
    expect(_testSeenSize()).toBe(1);
    expect(shouldNotify(k1)).toBe(true); // k1 foi removida
    expect(shouldNotify(k2)).toBe(false); // k2 ainda presente
  });
});

describe("ND-6 — Mensagens com messageId string (fallback sem ID numérico)", () => {
  it("messageId como string funciona como chave de deduplicação", () => {
    const k1 = { accountId: 1, eventType: "message_created", messageId: "100:1700000000" };
    const k2 = { accountId: 1, eventType: "message_created", messageId: "100:1700000000" };
    expect(shouldNotify(k1)).toBe(true);
    expect(shouldNotify(k2)).toBe(false);
  });
});
