// ── notification-dedup.ts ─────────────────────────────────────────────────────
//
// Janela de deduplicação para som e push de notificação.
//
// Chave: `${accountId}:${eventType}:${messageId}`
// TTL:   10 segundos (tempo suficiente para Realtime enviar evento duplicado)
//
// O mesmo evento repetido dentro da janela não emite nova notificação.
// Eventos diferentes com mesmo conteúdo mas messageId diferente SEMPRE passam.

export type NotifDedupKey = {
  accountId: number;
  eventType: string;
  messageId: number | string;
};

type Entry = { expiresAt: number };

const _seen = new Map<string, Entry>();
const WINDOW_MS = 10_000; // 10 segundos

function buildKey({ accountId, eventType, messageId }: NotifDedupKey): string {
  return `${accountId}:${eventType}:${messageId}`;
}

function purgeExpired(): void {
  const now = Date.now();
  for (const [k, v] of _seen) {
    if (v.expiresAt <= now) _seen.delete(k);
  }
}

/**
 * Retorna true se este evento deve emitir notificação (primeira ocorrência na janela).
 * Retorna false se já foi visto nos últimos WINDOW_MS ms.
 */
export function shouldNotify(key: NotifDedupKey): boolean {
  purgeExpired();
  const k = buildKey(key);
  const entry = _seen.get(k);
  const now = Date.now();

  if (entry && entry.expiresAt > now) return false; // duplicata dentro da janela

  _seen.set(k, { expiresAt: now + WINDOW_MS });
  return true;
}

/**
 * Remove uma chave específica — útil se o evento for confirmado como inválido
 * e não queremos que ele bloqueie a próxima ocorrência legítima.
 */
export function clearNotifEntry(key: NotifDedupKey): void {
  _seen.delete(buildKey(key));
}

/**
 * Limpa todo o estado — chamado no logout para não vazar entre sessões.
 */
export function clearAllNotifState(): void {
  _seen.clear();
}

/**
 * Para testes: retorna o tamanho atual do mapa (após purge).
 */
export function _testSeenSize(): number {
  purgeExpired();
  return _seen.size;
}
