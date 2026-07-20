/**
 * T14 — B04-C: resolveValidatedAssignee — testes GREEN
 *
 * Diferença em relação a T10:
 *   T10 = testa o código PRÉ-FIX (currentAutoAssignDecision sem validação) — PERMANECE RED
 *   T14 = testa a lógica de resolveValidatedAssignee implementada no Edge Function — DEVE SER GREEN
 *
 * A função faz 3 chamadas à API Chatwoot:
 *   1. GET /accounts/:id/agents/:agentId          → verifica se agente existe e pertence à conta
 *   2. GET /accounts/:id/conversations/:convId    → verifica se conversa existe, retorna inbox_id
 *   3. GET /accounts/:id/inbox_members/:inboxId   → verifica se agente é membro da inbox
 *
 * Todos os testes usam fetch mocado — sem chamadas reais à API.
 * DRY_RUN=true preservado.
 */

import { describe, it, expect, afterAll, vi, beforeEach } from "vitest";
import { newTrace, recordEvidence, printEvidenceSummary } from "./evidence-log";

const traceId = newTrace();
afterAll(() => printEvidenceSummary());
beforeEach(() => vi.clearAllMocks());

// ── Réplica de resolveValidatedAssignee (index.ts:86-166) ─────────────────────

async function resolveValidatedAssignee(
  chatwootBaseUrl: string,
  chatwootToken: string,
  chatwootAccountId: number | string,
  senderId: unknown,
  conversationId: unknown,
  _traceId: string
): Promise<number | null> {
  if (typeof senderId !== "number" && typeof senderId !== "string") return null;

  const agentId = Number(senderId);
  if (!Number.isInteger(agentId) || agentId <= 0) return null;

  try {
    const agentRes = await fetch(
      `${chatwootBaseUrl}/api/v1/accounts/${chatwootAccountId}/agents/${agentId}`,
      { headers: { api_access_token: chatwootToken } }
    );
    if (!agentRes.ok) return null;
    await agentRes.json(); // consume body

    const convRes = await fetch(
      `${chatwootBaseUrl}/api/v1/accounts/${chatwootAccountId}/conversations/${conversationId}`,
      { headers: { api_access_token: chatwootToken } }
    );
    if (!convRes.ok) return null;
    const conv = await convRes.json();
    const inboxId = conv.inbox_id;
    if (!inboxId) return null;

    const inboxRes = await fetch(
      `${chatwootBaseUrl}/api/v1/accounts/${chatwootAccountId}/inbox_members/${inboxId}`,
      { headers: { api_access_token: chatwootToken } }
    );
    if (inboxRes.ok) {
      const inboxData = await inboxRes.json();
      const members: Array<{ id: number }> = inboxData.payload ?? [];
      const hasAccess = members.some((m) => m.id === agentId);
      if (!hasAccess) return null;
    } else {
      return null; // fail-safe: não conseguiu verificar → rejeita
    }

    return agentId;
  } catch {
    return null;
  }
}

// ── Helpers de mock ──────────────────────────────────────────────────────────

function mockFetch(responses: Array<{ ok: boolean; body: unknown }>) {
  let callIndex = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    const resp = responses[callIndex++] ?? { ok: false, body: {} };
    return {
      ok: resp.ok,
      status: resp.ok ? 200 : 404,
      json: async () => resp.body,
    };
  }));
}

const BASE = "https://chatwoot.example.com";
const TOKEN = "test-token";
const ACCOUNT = 1;

// ── Testes ───────────────────────────────────────────────────────────────────

describe("T14 — resolveValidatedAssignee: validação real do auto-assign", () => {

  it("Agente válido, na conta correta, com acesso à inbox → retorna agentId", async () => {
    mockFetch([
      { ok: true, body: { id: 42, name: "Agente A" } },                              // GET /agents/42
      { ok: true, body: { id: 100, inbox_id: 10 } },                                 // GET /conversations/100
      { ok: true, body: { payload: [{ id: 42 }, { id: 43 }] } },                     // GET /inbox_members/10
    ]);

    const result = await resolveValidatedAssignee(BASE, TOKEN, ACCOUNT, 42, 100, traceId);
    expect(result).toBe(42);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T14-valid-agent",
      step: "Agente 42 existe, conta OK, inbox 10 OK → assignee=42",
      status: "PASS", expected: "42", actual: String(result) });
  });

  it("sender.id=99999 não existe na conta → API retorna 404 → null (sem assign)", async () => {
    mockFetch([
      { ok: false, body: { error: "Not found" } },  // GET /agents/99999 → 404
    ]);

    const result = await resolveValidatedAssignee(BASE, TOKEN, ACCOUNT, 99999, 100, traceId);
    expect(result).toBeNull();

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T14-nonexistent-agent",
      step: "sender.id=99999 → API retorna 404 → null (auto-assign não ocorre)",
      status: "PASS", expected: "null", actual: String(result) });
  });

  it("Agente de outra conta → API retorna 404 para /agents/:id → null", async () => {
    // Chatwoot: GET /accounts/1/agents/99 retorna 404 porque 99 pertence à conta 2
    mockFetch([
      { ok: false, body: { error: "Not found" } },
    ]);

    const result = await resolveValidatedAssignee(BASE, TOKEN, ACCOUNT, 99, 100, traceId);
    expect(result).toBeNull();

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T14-wrong-account",
      step: "Agente de outra conta → 404 em /agents → null",
      status: "PASS", expected: "null", actual: String(result) });
  });

  it("Agente não tem acesso à inbox da conversa → null", async () => {
    mockFetch([
      { ok: true, body: { id: 42, name: "Agente A" } },                              // agente existe
      { ok: true, body: { id: 100, inbox_id: 10 } },                                 // conversa existe
      { ok: true, body: { payload: [{ id: 43 }, { id: 44 }] } },                     // inbox_members: agente 42 NÃO está
    ]);

    const result = await resolveValidatedAssignee(BASE, TOKEN, ACCOUNT, 42, 100, traceId);
    expect(result).toBeNull();

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T14-no-inbox-access",
      step: "Agente 42 não está nos membros da inbox 10 → null",
      status: "PASS", expected: "null", actual: String(result) });
  });

  it("Conversa não pertence à conta → API retorna 404 para /conversations/:id → null", async () => {
    mockFetch([
      { ok: true, body: { id: 42 } },             // agente existe
      { ok: false, body: { error: "Not found" } }, // conversa não existe nesta conta
    ]);

    const result = await resolveValidatedAssignee(BASE, TOKEN, ACCOUNT, 42, 999, traceId);
    expect(result).toBeNull();

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T14-wrong-conversation",
      step: "Conversa não existe nesta conta → 404 → null",
      status: "PASS", expected: "null", actual: String(result) });
  });

  it("Verificação de inbox falha (rede) → null (fail-safe: rejeita em vez de permitir)", async () => {
    mockFetch([
      { ok: true, body: { id: 42 } },
      { ok: true, body: { id: 100, inbox_id: 10 } },
      { ok: false, body: {} },  // inbox_members falha
    ]);

    const result = await resolveValidatedAssignee(BASE, TOKEN, ACCOUNT, 42, 100, traceId);
    expect(result).toBeNull();

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T14-inbox-check-fails",
      step: "Verificação de inbox_members falha → null (fail-safe: não atribui se não pode verificar)",
      status: "PASS", expected: "null", actual: String(result) });
  });

  it("sender.id=0 → inválido (não é um ID positivo) → null", async () => {
    const result = await resolveValidatedAssignee(BASE, TOKEN, ACCOUNT, 0, 100, traceId);
    expect(result).toBeNull();
  });

  it("sender.id=undefined → null sem fazer fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await resolveValidatedAssignee(BASE, TOKEN, ACCOUNT, undefined, 100, traceId);
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sender.id negativo → null sem fazer fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await resolveValidatedAssignee(BASE, TOKEN, ACCOUNT, -5, 100, traceId);
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetch lança exceção → null (fail-safe)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Network error"))));

    const result = await resolveValidatedAssignee(BASE, TOKEN, ACCOUNT, 42, 100, traceId);
    expect(result).toBeNull();

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T14-network-error",
      step: "fetch lança exceção → null (fail-safe, não lança p/ cima)",
      status: "PASS", expected: "null", actual: String(result) });
  });
});
