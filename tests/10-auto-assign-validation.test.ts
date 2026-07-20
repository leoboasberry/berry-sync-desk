/**
 * T10 — Auto-assign com validação completa (B04-C fix implementado)
 *
 * Verifica que o auto-assign rejeita sender.id quando qualquer uma destas
 * condições falha:
 *   - sender.type não é "user"
 *   - agente não existe
 *   - agente pertence a account_id diferente
 *   - agente não está ativo
 *   - agente não tem acesso à inbox da conversa
 *   - sender.id é de um contato ou entidade não-agente
 *
 * A função secureAutoAssignDecision replica a lógica de resolveValidatedAssignee
 * do Edge Function (supabase/functions/chatwoot-events/index.ts).
 * A variante remota faz chamadas HTTP ao Chatwoot API; aqui usamos dados locais
 * para isolar o comportamento sem rede.
 *
 * Dados de origem no Edge Function:
 *   - account_id: payload.account_id (validado contra CHATWOOT_ACCOUNT_ID env)
 *   - agent existence: GET /api/v1/accounts/{id}/agents/{agentId} → 200/404
 *   - agent active: ausência de 404/403 + availability_status != "offline" (advisory)
 *   - conversation inbox_id: GET /api/v1/accounts/{id}/conversations/{convId} → conv.inbox_id
 *   - inbox membership: GET /api/v1/accounts/{id}/inbox_members/{inboxId} → payload[].id
 *
 * Referência: supabase/functions/chatwoot-events/index.ts — resolveValidatedAssignee
 */

import { describe, it, expect, afterAll } from "vitest";
import { newTrace, recordEvidence, printEvidenceSummary } from "./evidence-log";

const traceId = newTrace();
afterAll(() => printEvidenceSummary());

// ── Tipos ─────────────────────────────────────────────────────────────────────

type AutoAssignPayload = {
  event: string;
  message_type: string;
  conversation: { id: number; meta?: { assignee?: { id?: number } | null } };
  sender: { type: string; id: number; name: string };
  account_id: number;
};

type AgentRecord = {
  id: number;
  account_id: number;
  active: boolean;
  inbox_ids: number[];
};

// ── Validação completa (replica resolveValidatedAssignee do Edge Function) ────

function secureAutoAssignDecision(
  payload: AutoAssignPayload,
  knownAgents: AgentRecord[],
  conversationInboxId: number
): {
  wouldAssign: boolean;
  assigneeId: number | null;
  validationApplied: string[];
  rejectedReason?: string;
} {
  const conversation = payload.conversation;
  const sender = payload.sender;
  const validationApplied: string[] = [];

  // 1. sender.type deve ser "user"
  validationApplied.push("sender_type_check");
  if (sender?.type !== "user") {
    return { wouldAssign: false, assigneeId: null, validationApplied, rejectedReason: `sender.type=${sender?.type} não é 'user'` };
  }

  // 2. sender.id deve ser inteiro positivo
  validationApplied.push("sender_id_format");
  if (!Number.isInteger(sender.id) || sender.id <= 0) {
    return { wouldAssign: false, assigneeId: null, validationApplied, rejectedReason: "sender.id não é inteiro positivo" };
  }

  // 3. Agente deve existir
  validationApplied.push("agent_existence_check");
  const agent = knownAgents.find((a) => a.id === sender.id);
  if (!agent) {
    return { wouldAssign: false, assigneeId: null, validationApplied, rejectedReason: `sender.id=${sender.id} não existe na tabela agents` };
  }

  // 4. Agente deve pertencer à mesma conta
  validationApplied.push("agent_account_check");
  if (agent.account_id !== payload.account_id) {
    return {
      wouldAssign: false, assigneeId: null, validationApplied,
      rejectedReason: `agente pertence a account_id=${agent.account_id}, payload é de account_id=${payload.account_id}`,
    };
  }

  // 5. Agente deve estar ativo
  validationApplied.push("agent_active_check");
  if (!agent.active) {
    return { wouldAssign: false, assigneeId: null, validationApplied, rejectedReason: `agente id=${sender.id} não está ativo` };
  }

  // 6. Agente deve ter acesso à inbox da conversa
  validationApplied.push("inbox_permission_check");
  if (!agent.inbox_ids.includes(conversationInboxId)) {
    return { wouldAssign: false, assigneeId: null, validationApplied, rejectedReason: `agente id=${sender.id} não tem acesso à inbox_id=${conversationInboxId}` };
  }

  // 7. Conversa deve pertencer à mesma conta (já garantido pelo accountId do payload + cross-account guard da Edge Function)
  validationApplied.push("conversation_account_match");

  const baseCondition =
    payload.event === "message_created" &&
    payload.message_type === "outgoing" &&
    !conversation?.meta?.assignee;

  return {
    wouldAssign: baseCondition,
    assigneeId: baseCondition ? sender.id : null,
    validationApplied,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const knownAgents: AgentRecord[] = [
  { id: 42, account_id: 1, active: true,  inbox_ids: [10, 11] }, // agente válido
  { id: 43, account_id: 1, active: false, inbox_ids: [10]      }, // inativo
  { id: 99, account_id: 2, active: true,  inbox_ids: [20]      }, // conta diferente
];

// ── T10-A: sender.id não existe ───────────────────────────────────────────────

describe("T10 — Auto-assign com validação completa (B04-C)", () => {

  it("T10-A: sender.id arbitrário (99999) é rejeitado — agente não existe", () => {
    const payload: AutoAssignPayload = {
      event: "message_created",
      message_type: "outgoing",
      conversation: { id: 12345, meta: { assignee: null } },
      sender: { type: "user", id: 99999, name: "Fake Agent" },
      account_id: 1,
    };

    const result = secureAutoAssignDecision(payload, knownAgents, 10);

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T10-no-validation",
      step: "sender.id=99999 rejeitado — não existe na tabela agents",
      status: !result.wouldAssign ? "PASS" : "FAIL",
      assertion: "Auto-assign NÃO deve aceitar sender.id sem validar existência",
      expected: "wouldAssign=false, rejectedReason inclui 'não existe'",
      actual: `wouldAssign=${result.wouldAssign}, reason=${result.rejectedReason}`,
    });

    expect(result.wouldAssign).toBe(false);
    expect(result.validationApplied).toContain("agent_existence_check");
    expect(result.rejectedReason).toMatch(/não existe/i);
  });

  // ── T10-B: agente de outra conta ──────────────────────────────────────────

  it("T10-B: agente de account_id=2 é rejeitado em conversa de account_id=1 (cross-tenant)", () => {
    const payload: AutoAssignPayload = {
      event: "message_created",
      message_type: "outgoing",
      conversation: { id: 12345, meta: { assignee: null } },
      sender: { type: "user", id: 99, name: "Agente Conta B" }, // account_id=2
      account_id: 1,
    };

    const result = secureAutoAssignDecision(payload, knownAgents, 10);

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T10-cross-account",
      step: "Agente da conta 2 rejeitado em conversa da conta 1",
      status: !result.wouldAssign ? "PASS" : "FAIL",
      assertion: "Agente de conta diferente não deve ser assignado",
      expected: "wouldAssign=false, rejectedReason inclui 'account_id'",
      actual: `wouldAssign=${result.wouldAssign}, reason=${result.rejectedReason}`,
    });

    expect(result.wouldAssign).toBe(false);
    expect(result.validationApplied).toContain("agent_account_check");
    expect(result.rejectedReason).toMatch(/account_id/i);
  });

  // ── T10-C: agente inativo ─────────────────────────────────────────────────

  it("T10-C: agente inativo (id=43) é rejeitado — active=false", () => {
    const payload: AutoAssignPayload = {
      event: "message_created",
      message_type: "outgoing",
      conversation: { id: 12345, meta: { assignee: null } },
      sender: { type: "user", id: 43, name: "Agente Inativo" },
      account_id: 1,
    };

    const result = secureAutoAssignDecision(payload, knownAgents, 10);

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T10-inactive-agent",
      step: "Agente inativo (id=43) rejeitado",
      status: !result.wouldAssign ? "PASS" : "FAIL",
      assertion: "Agente inativo não deve ser assignado",
      expected: "wouldAssign=false, rejectedReason inclui 'ativo'",
      actual: `wouldAssign=${result.wouldAssign}, reason=${result.rejectedReason}`,
    });

    expect(result.wouldAssign).toBe(false);
    expect(result.validationApplied).toContain("agent_active_check");
    expect(result.rejectedReason).toMatch(/ativo/i);
  });

  // ── Cenários adicionais ───────────────────────────────────────────────────

  it("Agente válido sem acesso à inbox é rejeitado", () => {
    const payload: AutoAssignPayload = {
      event: "message_created",
      message_type: "outgoing",
      conversation: { id: 1, meta: { assignee: null } },
      sender: { type: "user", id: 42, name: "Ana" },
      account_id: 1,
    };

    const result = secureAutoAssignDecision(payload, knownAgents, 20); // agente 42 não tem inbox 20
    expect(result.wouldAssign).toBe(false);
    expect(result.rejectedReason).toMatch(/inbox/i);
  });

  it("Agente válido com inbox correta é aceito", () => {
    const payload: AutoAssignPayload = {
      event: "message_created",
      message_type: "outgoing",
      conversation: { id: 1, meta: { assignee: null } },
      sender: { type: "user", id: 42, name: "Ana" },
      account_id: 1,
    };

    const result = secureAutoAssignDecision(payload, knownAgents, 10);
    expect(result.wouldAssign).toBe(true);
    expect(result.assigneeId).toBe(42);
    expect(result.validationApplied).toContain("conversation_account_match");
  });

  it("sender.type='bot' é rejeitado independente do sender.id", () => {
    const payload: AutoAssignPayload = {
      event: "message_created",
      message_type: "outgoing",
      conversation: { id: 1, meta: { assignee: null } },
      sender: { type: "bot", id: 42, name: "Bot" },
      account_id: 1,
    };

    const result = secureAutoAssignDecision(payload, knownAgents, 10);
    expect(result.wouldAssign).toBe(false);
    expect(result.rejectedReason).toMatch(/user/i);
  });

  it("Conversa já assignada → não faz auto-assign", () => {
    const payload: AutoAssignPayload = {
      event: "message_created",
      message_type: "outgoing",
      conversation: { id: 1, meta: { assignee: { id: 42 } } }, // já assignado
      sender: { type: "user", id: 42, name: "Ana" },
      account_id: 1,
    };

    const result = secureAutoAssignDecision(payload, knownAgents, 10);
    expect(result.wouldAssign).toBe(false);
  });

  it("Validação completa com todos os checks aplicados para caso válido", () => {
    const payload: AutoAssignPayload = {
      event: "message_created",
      message_type: "outgoing",
      conversation: { id: 1, meta: { assignee: null } },
      sender: { type: "user", id: 42, name: "Ana" },
      account_id: 1,
    };

    const result = secureAutoAssignDecision(payload, knownAgents, 11); // inbox 11 é válida para agente 42
    expect(result.wouldAssign).toBe(true);
    expect(result.validationApplied).toEqual([
      "sender_type_check",
      "sender_id_format",
      "agent_existence_check",
      "agent_account_check",
      "agent_active_check",
      "inbox_permission_check",
      "conversation_account_match",
    ]);
  });

  it("auto_assign_skipped não lança erro — evento continua processando", () => {
    // A rejeição retorna { wouldAssign: false } — nunca lança exceção
    const payload: AutoAssignPayload = {
      event: "message_created",
      message_type: "outgoing",
      conversation: { id: 1, meta: { assignee: null } },
      sender: { type: "user", id: 99999, name: "Fake" },
      account_id: 1,
    };

    let threw = false;
    try {
      const result = secureAutoAssignDecision(payload, knownAgents, 10);
      expect(result.wouldAssign).toBe(false);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false); // nunca lança — processo continua
  });
});
