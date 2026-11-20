import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "../app/api/v1/workforce/[...path]/route";
import { signWorkforceRequest } from "../lib/rungrow-auth";
import { rawQuery, withTenant } from "../lib/server";
import { dispatchRunGrowTelemetry } from "../lib/rungrow-telemetry";

const secret = "ci-rungrow-hmac-secret-with-at-least-32-characters";
const workforceTenant = "22222222-2222-4222-8222-222222222222";
const externalTenantA = "11111111-1111-4111-8111-111111111111";
const externalTenantB = "33333333-3333-4333-8333-333333333333";
const productId = "photo-studio-growth-os";
const now = () => String(Math.floor(Date.now() / 1000));

function signedRequest(method: "GET" | "POST", path: string, tenant: string, scope: "read" | "write",
  payload?: Record<string, unknown>, idempotencyKey?: string) {
  const body = Buffer.from(payload ? JSON.stringify(payload) : "");
  const timestamp = now();
  const scopes = [productId + ":" + scope];
  const headers = new Headers({
    "X-RunGrow-Signature": signWorkforceRequest(body, timestamp, workforceTenant, tenant, scopes, secret),
    "X-RunGrow-Timestamp": timestamp,
    "X-RunGrow-Product-Id": productId,
    "X-RunGrow-Tenant-Id": workforceTenant,
    "X-RunGrow-External-Tenant-Id": tenant,
    "X-RunGrow-Scopes": scopes.join(","),
  });
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  if (method === "POST") headers.set("Content-Type", "application/json");
  return new NextRequest("https://product.test" + path, { method, headers, body: method === "POST" ? body : undefined });
}

async function createTenant(id: string, slug: string) {
  await rawQuery(
    "INSERT INTO tenants (id,slug,studio_name) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING",
    [id, slug, "Workforce contract test"]
  );
}

beforeAll(async () => {
  process.env.RUNGROW_WORKFORCE_HMAC_SECRET = secret;
  await createTenant(externalTenantA, "rungrow-contract-a");
  await createTenant(externalTenantB, "rungrow-contract-b");
});
afterAll(async () => {
  for (const tenant of [externalTenantA, externalTenantB]) {
    await withTenant(tenant, async db => {
      await db.query("DELETE FROM rungrow_adapter_idempotency WHERE tenant_id=$1", [tenant]);
      await db.query("DELETE FROM rungrow_telemetry_outbox WHERE tenant_id=$1", [tenant]);
      await db.query("DELETE FROM leads WHERE tenant_id=$1", [tenant]);
    });
    await rawQuery("DELETE FROM tenants WHERE id=$1", [tenant]);
  }
  delete process.env.RUNGROW_WORKFORCE_HMAC_SECRET;
});

describe("RunGrow workforce request-level PostgreSQL contract", () => {
  it("returns only metrics and leads belonging to the signed external tenant", async () => {
    await withTenant(externalTenantA, db => db.query(
      "INSERT INTO leads (tenant_id,first_name,source,status) VALUES ($1,'Tenant A lead','referral','qualified')", [externalTenantA]
    ));
    await withTenant(externalTenantB, db => db.query(
      "INSERT INTO leads (tenant_id,first_name,source,status) VALUES ($1,'Tenant B secret','referral','qualified')", [externalTenantB]
    ));
    const response = await GET(signedRequest("GET", "/api/v1/workforce/summary", externalTenantA, "read"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.metrics.total_leads).toBe(1);
    expect(JSON.stringify(body)).not.toContain("Tenant B secret");

    const leadsResponse = await GET(signedRequest("GET", "/api/v1/workforce/leads", externalTenantA, "read"));
    const leadsBody = await leadsResponse.json();
    expect(leadsResponse.status).toBe(200);
    expect(leadsBody.leads).toHaveLength(1);
    expect(JSON.stringify(leadsBody)).not.toContain("Tenant B secret");

    const quotesResponse = await GET(signedRequest("GET", "/api/v1/workforce/quotes", externalTenantA, "read"));
    const bookingsResponse = await GET(signedRequest("GET", "/api/v1/workforce/bookings", externalTenantA, "read"));
    expect(quotesResponse.status).toBe(200);
    expect(bookingsResponse.status).toBe(200);
  });

  it("creates one qualified prospect, replays the same idempotency key, and rejects a changed payload", async () => {
    const payload = {
      name: "RunGrow Qualified Prospect",
      phone: "+919876543210",
      source_url: "https://rungrow.example/prospects/42",
      correlation_id: "corr-contract-42",
      approval_id: "approval-contract-42",
    };
    const first = await POST(signedRequest("POST", "/api/v1/workforce/prospects/handoff", externalTenantA, "write", payload, "contract-key-42"));
    const firstBody = await first.json();
    expect(first.status).toBe(202);
    expect(firstBody.status).toBe("ACCEPTED");

    const replay = await POST(signedRequest("POST", "/api/v1/workforce/prospects/handoff", externalTenantA, "write", payload, "contract-key-42"));
    expect(replay.status).toBe(200);
    expect((await replay.json()).replayed).toBe(true);

    const changed = await POST(signedRequest("POST", "/api/v1/workforce/prospects/handoff", externalTenantA, "write",
      { ...payload, name: "Changed payload" }, "contract-key-42"));
    expect(changed.status).toBe(409);

    const rows = await withTenant(externalTenantA, db => db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM leads WHERE tenant_id=$1 AND phone_e164=$2", [externalTenantA, payload.phone]
    ));
    expect(Number(rows.rows[0].count)).toBe(1);
  });

  it("persists lifecycle telemetry with zero revenue and recognised invoice revenue only", async () => {
    await withTenant(externalTenantA, async db => {
      await db.query("INSERT INTO events (tenant_id,type,meta) VALUES ($1,'lead.qualified',$2)", [externalTenantA, JSON.stringify({ recognised_revenue_inr: 9500 })]);
      await db.query("INSERT INTO events (tenant_id,type,meta) VALUES ($1,'invoice.recognised',$2)", [externalTenantA, JSON.stringify({ recognised_revenue_inr: 2500 })]);
      const rows = await db.query<{ event_type: string; recognised_revenue_inr: string }>(
        "SELECT event_type,recognised_revenue_inr::text FROM rungrow_telemetry_outbox WHERE tenant_id=$1 ORDER BY created_at", [externalTenantA]
      );
      expect(rows.rows.find(row => row.event_type === "lead.qualified")?.recognised_revenue_inr).toBe("0.00");
      expect(rows.rows.find(row => row.event_type === "invoice.recognised")?.recognised_revenue_inr).toBe("2500.00");
    });
  });

  it("signs outbound telemetry and marks the outbox delivered only after HTTP success", async () => {
    process.env.RUNGROW_WEBHOOK_URL = "https://api.rungrow.example/v1/adapters/photo-studio-growth-os/webhooks";
    process.env.RUNGROW_WORKFORCE_TENANT_ID = workforceTenant;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-RunGrow-Signature")).toMatch(/^sha256=/);
      expect(headers.get("X-RunGrow-Scopes")).toBe("photo-studio-growth-os:write");
      return new Response("{}", { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await dispatchRunGrowTelemetry();
      expect(result.delivered).toBeGreaterThanOrEqual(1);
      expect(fetchMock).toHaveBeenCalled();
      const rows = await withTenant(externalTenantA, db => db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM rungrow_telemetry_outbox WHERE tenant_id=$1 AND state='delivered'", [externalTenantA]
      ));
      expect(Number(rows.rows[0].count)).toBeGreaterThanOrEqual(1);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.RUNGROW_WEBHOOK_URL;
      delete process.env.RUNGROW_WORKFORCE_TENANT_ID;
    }
  });
});
