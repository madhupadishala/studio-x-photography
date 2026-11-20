import { signWorkforceRequest } from "./rungrow-auth";
import { rawQuery, withTenant } from "./server";

const PRODUCT_ID = "photo-studio-growth-os";
const SCOPE = PRODUCT_ID + ":write";
type PendingEvent = { id: string; event_type: string; payload: Record<string, unknown>; recognised_revenue_inr: string };

export async function dispatchRunGrowTelemetry(batchSize = 25): Promise<{ delivered: number; failed: number }> {
  const endpoint = process.env.RUNGROW_WEBHOOK_URL;
  const secret = process.env.RUNGROW_WORKFORCE_HMAC_SECRET;
  const workforceTenantId = process.env.RUNGROW_WORKFORCE_TENANT_ID;
  if (!endpoint || !secret || !workforceTenantId) throw new Error("RunGrow telemetry delivery is not configured");
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "https:" || !parsed.pathname.includes("/v1/adapters/" + PRODUCT_ID + "/webhooks")) {
    throw new Error("RUNGROW_WEBHOOK_URL must be the HTTPS RunGrow product webhook endpoint");
  }
  const tenants = await rawQuery<{ id: string }>("SELECT id FROM tenants WHERE status='active' ORDER BY created_at LIMIT 500");
  let delivered = 0;
  let failed = 0;
  for (const tenant of tenants) {
    const pending = await withTenant(tenant.id, db => db.query<PendingEvent>(
      "SELECT id,event_type,payload,recognised_revenue_inr::text FROM rungrow_telemetry_outbox WHERE state='pending' AND next_attempt_at<=now() ORDER BY created_at LIMIT $2",
      [tenant.id, Math.max(1, Math.min(100, batchSize))]
    ));
    for (const event of pending.rows) {
      const payload = {
        product_id: PRODUCT_ID,
        external_tenant_id: tenant.id,
        event_type: event.event_type,
        recognised_revenue_inr: event.event_type.startsWith("invoice.") ? Number(event.recognised_revenue_inr) : 0,
        data: event.payload,
      };
      const body = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const scopes = [SCOPE];
      const signature = signWorkforceRequest(body, timestamp, workforceTenantId, tenant.id, scopes, secret);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-RunGrow-Signature": signature,
            "X-RunGrow-Timestamp": timestamp,
            "X-RunGrow-Product-Id": PRODUCT_ID,
            "X-RunGrow-Tenant-Id": workforceTenantId,
            "X-RunGrow-External-Tenant-Id": tenant.id,
            "X-RunGrow-Scopes": scopes.join(","),
            "Idempotency-Key": PRODUCT_ID + ":" + tenant.id + ":" + event.id,
          },
          body,
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error("RunGrow webhook returned HTTP " + response.status);
        await withTenant(tenant.id, db => db.query(
          "UPDATE rungrow_telemetry_outbox SET state='delivered',delivered_at=now(),last_error=NULL WHERE tenant_id=$1 AND id=$2 AND state='pending'",
          [tenant.id, event.id]
        ));
        delivered += 1;
      } catch (error) {
        await withTenant(tenant.id, db => db.query(
          "UPDATE rungrow_telemetry_outbox SET attempts=attempts+1,state=CASE WHEN attempts+1>=12 THEN 'dead' ELSE 'pending' END,next_attempt_at=now()+LEAST(power(2,LEAST(attempts+1,10))::int,3600)*interval '1 second',last_error=$3 WHERE tenant_id=$1 AND id=$2",
          [tenant.id, event.id, error instanceof Error ? error.message.slice(0, 500) : "Webhook delivery failed"]
        ));
        failed += 1;
      }
    }
  }
  return { delivered, failed };
}
