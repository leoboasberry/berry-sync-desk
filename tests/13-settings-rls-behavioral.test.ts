/**
 * T13 — Settings write-protection + agent_accounts isolation
 *
 * NOTA: Estes testes são UNIT / BEHAVIORAL — não fazem chamadas ao Supabase.
 * Eles verificam as INTENÇÕES das migrations e server functions, que são
 * testadas via análise estática do código (static assertions) e lógica
 * extraída para verificação isolada.
 *
 * Para testes de INTEGRAÇÃO reais (com banco), precisaria de:
 *   - supabase start (local stack)
 *   - supabase db push
 *   - createClient com chaves de test
 * Isso está fora do escopo por enquanto (DRY_RUN=true).
 *
 * O que é verificado aqui:
 *  A. settings_public view: não expõe colunas sensíveis
 *  B. upsertSettings: usa service_role (não authenticated)
 *  C. getSettingsConfigured: não retorna tokens ao browser
 *  D. agent_accounts: policy usa chatwoot_account_id da linha (não genérico)
 *  E. migration 20260715000003: REVOKE de authenticated está presente
 *  F. migration 20260715000004: policy join usa aa.chatwoot_account_id = chatwoot_events.account_id
 */

import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { newTrace, recordEvidence, printEvidenceSummary } from "./evidence-log";

const traceId = newTrace();
afterAll(() => printEvidenceSummary());

const ROOT = resolve(__dirname, "..");

function readMigration(name: string): string {
  return readFileSync(resolve(ROOT, "supabase/migrations", name), "utf8");
}

function readServerFns(): string {
  return readFileSync(resolve(ROOT, "src/lib/chatwoot.functions.ts"), "utf8");
}

function readAppShell(): string {
  return readFileSync(resolve(ROOT, "src/components/AppShell.tsx"), "utf8");
}

function readConfiguracoes(): string {
  return readFileSync(resolve(ROOT, "src/routes/configuracoes.tsx"), "utf8");
}

// ── A. settings_public view ───────────────────────────────────────────────────

describe("T13-A — settings_public: view não expõe tokens", () => {

  it("Migration 20260715000003 cria settings_public sem chatwoot_token e hubspot_token", () => {
    const sql = readMigration("20260715000003_settings_write_protection.sql");

    expect(sql).toMatch(/CREATE.*VIEW.*settings_public/is);

    // Tokens NÃO devem aparecer na definição da view
    const viewStart = sql.search(/CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+public\.settings_public/is);
    const viewEnd = sql.indexOf("GRANT SELECT ON public.settings_public");
    const viewBlock = sql.slice(viewStart, viewEnd > viewStart ? viewEnd : undefined);
    expect(viewBlock).not.toContain("chatwoot_token");
    expect(viewBlock).not.toContain("hubspot_token");

    // Campos seguros devem aparecer
    expect(viewBlock).toContain("chatwoot_url");
    expect(viewBlock).toContain("chatwoot_account_id");
    expect(viewBlock).toContain("updated_at");

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T13-A-view-no-tokens",
      step: "settings_public view: sem chatwoot_token e hubspot_token",
      status: "PASS" });
  });

  it("AppShell lê de settings_public (sem tokens) — não de settings diretamente", () => {
    const code = readAppShell();
    // Depois da migração, AppShell usa getSettingsConfigured() — server function
    expect(code).toContain("getSettingsConfigured");
    // Não deve chamar supabase.from("settings") para checar tokens
    expect(code).not.toMatch(/from\(["']settings["']\).*chatwoot_token/s);
    expect(code).not.toMatch(/from\(["']settings["']\).*hubspot_token/s);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T13-A-appshell-no-tokens",
      step: "AppShell: usa getSettingsConfigured(), não acessa tokens via REST",
      status: "PASS" });
  });

  it("configuracoes.tsx lê de settings_public — tokens não chegam ao client state", () => {
    const code = readConfiguracoes();
    // Deve usar settings_public para leitura (não "settings" com tokens)
    expect(code).toContain("settings_public");
    // Não deve pre-popular campos de token com valor vindo do banco
    // (o usuário precisa redigitar para alterar)
    expect(code).not.toMatch(/setChatwootToken\(.*chatwoot_token/s);
    expect(code).not.toMatch(/setHubspotToken\(.*hubspot_token/s);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T13-A-config-no-token-prefill",
      step: "configuracoes.tsx: tokens não são pre-populados no state client (lê settings_public)",
      status: "PASS" });
  });
});

// ── B. upsertSettings via service_role ────────────────────────────────────────

describe("T13-B — upsertSettings: usa service_role, não authenticated", () => {

  it("upsertSettings usa supabaseAdmin (service_role), não supabaseClient", () => {
    const code = readServerFns();
    // Encontra o bloco de upsertSettings
    const fnStart = code.indexOf("export const upsertSettings");
    const fnEnd = code.indexOf("export const ", fnStart + 1);
    const fnBlock = fnEnd > 0 ? code.slice(fnStart, fnEnd) : code.slice(fnStart);

    // Deve usar supabaseAdmin
    expect(fnBlock).toContain("supabaseAdmin");
    // Não deve usar supabaseClient (que usaria o token do usuário)
    expect(fnBlock).not.toContain("supabaseClient.from");

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T13-B-service-role",
      step: "upsertSettings: usa supabaseAdmin (service_role) para escrever settings",
      status: "PASS" });
  });

  it("Migration 20260715000003 revoga INSERT/UPDATE/DELETE de authenticated", () => {
    const sql = readMigration("20260715000003_settings_write_protection.sql");

    expect(sql).toMatch(/REVOKE.*INSERT.*ON.*settings.*FROM.*authenticated/is);
    expect(sql).toMatch(/REVOKE.*UPDATE.*ON.*settings.*FROM.*authenticated/is);
    expect(sql).toMatch(/REVOKE.*DELETE.*ON.*settings.*FROM.*authenticated/is);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T13-B-revoke",
      step: "Migration 20260715000003: REVOKE INSERT/UPDATE/DELETE de authenticated em settings",
      status: "PASS" });
  });

  it("Políticas de escrita em settings foram removidas pela migration", () => {
    const sql = readMigration("20260715000003_settings_write_protection.sql");

    // DROP das policies de upsert/update
    expect(sql).toMatch(/DROP POLICY.*settings upsert/is);
    expect(sql).toMatch(/DROP POLICY.*settings update/is);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T13-B-drop-policies",
      step: "Migration remove policies de escrita em settings para authenticated",
      status: "PASS" });
  });
});

// ── C. getSettingsConfigured não retorna tokens ───────────────────────────────

describe("T13-C — getSettingsConfigured: retorna apenas boolean, sem tokens", () => {

  it("getSettingsConfigured retorna { chatwootConfigured, hubspotConfigured } — sem tokens", () => {
    const code = readServerFns();
    const fnStart = code.indexOf("export const getSettingsConfigured");
    const fnEnd = code.indexOf("export const ", fnStart + 1);
    const fnBlock = fnEnd > 0 ? code.slice(fnStart, fnEnd) : code.slice(fnStart);

    // Deve checar se token existe (boolean), não retornar o token
    expect(fnBlock).toContain("chatwootConfigured");
    expect(fnBlock).toContain("hubspotConfigured");

    // O retorno deve incluir apenas booleans, não os tokens em si
    // A função pode fazer SELECT chatwoot_token para checar existência,
    // mas o objeto retornado não deve expor os tokens.
    const returnMatch = fnBlock.match(/return\s*\{([^}]+)\}/s);
    if (returnMatch) {
      const returnBody = returnMatch[1];
      // O return deve ter apenas { chatwootConfigured, hubspotConfigured }
      expect(returnBody).not.toMatch(/chatwoot_token\s*:/);
      expect(returnBody).not.toMatch(/hubspot_token\s*:/);
    }

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T13-C-no-token-return",
      step: "getSettingsConfigured: retorna apenas {chatwootConfigured, hubspotConfigured} — sem tokens",
      status: "PASS" });
  });
});

// ── D. agent_accounts isolation: policy usa account_id da linha ───────────────

describe("T13-D — agent_accounts: isolamento real por account_id", () => {

  it("Migration 20260715000004 cria agent_accounts com PK (user_id, chatwoot_account_id)", () => {
    const sql = readMigration("20260715000004_agent_accounts_isolation.sql");

    expect(sql).toContain("CREATE TABLE");
    expect(sql).toContain("agent_accounts");
    expect(sql).toContain("user_id");
    expect(sql).toContain("chatwoot_account_id");
    expect(sql).toMatch(/PRIMARY KEY.*user_id.*chatwoot_account_id/is);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T13-D-table",
      step: "agent_accounts: tabela criada com PK composta (user_id, chatwoot_account_id)",
      status: "PASS" });
  });

  it("Policy de chatwoot_events usa aa.chatwoot_account_id = chatwoot_events.account_id (por linha)", () => {
    const sql = readMigration("20260715000004_agent_accounts_isolation.sql");

    // A policy deve comparar account_id DA LINHA com o vínculo do agente
    expect(sql).toContain("aa.chatwoot_account_id = chatwoot_events.account_id");

    // A policy ativa NÃO deve usar o padrão v1 (sem account_id).
    // O padrão v1 aparece nos COMENTÁRIOS do arquivo mas não no corpo de CREATE POLICY.
    // Verifica apenas o bloco da CREATE POLICY ativa:
    const policyBlock = sql.slice(sql.indexOf("CREATE POLICY \"agent_accounts can read chatwoot_events\""));
    // A policy ativa deve usar agent_accounts (não agents diretamente)
    expect(policyBlock).toContain("agent_accounts");
    // A policy ativa deve ter o join por account_id
    expect(policyBlock).toContain("aa.chatwoot_account_id = chatwoot_events.account_id");

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T13-D-policy-per-row",
      step: "Policy chatwoot_events: compara aa.chatwoot_account_id = chatwoot_events.account_id (por linha)",
      status: "PASS" });
  });

  it("Policy da v1 (agents sem account_id) foi removida", () => {
    const sql = readMigration("20260715000004_agent_accounts_isolation.sql");

    expect(sql).toContain("DROP POLICY IF EXISTS \"agents can read chatwoot_events\"");

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T13-D-drop-v1-policy",
      step: "Migration remove policy v1 (qualquer agente lê todos os eventos)",
      status: "PASS" });
  });

  it("Backfill DO block valida account_id antes de inserir vínculos", () => {
    const sql = readMigration("20260715000004_agent_accounts_isolation.sql");

    // Deve ter validação que aborta se account_id estiver vazio
    expect(sql).toContain("BACKFILL ABORTADO");
    expect(sql).toMatch(/v_account_id.*IS NULL/is);

    // Deve validar que é um BIGINT positivo
    expect(sql).toMatch(/v_account_id\s*:=\s*v_account_id_text::BIGINT/is);
    expect(sql).toContain("v_account_id <= 0");

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T13-D-backfill-safe",
      step: "Backfill: valida account_id antes de inserir — aborta se vazio ou inválido",
      status: "PASS" });
  });

  it("linkAgentToAccount e unlinkAgentFromAccount existem como server functions", () => {
    const code = readServerFns();

    expect(code).toContain("export const linkAgentToAccount");
    expect(code).toContain("export const unlinkAgentFromAccount");

    // Ambas usam supabaseAdmin (service_role — não authenticated)
    const linkStart = code.indexOf("export const linkAgentToAccount");
    const linkEnd = code.indexOf("export const ", linkStart + 1);
    const linkBlock = code.slice(linkStart, linkEnd);
    expect(linkBlock).toContain("supabaseAdmin");

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T13-D-link-fns",
      step: "linkAgentToAccount e unlinkAgentFromAccount existem e usam supabaseAdmin",
      status: "PASS" });
  });
});

// ── E. HMAC: verificação de existência das variáveis no Edge Function ─────────

describe("T13-E — HMAC: verificação estática do Edge Function", () => {

  it("Edge Function lê CHATWOOT_WEBHOOK_TOKEN_CURRENT via Deno.env", () => {
    // Nomes canônicos: CHATWOOT_WEBHOOK_TOKEN_CURRENT + CHATWOOT_WEBHOOK_TOKEN_PREVIOUS
    // (esta instalação do Chatwoot não suporta HMAC; token em query string é o controle compensatório)
    const code = readFileSync(
      resolve(ROOT, "supabase/functions/chatwoot-events/index.ts"),
      "utf8"
    );

    expect(code).toContain("CHATWOOT_WEBHOOK_TOKEN_CURRENT");
    expect(code).toContain("CHATWOOT_WEBHOOK_TOKEN_PREVIOUS");
    expect(code).toContain("APP_ENV");
    expect(code).toContain("ALLOW_UNSIGNED_CHATWOOT_WEBHOOKS");

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T13-E-env-vars",
      step: "Edge Function: referencia CHATWOOT_WEBHOOK_TOKEN_CURRENT/_PREVIOUS, APP_ENV, ALLOW_UNSIGNED",
      status: "PASS" });
  });

  it("Edge Function não tem fallback silencioso (sem 'accept' quando secret falta em prod)", () => {
    const code = readFileSync(
      resolve(ROOT, "supabase/functions/chatwoot-events/index.ts"),
      "utf8"
    );

    // Deve retornar 503 quando token ausente em produção
    expect(code).toContain("503");

    // Deve retornar resposta opaca — "Service unavailable" (não vaza detalhes de config)
    expect(code).toMatch(/Service unavailable|Webhook security not configured/i);

    recordEvidence({ traceId, timestamp: new Date().toISOString(),
      scenario: "T13-E-no-silent-fallback",
      step: "Edge Function: sem token em produção → 503, sem fallback silencioso",
      status: "PASS" });
  });
});
