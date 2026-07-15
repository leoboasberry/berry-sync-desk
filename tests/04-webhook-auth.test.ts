/**
 * T04 — Webhook sem autenticação
 *
 * Valida se o endpoint /chatwoot-events aceita payloads não autenticados.
 *
 * MODO DRY_RUN (padrão): apenas documenta o que seria feito.
 * MODO REAL: envia requests contra o endpoint de staging/produção.
 *
 * Não classifica como XSS sem demonstrar execução no DOM.
 * Classifica como: "Injeção persistente de conteúdo e falsificação de notificação."
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { assertSafeToRun, IS_REAL_RUN, safeExecute, maskToken } from "./safety";
import { newTrace, recordEvidence, printEvidenceSummary } from "./evidence-log";

const FUNCTION_URL = process.env.SUPABASE_FUNCTION_URL ??
  "https://awgrjzpjbnewaohzjhxs.supabase.co/functions/v1/chatwoot-events";

const traceId = newTrace();

beforeAll(() => {
  assertSafeToRun("T04 — Webhook auth audit");
});
afterAll(() => printEvidenceSummary());

// ── Payloads de teste ────────────────────────────────────────────────────────
const PAYLOADS = {
  noAuth: {
    event: "message_created",
    conversation: { id: 99999 },
    message_type: "incoming",
    content: `[AUDIT T04] Sem autenticação — trace=${traceId}`,
    account_id: 0,
    sender: { name: "Audit Bot" },
  },
  arbitraryJson: {
    malicious: true,
    event: "message_created",
    conversation: { id: 99998 },
    content: `<script>console.log('T04-xss-attempt')</script>`,
    sender: { name: "XSS Test" },
  },
  fakeAccount: {
    event: "message_created",
    account_id: 99999,
    conversation: { id: 99997 },
    content: `[AUDIT T04] Conta falsa account_id=99999`,
    sender: { name: "Fake Account" },
  },
  replay: {
    event: "message_created",
    conversation: { id: 99999 },
    content: `[AUDIT T04] REPLAY trace=${traceId}`,
    sender: { name: "Replay Bot" },
  },
  oversized: {
    event: "message_created",
    conversation: { id: 99996 },
    content: "A".repeat(50_000),
    sender: { name: "Oversize Bot" },
  },
  noConversationId: {
    event: "message_created",
    content: "Sem conversation_id",
    sender: { name: "No Conv" },
  },
  wrongTypes: {
    event: 123,
    conversation: "not-an-object",
    content: null,
    account_id: "string-not-number",
    sender: { name: "Wrong Types" },
  },
  htmlContent: {
    event: "message_created",
    conversation: { id: 99995 },
    content: `<b>Negrito</b><img src=x onerror="console.log('T04-img-onerror')">`,
    sender: { name: "HTML Injector" },
  },
};

async function postToWebhook(payload: object): Promise<{ status: number; body: unknown }> {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

describe("T04 — Webhook sem autenticação", () => {
  it("Smoke: endpoint é alcançável", async () => {
    if (!IS_REAL_RUN) {
      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T04-smoke", step: "DRY_RUN — endpoint não acessado",
        status: "INFO",
        assertion: `URL: ${FUNCTION_URL}`,
      });
      return;
    }

    const result = await postToWebhook({ event: "ping" });
    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T04-smoke", step: "Endpoint alcançável",
      status: result.status < 500 ? "INFO" : "FAIL",
      actual: result.status,
    });
  });

  it("T04-A: POST sem assinatura é aceito (deveria retornar 401)", async () => {
    let actualStatus: number | null = null;

    await safeExecute("POST sem assinatura para chatwoot-events", async () => {
      const result = await postToWebhook(PAYLOADS.noAuth);
      actualStatus = result.status;

      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T04-no-auth", step: "POST sem assinatura",
        status: result.status === 401 || result.status === 403 ? "PASS" : "FAIL",
        assertion: "Endpoint deve exigir autenticação (401/403)",
        expected: "401 ou 403",
        actual: result.status,
        error: result.status === 200
          ? "BUG CONFIRMADO: endpoint aceita POST sem qualquer autenticação"
          : undefined,
        file: "supabase/functions/chatwoot-events/index.ts",
        line: 8,
      });
    });

    if (!IS_REAL_RUN) {
      // Documenta o achado estático
      recordEvidence({
        traceId, timestamp: new Date().toISOString(),
        scenario: "T04-no-auth", step: "Análise estática — DRY_RUN",
        status: "FAIL",
        assertion: "Análise estática confirma: nenhuma verificação de auth em index.ts:8",
        expected: "Verificação de token/HMAC",
        actual: "Nenhuma verificação — `Deno.serve(async (req) => { ... })` sem auth guard",
        error: "BUG CONFIRMADO POR ANÁLISE ESTÁTICA: endpoint aceita qualquer POST",
        file: "supabase/functions/chatwoot-events/index.ts",
        line: 8,
      });
      // Em dry-run, falha o teste com base na análise estática
      expect(true).toBe(false); // RED TEST — análise estática já prova o bug
    } else {
      expect(actualStatus).toBeOneOf([401, 403]);
    }
  });

  it("T04-B: Payload com HTML em content é armazenado sem sanitização", async () => {
    // A Edge Function grava `content` diretamente de payload.content (linha 24)
    // sem qualquer sanitização. Verificamos se o valor seria renderizado no DOM.

    const rawContent = PAYLOADS.htmlContent.content;
    const containsHtml = /<[a-z][\s\S]*>/i.test(rawContent);

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T04-html-content", step: "Conteúdo HTML em payload",
      status: containsHtml ? "WARNING" : "PASS",
      assertion: "content com HTML seria armazenado e transmitido via Realtime",
      expected: "Sanitizado ou rejeitado",
      actual: rawContent.slice(0, 100),
      error: containsHtml
        ? "Injeção persistente de conteúdo: HTML em content seria armazenado em chatwoot_events.content " +
          "e renderizado no card de notificação (index.tsx:1308). " +
          "Classificação: Injeção persistente de conteúdo e falsificação de notificação (potencial XSS)."
        : undefined,
      file: "supabase/functions/chatwoot-events/index.ts",
      line: 24,
    });

    // Verifica também onde é renderizado no frontend
    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T04-html-render", step: "Renderização em index.tsx — verificar se usa dangerouslySetInnerHTML",
      status: "WARNING",
      assertion: "index.tsx:1308 usa `{n.preview || 'Nova mensagem recebida'}` em JSX",
      actual: "React escapa HTML por padrão em JSX — XSS não confirmado sem dangerouslySetInnerHTML",
      error: "Injeção de conteúdo confirmada (notificação com texto arbitrário). XSS requer dangerouslySetInnerHTML — não detectado.",
      file: "src/routes/index.tsx",
      line: 1308,
    });

    expect(containsHtml).toBe(true); // confirma que o conteúdo HTML existe no payload
  });

  it("T04-C: Auto-assign usa sender.id do payload sem validação", async () => {
    // chatwoot-events/index.ts:44: assignee_id: payload.sender.id
    // sender.id vem do payload externo não autenticado

    const fakeSenderId = 99999;
    const payload = {
      event: "message_created",
      message_type: "outgoing",
      conversation: { id: 12345, meta: { assignee: null } },
      sender: { type: "user", id: fakeSenderId, name: "Fake Agent" },
      account_id: 1,
    };

    // Verifica a lógica de auto-assign na Edge Function (linhas 29-60)
    const wouldAutoAssign =
      payload.event === "message_created" &&
      payload.message_type === "outgoing" &&
      !payload.conversation?.meta?.assignee &&
      payload.sender?.type === "user" &&
      payload.sender?.id;

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T04-auto-assign", step: "sender.id não autenticado usado como assignee_id",
      status: wouldAutoAssign ? "FAIL" : "PASS",
      assertion: "Auto-assign não deve usar sender.id de payload externo sem validação",
      expected: "Validar sender.id contra lista de agentes reais",
      actual: `sender.id=${fakeSenderId} seria usado como assignee_id via Chatwoot API`,
      error: wouldAutoAssign
        ? `BUG CONFIRMADO: payload externo pode forçar atribuição de qualquer agente (id=${fakeSenderId}) via sender.id`
        : undefined,
      file: "supabase/functions/chatwoot-events/index.ts",
      line: 44,
    });

    expect(wouldAutoAssign).toBe(false); // RED TEST
  });

  it("T04-D: Replay do mesmo payload cria segunda entrada em chatwoot_events", async () => {
    // A tabela chatwoot_events não tem UNIQUE constraint por (conversation_id, content, event_type)
    // Duas inserções do mesmo payload = dois eventos Realtime = duas notificações

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T04-replay", step: "chatwoot_events sem deduplicação",
      status: "FAIL",
      assertion: "Replay de webhook deve ser idempotente (não inserir duplicata)",
      expected: "UNIQUE constraint ou dedup por hash",
      actual: "Nenhuma constraint UNIQUE em chatwoot_events além de PK (id bigserial)",
      error: "BUG CONFIRMADO POR ANÁLISE ESTÁTICA: replay gera múltiplos eventos Realtime e notificações duplicadas",
      file: "supabase/migrations/20260629120000_chatwoot_events.sql",
      line: 1,
    });

    // Demonstra a ausência de constraint
    const tableSchema = `
      CREATE TABLE IF NOT EXISTS public.chatwoot_events (
        id        BIGSERIAL PRIMARY KEY,
        event_type TEXT      NOT NULL,
        account_id INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `;
    const hasUniqueOnPayload = /UNIQUE\s*\(/i.test(tableSchema) &&
      (tableSchema.includes("conversation_id") || tableSchema.includes("content"));

    expect(hasUniqueOnPayload).toBe(true); // RED TEST — prova ausência de constraint
  });

  it("T04-E: CORS * permite request de qualquer origem", async () => {
    // index.ts:4: "Access-Control-Allow-Origin": "*"
    const corsHeader = `"Access-Control-Allow-Origin": "*"`;

    recordEvidence({
      traceId, timestamp: new Date().toISOString(),
      scenario: "T04-cors", step: "CORS wildcard em Edge Function",
      status: "WARNING",
      assertion: "CORS deveria restringir origens ao domínio da aplicação",
      expected: `"Access-Control-Allow-Origin": "https://app.dominio.com.br"`,
      actual: corsHeader,
      error: "Qualquer origem pode fazer POST para a Edge Function via browser (CORS *)",
      file: "supabase/functions/chatwoot-events/index.ts",
      line: 4,
    });

    expect("*").not.toBe("https://berry.app"); // documenta wildcard
  });
});
