import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { verifyWorkforceRequest, WorkforceAuthError } from "../../../../../lib/rungrow-auth";
import { withTenant, type Db } from "../../../../../lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PRODUCT_ID = "photo-studio-growth-os";
const READ_SCOPE = PRODUCT_ID + ":read";
const WRITE_SCOPE = PRODUCT_ID + ":write";
const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

function authenticate(req: NextRequest, body: Buffer, requiredScope: string) {
  return verifyWorkforceRequest(req.headers, body, requiredScope);
}

async function summary(tenantId: string) {
  return withTenant(tenantId, async (db: Db) => {
    const [leads, qualified, booked, recent] = await Promise.all([
      db.query<{ count: string }>("SELECT count(*)::text AS count FROM leads WHERE tenant_id=$1 AND status <> 'spam'", [tenantId]),
      db.query<{ count: string }>("SELECT count(*)::text AS count FROM leads WHERE tenant_id=$1 AND status IN ('qualified','quote_requested','quoted','negotiating')", [tenantId]),
      db.query<{ count: string }>("SELECT count(*)::text AS count FROM leads WHERE tenant_id=$1 AND status IN ('booked','won')", [tenantId]),
      db.query<{ created_at: string; status: string; source: string }>("SELECT created_at,status,source FROM leads WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 10", [tenantId]),
    ]);
    return { product_id: PRODUCT_ID, api_version: "v1", tenant_id: tenantId,
      metrics: { total_leads: Number(leads.rows[0]?.count ?? 0), qualified_leads: Number(qualified.rows[0]?.count ?? 0),
        booked_leads: Number(booked.rows[0]?.count ?? 0) },
      recent_leads: recent.rows };
  });
}

export async function GET(req: NextRequest) {
  try {
    const body = Buffer.alloc(0);
    const auth = authenticate(req, body, READ_SCOPE);
    if (new URL(req.url).pathname !== "/api/v1/workforce/summary") return fail(404, "Not found");
    return NextResponse.json(await summary(auth.externalTenantId));
  } catch (error) {
    const e = error as Error & { status?: number };
    return fail((e instanceof WorkforceAuthError ? e.status : e.status) ?? 503, e.message ?? "Workforce summary unavailable");
  }
}

export async function POST(req: NextRequest) {
  try {
    const raw = Buffer.from(await req.arrayBuffer());
    const auth = authenticate(req, raw, WRITE_SCOPE);
    if (new URL(req.url).pathname !== "/api/v1/workforce/prospects/handoff") return fail(404, "Not found");
    const key = req.headers.get("idempotency-key") ?? "";
    if (!key || key.length > 200) return fail(400, "A valid Idempotency-Key is required");
    const payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    if (payload.is_sandbox === true) return fail(403, "Sandbox executions cannot create product-side prospects");
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    const phone = typeof payload.phone === "string" ? payload.phone.trim() : "";
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    const sourceUrl = typeof payload.source_url === "string" ? payload.source_url : "";
    const correlationId = typeof payload.correlation_id === "string" ? payload.correlation_id : "";
    const approvalId = typeof payload.approval_id === "string" ? payload.approval_id : "";
    if (!name || (!phone && !email) || !/^https:\/\//i.test(sourceUrl) || !correlationId || !approvalId) {
      return fail(422, "name, phone or email, HTTPS source_url, correlation_id and approval_id are required");
    }
    const requestHash = createHash("sha256").update(raw).digest("hex");
    const result = await withTenant(auth.externalTenantId, async (db: Db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [auth.externalTenantId + ":" + (phone || email)]);
      const claim = await db.query<{ id: string }>(
        "INSERT INTO rungrow_adapter_idempotency (tenant_id,endpoint,idempotency_key,request_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,endpoint,idempotency_key) DO NOTHING RETURNING id",
        [auth.externalTenantId, "/api/v1/workforce/prospects/handoff", key, requestHash]);
      if (!claim.rows[0]) {
        const existing = await db.query<{ request_hash: string; response: unknown }>(
          "SELECT request_hash,response FROM rungrow_adapter_idempotency WHERE tenant_id=$1 AND endpoint=$2 AND idempotency_key=$3",
          [auth.externalTenantId, "/api/v1/workforce/prospects/handoff", key]);
        if (existing.rows[0]?.request_hash !== requestHash) return { conflict: true as const };
        return { replay: true as const, response: existing.rows[0]?.response ?? { status: "PROCESSING" } };
      }
      const existingLead = await db.query<{ id: string }>(
        "SELECT id FROM leads WHERE tenant_id=$1 AND (($2 <> '' AND phone_e164=$2) OR ($3 <> '' AND email_normalized=$3)) ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        [auth.externalTenantId, phone, email]);
      let leadId = existingLead.rows[0]?.id;
      if (leadId) {
        await db.query("UPDATE leads SET status='qualified',source_url=$2,correlation_id=$3,approval_id=$4,updated_at=now() WHERE tenant_id=$1 AND id=$5",
          [auth.externalTenantId, sourceUrl, correlationId, approvalId, leadId]);
      } else {
        const inserted = await db.query<{ id: string }>(
          "INSERT INTO leads (tenant_id,first_name,phone_e164,email_normalized,source,status,source_url,correlation_id,approval_id) VALUES ($1,$2,$3,$4,'referral','qualified',$5,$6,$7) RETURNING id",
          [auth.externalTenantId, name, phone || null, email || null, sourceUrl, correlationId, approvalId]);
        leadId = inserted.rows[0].id;
      }
      const response = { status: "ACCEPTED", product_id: PRODUCT_ID, api_version: "v1", lead_id: leadId,
        external_tenant_id: auth.externalTenantId, correlation_id: correlationId, approval_id: approvalId };
      await db.query("UPDATE rungrow_adapter_idempotency SET response=$4,completed_at=now() WHERE tenant_id=$1 AND endpoint=$2 AND idempotency_key=$3",
        [auth.externalTenantId, "/api/v1/workforce/prospects/handoff", key, JSON.stringify(response)]);
      await db.query("INSERT INTO events (tenant_id,type,meta) VALUES ($1,'rungrow.prospect_handoff',$2)",
        [auth.externalTenantId, JSON.stringify({ lead_id: leadId, correlation_id: correlationId, approval_id: approvalId })]);
      return { replay: false as const, response };
    });
    if ("conflict" in result && result.conflict) return fail(409, "Idempotency-Key was already used with a different payload");
    return NextResponse.json({ ...result.response, ...(result.replay ? { replayed: true } : {}) }, { status: result.replay ? 200 : 202 });
  } catch (error) {
    const e = error as Error & { status?: number };
    return fail(e.status ?? 503, e.message ?? "Prospect handoff unavailable");
  }
}
