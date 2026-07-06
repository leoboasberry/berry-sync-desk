ALTER TABLE public.chatwoot_events
  ADD COLUMN IF NOT EXISTS conversation_id INTEGER,
  ADD COLUMN IF NOT EXISTS message_type    TEXT;
