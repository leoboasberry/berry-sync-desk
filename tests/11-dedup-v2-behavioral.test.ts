/**
 * T11 — B05 v2: Deduplicação com message_id como chave primária
 *
 * Cobre todos os cenários solicitados:
 *  - replay exato do mesmo message_id
 *  - mesmo message_id com timestamp diferente
 *  - dois eventos distintos com conteúdo "ok"
 *  - dois eventos com mesmo content+sender+conversa (sem message_id)
 *  - valores contendo "|"
 *  - propriedades JSON em ordem diferente (canonicidade)
 *  - evento sem message_id
 *  - eventos diferentes com conteúdo igual (via message_id distintos)
 *  - replay de evento sem message_id
 *  - dois eventos legítimos sem message_id em instantes diferentes
 *
 * Retenção documentada ao final.
 */

import { describe, it, expect, afterAll } from "vitest";
import { createHash } from "crypto";
import { newTrace, recordEvidence, printEvidenceSummary } from "./evidence-log";

const traceId = newTrace();
afterAll(() => printEvidenceSummary());

// ── Réplica de canonicalJson e sha256hex (index.ts) ──────────────────────────

function canonicalJson(obj: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ── Réplica de computeDedupKey (index.ts:53-72) ──────────────────────────────

type ChatwootPayload = {
  event?: unknown;
  id?: unknown;         // message_id (Chatwoot usa payload.id para mensagens)
  account_id?: unknown;
  conversation?: { id?: unknown };
  sender?: { id?: unknown; name?: unknown };
  created_at?: unknown;
  content?: unknown;
};

function computeDedupKey(payload: ChatwootPayload): string {
  const conversation = payload.conversation;
  const sender = payload.sender;
  const messageId = payload.id;

  if (messageId != null) {
    return sha256hex(canonicalJson({
      account_id: payload.account_id ?? null,
      event: payload.event ?? null,
      message_id: messageId,
      v: 1,
    }));
  }

  return sha256hex(canonicalJson({
    account_id: payload.account_id ?? null,
    content: payload.content ?? null,
    conversation_id: conversation?.id ?? null,
    created_at: payload.created_at ?? null,
    event: payload.event ?? null,
    sender_id: sender?.id ?? null,
    v: 1,
  }));
}

// ── Testes ───────────────────────────────────────────────────────────────────

describe("T11 — B05 v2: Deduplicação com message_id", () => {

  describe("Com message_id presente", () => {
    it("Replay exato do mesmo message_id → chave idêntica → descartado", () => {
      const p = { event: "message_created", id: 42, account_id: 1, content: "Olá", sender: { id: 10 } };
      const k1 = computeDedupKey(p);
      const k2 = computeDedupKey(p);
      expect(k1).toBe(k2);
      recordEvidence({ traceId, timestamp: new Date().toISOString(),
        scenario: "T11-replay-msgid", step: "Replay mesmo message_id → chaves iguais → ON CONFLICT DO NOTHING",
        status: "PASS", expected: "k1 === k2", actual: `k1===k2: ${k1===k2}` });
    });

    it("Mesmo message_id com timestamp diferente → mesma chave (timestamp não faz parte)", () => {
      const base = { event: "message_created", id: 42, account_id: 1, content: "Olá" };
      const k1 = computeDedupKey({ ...base, created_at: 1000 });
      const k2 = computeDedupKey({ ...base, created_at: 9999 });
      // created_at não entra no hash quando message_id está presente
      expect(k1).toBe(k2);
      recordEvidence({ traceId, timestamp: new Date().toISOString(),
        scenario: "T11-msgid-diff-ts", step: "Mesmo message_id, timestamp diferente → mesma chave",
        status: "PASS", actual: `k1===k2: ${k1===k2}` });
    });

    it("Dois eventos distintos com conteúdo 'ok' mas message_ids diferentes → chaves diferentes", () => {
      const k1 = computeDedupKey({ event: "message_created", id: 100, account_id: 1, content: "ok" });
      const k2 = computeDedupKey({ event: "message_created", id: 101, account_id: 1, content: "ok" });
      expect(k1).not.toBe(k2);
      recordEvidence({ traceId, timestamp: new Date().toISOString(),
        scenario: "T11-two-ok-different-msgid",
        step: "Dois 'ok' com message_ids diferentes → chaves diferentes → SEGUNDO NÃO É DESCARTADO",
        status: "PASS", expected: "k1 ≠ k2", actual: `k1===k2: ${k1===k2}` });
    });

    it("Campos com '|' no valor não causam colisão (JSON canônico, sem concatenação)", () => {
      const k1 = computeDedupKey({ event: "message_created", id: 5, account_id: 1, content: "a|b" });
      const k2 = computeDedupKey({ event: "message_created", id: 6, account_id: 1, content: "a|b" });
      // k1 ≠ k2 porque message_ids são diferentes
      expect(k1).not.toBe(k2);

      // Confirmar que "|" no content não polui o hash (message_id domina)
      const k3 = computeDedupKey({ event: "message_created", id: 5, account_id: 1, content: "a" });
      // k1 ≠ k3 porque content é diferente? NÃO: com message_id presente, content não entra no hash
      // Portanto k1 === k3 (apenas message_id=5 e account_id=1 importam)
      expect(k1).toBe(k3);

      recordEvidence({ traceId, timestamp: new Date().toISOString(),
        scenario: "T11-pipe-in-value",
        step: "Com message_id: valores com '|' não afetam a chave (content não entra no hash)",
        status: "PASS", actual: `k1===k3 (content ignorado com message_id): ${k1===k3}` });
    });

    it("Propriedades JSON em ordem diferente → mesma chave (canonicidade)", () => {
      // canonicalJson ordena chaves alfabeticamente
      const obj1 = { v: 1, message_id: 42, event: "message_created", account_id: 1 };
      const obj2 = { account_id: 1, event: "message_created", message_id: 42, v: 1 };
      expect(canonicalJson(obj1 as Record<string, unknown>)).toBe(canonicalJson(obj2 as Record<string, unknown>));

      const k1 = computeDedupKey({ id: 42, event: "message_created", account_id: 1 });
      const k2 = computeDedupKey({ id: 42, account_id: 1, event: "message_created" });
      expect(k1).toBe(k2);
      recordEvidence({ traceId, timestamp: new Date().toISOString(),
        scenario: "T11-canonical", step: "Campos em ordem diferente → mesma chave canônica",
        status: "PASS", actual: `k1===k2: ${k1===k2}` });
    });

    it("Dois events diferentes que por acaso têm conteúdo igual → distinguidos pelo message_id", () => {
      // "Olá" na conversa 10 (id=55) e na conversa 20 (id=56)
      const k1 = computeDedupKey({ event: "message_created", id: 55, account_id: 1, content: "Olá", conversation: { id: 10 } });
      const k2 = computeDedupKey({ event: "message_created", id: 56, account_id: 1, content: "Olá", conversation: { id: 20 } });
      expect(k1).not.toBe(k2);
    });
  });

  describe("Sem message_id (fallback)", () => {
    it("Evento sem message_id usa fallback com campos estáveis", () => {
      const p = {
        event: "conversation_updated",
        account_id: 1,
        conversation: { id: 100 },
        sender: { id: 7 },
        created_at: 1700000000,
        content: "status changed",
      };
      const k = computeDedupKey(p);
      expect(typeof k).toBe("string");
      expect(k).toHaveLength(64); // SHA-256 hex = 64 chars
      recordEvidence({ traceId, timestamp: new Date().toISOString(),
        scenario: "T11-no-msgid", step: "Sem message_id: usa fallback com (account_id, event, conversation_id, sender_id, created_at, content)",
        status: "PASS", actual: `hash len=${k.length}` });
    });

    it("Replay de evento sem message_id → mesma chave → descartado", () => {
      const p = { event: "conversation_updated", account_id: 1, conversation: { id: 100 }, sender: { id: 7 }, created_at: 1700000000, content: "x" };
      expect(computeDedupKey(p)).toBe(computeDedupKey(p));
    });

    it("Dois eventos legítimos sem message_id em instantes DIFERENTES → chaves diferentes", () => {
      // Dois "ok" enviados em momentos diferentes — created_at diferente distingue
      const k1 = computeDedupKey({ event: "message_created", account_id: 1, conversation: { id: 100 }, sender: { id: 5 }, created_at: 1000, content: "ok" });
      const k2 = computeDedupKey({ event: "message_created", account_id: 1, conversation: { id: 100 }, sender: { id: 5 }, created_at: 1001, content: "ok" });
      expect(k1).not.toBe(k2);
      recordEvidence({ traceId, timestamp: new Date().toISOString(),
        scenario: "T11-two-ok-no-msgid",
        step: "Dois 'ok' sem message_id em instantes diferentes (created_at diferente) → chaves diferentes → segundo NÃO descartado",
        status: "PASS", expected: "k1 ≠ k2", actual: `k1===k2: ${k1===k2}` });
    });

    it("Dois eventos sem message_id no MESMO instante, conteúdo igual → mesma chave → segundo descartado (correto: é duplicata)", () => {
      // Se o Chatwoot re-enviar exatamente o mesmo payload sem message_id, é replay legítimo
      const p = { event: "message_created", account_id: 1, conversation: { id: 100 }, sender: { id: 5 }, created_at: 1000, content: "ok" };
      expect(computeDedupKey(p)).toBe(computeDedupKey(p));
      recordEvidence({ traceId, timestamp: new Date().toISOString(),
        scenario: "T11-same-instant-no-msgid",
        step: "Replay sem message_id no mesmo instante → mesma chave → descartado (correto: é replay de rede)",
        status: "PASS" });
    });

    it("Campos com '|' no fallback não causam colisão (JSON, não concatenação)", () => {
      // content="a|b", sender_id=7 vs content="a", sender_id=NaN("|b,7")
      // Com JSON canônico, impossível colisão: "content":"a|b" ≠ "content":"a"
      const k1 = computeDedupKey({ event: "e", account_id: 1, conversation: { id: 1 }, sender: { id: 7 }, created_at: 1, content: "a|b" });
      const k2 = computeDedupKey({ event: "e", account_id: 1, conversation: { id: 1 }, sender: { id: 7 }, created_at: 1, content: "a" });
      expect(k1).not.toBe(k2);
      recordEvidence({ traceId, timestamp: new Date().toISOString(),
        scenario: "T11-pipe-fallback",
        step: "Fallback: '|' no content não causa colisão com outro content (JSON isola valores)",
        status: "PASS" });
    });
  });

  describe("Documentação de retenção", () => {
    it("Documenta política de retenção da tabela chatwoot_events", () => {
      // RETENÇÃO ATUAL: não há limpeza periódica.
      // dedup_key UNIQUE é permanente — a tabela cresce indefinidamente.
      //
      // RECOMENDAÇÃO (não implementada nesta migration):
      //   - Job diário ou semanal que deleta eventos com mais de 30 dias
      //   - Exemplo: DELETE FROM chatwoot_events WHERE created_at < NOW() - INTERVAL '30 days'
      //   - O UNIQUE INDEX parcial (WHERE dedup_key IS NOT NULL) permite inserir novos
      //     eventos com o mesmo dedup_key após o antigo ser deletado.
      //   - Isso significa que, após 30 dias, um replay seria aceito novamente.
      //   - Para ambientes de baixo volume (< 10k eventos/mês), retenção permanente é aceitável.
      //
      // DECISÃO REQUERIDA ANTES DO DEPLOY:
      //   Definir se a proteção contra replay precisa ser permanente (sem limpeza)
      //   ou se uma janela de 30 dias é suficiente para cobrir retentativas do Chatwoot.

      recordEvidence({ traceId, timestamp: new Date().toISOString(),
        scenario: "T11-retention",
        step: "DECISÃO PENDENTE: política de retenção de chatwoot_events",
        status: "WARNING",
        assertion: "Sem limpeza periódica = tabela cresce indefinidamente mas dedup é permanente",
        actual: "Recomendação: DELETE WHERE created_at < NOW() - INTERVAL '30 days' via job semanal",
        error: "PENDENTE: definir política de retenção antes do deploy em produção" });

      expect(true).toBe(true); // informativo
    });
  });
});
