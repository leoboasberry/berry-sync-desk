-- B05: Deduplicação de eventos — impede replay gerando registros duplicados
--
-- A combinação (event_type, account_id, conversation_id, content, sender_name)
-- com janela de 60 segundos bloqueia replays do mesmo payload.
-- Usamos uma coluna `payload_hash` com UNIQUE para deduplicação eficiente.
--
-- Abordagem: hash SHA-256 do conteúdo relevante do payload (sem timestamps).
-- A Edge Function calcula o hash e o inclui no INSERT — ON CONFLICT DO NOTHING
-- descarta duplicatas silenciosamente.

-- Adiciona coluna para hash de deduplicação (nullable para retrocompatibilidade)
ALTER TABLE public.chatwoot_events
  ADD COLUMN IF NOT EXISTS payload_hash TEXT;

-- UNIQUE partial index: apenas eventos com hash preenchido são deduplicados
-- (eventos antigos sem hash continuam sem restrição)
CREATE UNIQUE INDEX IF NOT EXISTS chatwoot_events_payload_hash_unique
  ON public.chatwoot_events (payload_hash)
  WHERE payload_hash IS NOT NULL;

-- Nota: a Edge Function deve calcular o hash antes do INSERT:
--   payload_hash = SHA256(event_type + account_id + conversation_id + content + sender_name)
-- e usar ON CONFLICT (payload_hash) DO NOTHING
