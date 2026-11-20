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


CREATE TABLE IF NOT EXISTS rungrow_telemetry_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_event_id bigint NOT NULL,
  event_type varchar(100) NOT NULL,
  payload jsonb NOT NULL,
  recognised_revenue_inr numeric(14,2) NOT NULL DEFAULT 0 CHECK (recognised_revenue_inr >= 0),
  state varchar(16) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,source_event_id)
);
CREATE INDEX IF NOT EXISTS idx_rungrow_telemetry_due
  ON rungrow_telemetry_outbox (tenant_id,next_attempt_at,created_at) WHERE state='pending';
ALTER TABLE rungrow_telemetry_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE rungrow_telemetry_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rungrow_telemetry_tenant ON rungrow_telemetry_outbox;
CREATE POLICY rungrow_telemetry_tenant ON rungrow_telemetry_outbox
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION enqueue_rungrow_lifecycle_telemetry() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE revenue numeric(14,2) := 0;
BEGIN
  IF NEW.type IN ('invoice.recognised','invoice.recognized') THEN
    revenue := GREATEST(COALESCE(NULLIF(NEW.meta->>'recognised_revenue_inr','')::numeric,0),0);
  END IF;
  INSERT INTO rungrow_telemetry_outbox
    (tenant_id,source_event_id,event_type,payload,recognised_revenue_inr)
  VALUES (
    NEW.tenant_id,NEW.id,NEW.type,
    jsonb_build_object('event_id',NEW.id,'event_type',NEW.type,'occurred_at',NEW.created_at) || NEW.meta,
    revenue
  )
  ON CONFLICT (tenant_id,source_event_id) DO NOTHING;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS events_rungrow_telemetry ON events;
CREATE TRIGGER events_rungrow_telemetry
  AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION enqueue_rungrow_lifecycle_telemetry();
