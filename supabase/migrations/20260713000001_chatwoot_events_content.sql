ALTER TABLE public.chatwoot_events ADD COLUMN IF NOT EXISTS content TEXT;
ALTER TABLE public.chatwoot_events ADD COLUMN IF NOT EXISTS sender_name TEXT;
