/**
 * SAFETY CONTROLS — ler antes de qualquer teste
 *
 * Todo teste que opera sobre dados reais DEVE:
 *  1. Importar assertTestContactAllowed()
 *  2. Chamar assertSafeToRun() no início do arquivo
 *  3. Passar DRY_RUN=false TEST_CONTACTS_CONFIRMED=true ENABLE_REAL_WHATSAPP_TESTS=true
 *     para executar operações mutáveis reais
 */

// ── Allowlist centralizada ───────────────────────────────────────────────────
export const TEST_PHONE_ALLOWLIST = new Set([
  "5548998299242",
  "5565999615067",
]);

export type AuthorizedTestContact = {
  phone: string;            // normalizado, sem +
  accountId?: number;
  inboxId?: number;
  contactId?: number;
  contactInboxId?: number;
  conversationIds?: number[];
  waId?: string;
};

// IDs reais preenchidos em runtime via resolveAuthorizedContacts()
export const AUTHORIZED_TEST_CONTACTS: AuthorizedTestContact[] = [
  { phone: "5548998299242" },
  { phone: "5565999615067" },
];

// ── Kill switch ──────────────────────────────────────────────────────────────
const DRY_RUN              = process.env.DRY_RUN              !== "false";
const CONTACTS_CONFIRMED   = process.env.TEST_CONTACTS_CONFIRMED === "true";
const REAL_WA_ENABLED      = process.env.ENABLE_REAL_WHATSAPP_TESTS === "true";

export const IS_REAL_RUN = !DRY_RUN && CONTACTS_CONFIRMED && REAL_WA_ENABLED;

/** Deve ser chamado no topo de cada arquivo de teste. */
export function assertSafeToRun(description: string): void {
  if (IS_REAL_RUN) {
    console.log(`[SAFETY] MODO REAL — ${description}`);
    console.log("[SAFETY] DRY_RUN=false TEST_CONTACTS_CONFIRMED=true ENABLE_REAL_WHATSAPP_TESTS=true");
  } else {
    console.log(`[SAFETY] DRY_RUN ativo — ${description} — nenhuma operação mutável será executada`);
  }
}

// ── Validação de contato ─────────────────────────────────────────────────────
export function assertTestContactAllowed(phone: string): void {
  const normalized = phone.replace(/\D/g, "");
  if (!TEST_PHONE_ALLOWLIST.has(normalized)) {
    throw new Error(
      `[TEST SAFETY BLOCK] Contato não autorizado para testes: ${maskPhone(normalized)}\n` +
      `Apenas os seguintes contatos são permitidos: ${[...TEST_PHONE_ALLOWLIST].map(maskPhone).join(", ")}`
    );
  }
}

export type ConversationIdentifiers = {
  phone: string;
  conversationId: number;
  contactId?: number;
  contactInboxId?: number;
  accountId?: number;
  inboxId?: number;
};

export function assertAuthorizedConversation(ids: ConversationIdentifiers): void {
  assertTestContactAllowed(ids.phone);

  const contact = AUTHORIZED_TEST_CONTACTS.find(
    (c) => c.phone === ids.phone.replace(/\D/g, "")
  );
  if (!contact) {
    throw new Error(`[TEST SAFETY BLOCK] Contato ${maskPhone(ids.phone)} não encontrado na configuração.`);
  }

  if (contact.accountId && ids.accountId && contact.accountId !== ids.accountId) {
    throw new Error(
      `[TEST SAFETY BLOCK] account_id divergente. Esperado: ${contact.accountId}, recebido: ${ids.accountId}`
    );
  }
  if (contact.inboxId && ids.inboxId && contact.inboxId !== ids.inboxId) {
    throw new Error(
      `[TEST SAFETY BLOCK] inbox_id divergente. Esperado: ${contact.inboxId}, recebido: ${ids.inboxId}`
    );
  }
  if (contact.contactId && ids.contactId && contact.contactId !== ids.contactId) {
    throw new Error(
      `[TEST SAFETY BLOCK] contact_id divergente. Esperado: ${contact.contactId}, recebido: ${ids.contactId}`
    );
  }
  if (
    contact.conversationIds?.length &&
    !contact.conversationIds.includes(ids.conversationId)
  ) {
    throw new Error(
      `[TEST SAFETY BLOCK] conversation_id ${ids.conversationId} não está na lista autorizada para ${maskPhone(ids.phone)}.`
    );
  }
}

// ── Dry-run guard ────────────────────────────────────────────────────────────
/**
 * Envolve uma operação mutável real.
 * Em DRY_RUN, loga o que faria sem executar.
 */
export async function safeExecute<T>(
  description: string,
  operation: () => Promise<T>
): Promise<T | null> {
  if (!IS_REAL_RUN) {
    console.log(`[DRY_RUN] Operação NÃO executada: ${description}`);
    return null;
  }
  console.log(`[REAL] Executando: ${description}`);
  return operation();
}

// ── Mascaramento de PII ──────────────────────────────────────────────────────
export function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, "");
  if (d.length < 6) return "****";
  return d.slice(0, 4) + "****" + d.slice(-4);
}

export function maskToken(token: string): string {
  if (token.length < 8) return "***";
  return token.slice(0, 4) + "..." + token.slice(-4);
}

// ── Conteúdo sintético obrigatório ──────────────────────────────────────────
export function syntheticMessage(opts: {
  traceId: string;
  scenario: string;
  sequence: number;
  expectedConversationId?: number;
}): string {
  return (
    `[TESTE AUTOMATIZADO — NÃO RESPONDER]\n` +
    `trace_id: ${opts.traceId}\n` +
    `cenário: ${opts.scenario}\n` +
    `sequência: ${String(opts.sequence).padStart(3, "0")}\n` +
    `conversation_id esperado: ${opts.expectedConversationId ?? "N/A"}\n` +
    `timestamp: ${new Date().toISOString()}`
  );
}

// ── Limites de carga ─────────────────────────────────────────────────────────
export const LOAD_LIMITS = {
  maxConcurrentRequests: 2,
  maxMessagesPerContact: 10,
  minIntervalBetweenMessagesMs: 2_000,
  maxMutableOperationsPerRun: 20,
} as const;
