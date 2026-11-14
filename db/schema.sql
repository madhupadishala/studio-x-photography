CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug varchar(64) NOT NULL UNIQUE,
  studio_name varchar(120) NOT NULL,
  owner_name varchar(120) NOT NULL DEFAULT '',
  city varchar(100) NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  landmark text NOT NULL DEFAULT '',
  maps_url text NOT NULL DEFAULT '',
  working_hours text NOT NULL DEFAULT '',
  whatsapp_number varchar(24) NOT NULL DEFAULT '',
  whatsapp_phone_number_id varchar(80),
  owner_alert_number varchar(24) NOT NULL DEFAULT '',
  instagram_business_account_id varchar(100),
  youtube_channel_id varchar(100),
  theme_preset varchar(32) NOT NULL DEFAULT 'royal_ivory',
  tagline varchar(200),
  owner_story text,
  scarcity_text varchar(120),
  landmarks jsonb NOT NULL DEFAULT '[]',
  pricing jsonb NOT NULL DEFAULT '{}',
  price_book jsonb NOT NULL DEFAULT '{"base":{},"extras":{}}',
  budget_bands jsonb NOT NULL DEFAULT '{"essential":"Essential","signature":"Signature","premium":"Premium"}',
  coupon_rules jsonb NOT NULL DEFAULT '{"enabled":false}',
  service_area text NOT NULL DEFAULT '',
  owner_reply_sla varchar(80) NOT NULL DEFAULT '',
  delivery_sla varchar(120) NOT NULL DEFAULT '',
  brochure_pdf_url text,
  onboarding_step smallint NOT NULL DEFAULT 0 CHECK (onboarding_step BETWEEN 0 AND 5),
  onboarding_completed boolean NOT NULL DEFAULT false,
  bot_enabled boolean NOT NULL DEFAULT false,
  status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS social_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider varchar(16) NOT NULL CHECK (provider IN ('instagram','facebook','youtube')),
  profile_url text NOT NULL,
  handle varchar(120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,provider)
);

CREATE TABLE IF NOT EXISTS tenant_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  hostname varchar(253) NOT NULL UNIQUE,
  verification_status varchar(16) NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','verified','rejected')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_e164 varchar(24) NOT NULL,
  role varchar(32) NOT NULL CHECK (role IN ('studio.owner','studio.manager','studio.sales','studio.editor','studio.viewer')),
  status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_e164)
);

CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  first_name varchar(80) NOT NULL DEFAULT '',
  last_name varchar(80) NOT NULL DEFAULT '',
  phone_e164 varchar(24),
  email_normalized varchar(254),
  occasion varchar(50) NOT NULL DEFAULT '',
  event_date date,
  event_date_text varchar(80),
  venue varchar(160) NOT NULL DEFAULT '',
  budget_band varchar(24),
  source varchar(32) NOT NULL DEFAULT 'smart_inquiry_form' CHECK (source IN ('smart_inquiry_form','entry_popup','whatsapp_bot','whatsapp_intent','instagram_dm','instagram_comment','youtube_bridge','facebook','meta_ad','walk_in','referral','unknown')),
  source_first varchar(32) NOT NULL DEFAULT 'unknown',
  source_last varchar(32) NOT NULL DEFAULT 'unknown',
  campaign varchar(160),
  utm jsonb NOT NULL DEFAULT '{}',
  status varchar(20) NOT NULL DEFAULT 'new' CHECK (status IN ('new','addressed','qualified','quote_requested','quoted','negotiating','booked','won','lost','spam')),
  score smallint NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  tier varchar(8) NOT NULL DEFAULT 'cold' CHECK (tier IN ('hot','warm','cold')),
  score_reasons jsonb NOT NULL DEFAULT '[]',
  lost_reason varchar(40),
  consent_contact boolean NOT NULL DEFAULT false,
  consent_marketing boolean NOT NULL DEFAULT false,
  consent_text text,
  consent_at timestamptz,
  bot_paused_until timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_contacted_at timestamptz,
  next_action_at timestamptz,
  owner_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_stage ON leads(tenant_id,status,score DESC,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_phone ON leads(tenant_id,phone_e164);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_created ON leads(tenant_id,created_at DESC);

CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_e164 varchar(24),
  email_normalized varchar(254),
  display_name varchar(160) NOT NULL DEFAULT '',
  consent_state varchar(16) NOT NULL DEFAULT 'unknown' CHECK (consent_state IN ('unknown','contact','marketing','opted_out')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_tenant_phone ON contacts(tenant_id,phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_tenant_email ON contacts(tenant_id,email_normalized) WHERE email_normalized IS NOT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  phone_e164 varchar(24) NOT NULL,
  code varchar(32) NOT NULL,
  discount_pct smallint NOT NULL CHECK (discount_pct BETWEEN 1 AND 50),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_e164),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone varchar(24) NOT NULL,
  code_hash char(64) NOT NULL,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_otps_lookup ON otps(tenant_id,phone,created_at DESC);

CREATE TABLE IF NOT EXISTS pageviews (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  visitor_id varchar(40) NOT NULL,
  path varchar(120) NOT NULL,
  utm jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pageviews_tenant_time ON pageviews(tenant_id,created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type varchar(40) NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_tenant_type ON events(tenant_id,type,created_at DESC);

CREATE TABLE IF NOT EXISTS gallery_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind varchar(20) NOT NULL DEFAULT 'gallery' CHECK (kind IN ('gallery','hero','about','owner','effects_raw','effects_graded','reel_poster')),
  occasion varchar(50),
  pair_id uuid,
  sort_order integer NOT NULL DEFAULT 1,
  image_url text NOT NULL,
  thumb_url text,
  alt varchar(160) NOT NULL DEFAULT '',
  caption varchar(140),
  video_id varchar(20),
  rights_reference text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gallery_tenant ON gallery_items(tenant_id,kind,occasion,sort_order);

CREATE TABLE IF NOT EXISTS reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  author varchar(80) NOT NULL,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body varchar(160) NOT NULL,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inbound_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider varchar(24) NOT NULL,
  provider_event_id text NOT NULL,
  event_type varchar(80) NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  signature_valid boolean NOT NULL DEFAULT false,
  state varchar(16) NOT NULL DEFAULT 'received' CHECK (state IN ('received','processing','processed','failed','ignored')),
  occurred_at timestamptz,
  processed_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,provider,provider_event_id)
);
CREATE INDEX IF NOT EXISTS idx_inbound_pending ON inbound_events(state,created_at);

CREATE TABLE IF NOT EXISTS bot_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  provider_message_id text,
  direction varchar(8) NOT NULL CHECK (direction IN ('inbound','outbound')),
  channel varchar(16) NOT NULL CHECK (channel IN ('whatsapp','instagram','web')),
  message_type varchar(24) NOT NULL DEFAULT 'text',
  body text NOT NULL DEFAULT '',
  delivery_status varchar(16) NOT NULL DEFAULT 'received' CHECK (delivery_status IN ('received','queued','sent','delivered','read','failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_messages_provider ON bot_messages(tenant_id,channel,provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bot_messages_lead ON bot_messages(tenant_id,lead_id,created_at);

CREATE TABLE IF NOT EXISTS short_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code varchar(12) NOT NULL,
  channel varchar(12) NOT NULL,
  keyword varchar(80),
  destination_url text NOT NULL,
  clicks integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,code)
);

-- Routing metadata contains only provider account IDs and tenant IDs; it is server-only and stores no credentials.
CREATE TABLE IF NOT EXISTS provider_account_routes (
  provider varchar(24) NOT NULL,
  external_account_id varchar(160) NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider,external_account_id)
);

CREATE TABLE IF NOT EXISTS tenant_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider varchar(24) NOT NULL CHECK (provider IN ('whatsapp','instagram','facebook','youtube')),
  external_account_id varchar(160),
  external_business_id varchar(160),
  encrypted_access_token text,
  encrypted_refresh_token text,
  token_expires_at timestamptz,
  granted_scopes jsonb NOT NULL DEFAULT '[]',
  status varchar(16) NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected','pending','authorized','expired','failed','paused')),
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,provider)
);

CREATE TABLE IF NOT EXISTS message_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,
  channel varchar(16) NOT NULL,
  recipient varchar(80) NOT NULL,
  message_type varchar(24) NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key varchar(120) NOT NULL,
  due_at timestamptz NOT NULL DEFAULT now(),
  state varchar(16) NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','processing','sent','skipped','failed','dead')),
  attempts smallint NOT NULL DEFAULT 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON message_outbox(state,due_at) WHERE state='queued';

CREATE TABLE IF NOT EXISTS dead_letter_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_type varchar(40) NOT NULL,
  payload jsonb NOT NULL,
  error text NOT NULL,
  attempts smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_runs (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_type varchar(40) NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status varchar(16) NOT NULL DEFAULT 'running',
  processed integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS ig_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ig_comment_id text NOT NULL,
  ig_media_id text,
  ig_user_id text,
  ig_username text,
  comment_text text NOT NULL,
  keyword varchar(40),
  status varchar(12) NOT NULL DEFAULT 'received' CHECK (status IN ('received','matched','replied','failed','skipped')),
  private_reply_sent_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,ig_comment_id)
);

CREATE TABLE IF NOT EXISTS attribution_refs (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ref_code varchar(12) NOT NULL,
  channel varchar(12) NOT NULL CHECK (channel IN ('instagram','facebook','youtube','ads','site')),
  ig_comment_id text,
  ig_media_id text,
  keyword varchar(80),
  occasion varchar(50),
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,ref_code)
);

CREATE TABLE IF NOT EXISTS conversation_state (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  wa_id varchar(24) NOT NULL,
  state varchar(24) NOT NULL DEFAULT 'GREETED',
  lang varchar(8) NOT NULL DEFAULT 'en',
  answers jsonb NOT NULL DEFAULT '{}',
  unrecognized_count smallint NOT NULL DEFAULT 0,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  opt_in_marketing boolean NOT NULL DEFAULT false,
  opt_in_at timestamptz,
  opt_in_text text,
  opted_out_at timestamptz,
  PRIMARY KEY (tenant_id,lead_id),
  UNIQUE (tenant_id,wa_id)
);

CREATE TABLE IF NOT EXISTS lead_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type varchar(40) NOT NULL,
  points smallint NOT NULL DEFAULT 0,
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_events_lead ON lead_events(tenant_id,lead_id,created_at);

CREATE TABLE IF NOT EXISTS message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name varchar(64) NOT NULL,
  language varchar(8) NOT NULL,
  category varchar(16) NOT NULL CHECK (category IN ('marketing','utility','authentication')),
  body text NOT NULL,
  provider_status varchar(16) NOT NULL DEFAULT 'draft' CHECK (provider_status IN ('draft','submitted','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,name,language)
);

CREATE TABLE IF NOT EXISTS nudge_queue (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind varchar(16) NOT NULL CHECK (kind IN ('soft_3h','final_22h','template_1','template_2','review_ask')),
  due_at timestamptz NOT NULL,
  sent_at timestamptz,
  cancelled_at timestamptz,
  attempts smallint NOT NULL DEFAULT 0,
  last_error text,
  UNIQUE (lead_id,kind)
);
CREATE INDEX IF NOT EXISTS idx_nudge_due ON nudge_queue(due_at) WHERE sent_at IS NULL AND cancelled_at IS NULL;

CREATE TABLE IF NOT EXISTS consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  subject_ref varchar(120) NOT NULL,
  purpose varchar(32) NOT NULL,
  action varchar(16) NOT NULL CHECK (action IN ('granted','revoked','corrected','deleted')),
  evidence text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_ref varchar(120) NOT NULL,
  actor_role varchar(32) NOT NULL,
  action varchar(80) NOT NULL,
  entity_type varchar(40) NOT NULL,
  entity_id varchar(80),
  before_data jsonb,
  after_data jsonb,
  request_id varchar(80),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_events(tenant_id,created_at DESC);

CREATE TABLE IF NOT EXISTS service_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version integer NOT NULL,
  name varchar(120) NOT NULL,
  currency char(3) NOT NULL DEFAULT 'INR',
  rule_json jsonb NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  approved_by varchar(120),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,version,name)
);

CREATE TABLE IF NOT EXISTS quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','sent','accepted','declined','expired')),
  pricebook_version integer NOT NULL,
  currency char(3) NOT NULL DEFAULT 'INR',
  items jsonb NOT NULL DEFAULT '[]',
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  discount numeric(12,2) NOT NULL DEFAULT 0,
  tax numeric(12,2) NOT NULL DEFAULT 0,
  total numeric(12,2) NOT NULL DEFAULT 0,
  expires_at timestamptz,
  approved_by varchar(120),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,lead_id,revision)
);

CREATE TABLE IF NOT EXISTS bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  quote_id uuid REFERENCES quotes(id),
  resource_key varchar(100) NOT NULL DEFAULT 'studio',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'hold' CHECK (status IN ('hold','pending_confirmation','confirmed','completed','cancelled')),
  approved_by varchar(120),
  idempotency_key varchar(120) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  UNIQUE (tenant_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_bookings_tenant_time ON bookings(tenant_id,resource_key,starts_at,ends_at);
DO $ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bookings_no_overlap') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
      EXCLUDE USING gist (tenant_id WITH =, resource_key WITH =, tstzrange(starts_at,ends_at,'[)') WITH &&)
      WHERE (status IN ('hold','pending_confirmation','confirmed'));
  END IF;
END $;

CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $
BEGIN
  RAISE EXCEPTION 'append-only record';
END $;
DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
DROP TRIGGER IF EXISTS consent_events_append_only ON consent_events;
CREATE TRIGGER consent_events_append_only BEFORE UPDATE OR DELETE ON consent_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_domains','social_profiles','tenant_memberships','contacts','leads','coupons','otps','pageviews','events','bot_messages','short_links','tenant_integrations','message_outbox','dead_letter_jobs','job_runs',
    'gallery_items','reviews','inbound_events','ig_comments','attribution_refs',
    'conversation_state','lead_events','message_templates','nudge_queue','consent_events',
    'audit_events','service_packages','quotes','bookings'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',
        t
      );
    END IF;
  END LOOP;
END $$;

-- Create a least-privilege app_user role separately in the database console.
-- Do not use the Neon owner/superuser connection string as the application DATABASE_URL.
