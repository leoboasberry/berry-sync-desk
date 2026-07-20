-- B05 v2: Substitui a coluna payload_hash por dedup_key com semântica correta
--
-- Problema com v1 (20260715000001):
--   SHA-256(field1 | field2 | ...) causa colisões quando valores contêm "|"
--   message_id ausente do hash → dois "ok" seguidos na mesma conversa se tornam
--   indistinguíveis e o segundo é descartado
--
-- Solução v2:
--   - Para message_created com message_id: SHA-256 de JSON canônico
--     {"v":1,"account_id":N,"event":"message_created","message_id":M}
--   - Fallback (sem message_id): SHA-256 de JSON canônico com campos estáveis
--     {"v":1,"account_id":N,"event":E,"conversation_id":C,"sender_id":S,"created_at":T,"content":X}
--   - Serialização canônica: JSON com chaves em ordem alfabética (sem espaços)
--   - SHA-256 é aplicado sobre a string UTF-8 resultante
--
-- Retenção: chatwoot_events não tem limpeza periódica hoje.
--   Com dedup_key UNIQUE permanente, a tabela cresce indefinidamente.
--   Recomendação (fora do escopo desta migration): job diário que deleta
--   registros com mais de 30 dias (after_load no backend já não os usa).
--   O UNIQUE INDEX parcial (WHERE dedup_key IS NOT NULL) garante que
--   registros antigos sem dedup_key não bloqueiem inserções.

-- Remove coluna e índice da v1 (idempotente)
DROP INDEX IF EXISTS chatwoot_events_payload_hash_unique;
ALTER TABLE public.chatwoot_events DROP COLUMN IF EXISTS payload_hash;

-- Adiciona nova coluna com nome mais preciso
ALTER TABLE public.chatwoot_events
  ADD COLUMN IF NOT EXISTS dedup_key TEXT;

-- UNIQUE INDEX parcial: só dedup eventos que têm chave calculada
-- Retrocompatível: linhas antigas (NULL) não são afetadas
CREATE UNIQUE INDEX IF NOT EXISTS chatwoot_events_dedup_key_unique
  ON public.chatwoot_events (dedup_key)
  WHERE dedup_key IS NOT NULL;

-- Comentário de documentação da coluna
COMMENT ON COLUMN public.chatwoot_events.dedup_key IS
  'SHA-256 hex de JSON canônico. '
  'Com message_id: {"v":1,"account_id":N,"event":E,"message_id":M}. '
  'Sem message_id: {"v":1,"account_id":N,"content":X,"conversation_id":C,"created_at":T,"event":E,"sender_id":S}. '
  'NULL = evento anterior à v2, sem deduplicação garantida.';
