-- Add hubspot_owner_id to agents so each agent can be linked to a HubSpot owner
ALTER TABLE agents ADD COLUMN IF NOT EXISTS hubspot_owner_id TEXT;

-- Cache table: phone → HubSpot lead owner (null = no owner / not found in HubSpot)
CREATE TABLE IF NOT EXISTS contact_owner_cache (
  phone          TEXT PRIMARY KEY,
  hubspot_owner_id TEXT,
  updated_at     TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE contact_owner_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON contact_owner_cache
  FOR ALL TO service_role USING (true) WITH CHECK (true);
