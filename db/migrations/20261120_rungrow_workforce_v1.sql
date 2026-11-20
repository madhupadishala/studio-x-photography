CREATE TABLE IF NOT EXISTS rungrow_adapter_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  request_hash char(64) NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, endpoint, idempotency_key)
);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_url text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS correlation_id varchar(128);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS approval_id varchar(128);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_source_url ON leads(tenant_id, source_url) WHERE source_url IS NOT NULL;
ALTER TABLE rungrow_adapter_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE rungrow_adapter_idempotency FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rungrow_adapter_idempotency_tenant ON rungrow_adapter_idempotency;
CREATE POLICY rungrow_adapter_idempotency_tenant ON rungrow_adapter_idempotency
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
