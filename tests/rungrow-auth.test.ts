import { afterEach, describe, expect, it } from "vitest";
import { signWorkforceRequest, verifyWorkforceRequest, WorkforceAuthError } from "../lib/rungrow-auth";

const secret = "local-contract-test-secret-with-more-than-32-bytes";
const externalTenant = "11111111-1111-4111-8111-111111111111";
const workforceTenant = "22222222-2222-4222-8222-222222222222";
const scope = "photo-studio-growth-os:read";
const timestamp = "1795152000";
const body = Buffer.from("");

function headers(scopes = [scope], rawBody = body, ts = timestamp) {
  const canonical = [...new Set(scopes)].sort().join(",");
  return new Headers({
    "X-RunGrow-Signature": signWorkforceRequest(rawBody, ts, workforceTenant, externalTenant, scopes, secret),
    "X-RunGrow-Timestamp": ts,
    "X-RunGrow-Product-Id": "photo-studio-growth-os",
    "X-RunGrow-External-Tenant-Id": externalTenant,
    "X-RunGrow-Tenant-Id": workforceTenant,
    "X-RunGrow-Scopes": canonical,
  });
}

afterEach(() => { delete process.env.RUNGROW_WORKFORCE_HMAC_SECRET; });

describe("RunGrow v1 HMAC contract", () => {
  it("accepts a valid scope-bound signature and distinct tenant bindings", () => {
    process.env.RUNGROW_WORKFORCE_HMAC_SECRET = secret;
    expect(verifyWorkforceRequest(headers(), body, scope, Number(timestamp))).toMatchObject({
      externalTenantId: externalTenant, workforceTenantId: workforceTenant, scopes: [scope],
    });
  });
  it("rejects timestamps older than the 300-second replay window", () => {
    process.env.RUNGROW_WORKFORCE_HMAC_SECRET = secret;
    expect(() => verifyWorkforceRequest(headers(), body, scope, Number(timestamp) + 301))
      .toThrowError(WorkforceAuthError);
  });
  it("rejects a payload changed after signing", () => {
    process.env.RUNGROW_WORKFORCE_HMAC_SECRET = secret;
    expect(() => verifyWorkforceRequest(headers(), Buffer.from("tampered"), scope, Number(timestamp)))
      .toThrowError(/Invalid workforce HMAC signature/);
  });
  it("rejects unsorted or duplicate scopes", () => {
    process.env.RUNGROW_WORKFORCE_HMAC_SECRET = secret;
    const h = headers(["photo-studio-growth-os:write", scope]);
    h.set("X-RunGrow-Scopes", scope + ",photo-studio-growth-os:write");
    expect(() => verifyWorkforceRequest(h, body, scope, Number(timestamp)))
      .toThrowError(/sorted product scope/);
  });
  it("fails closed with 503 when the shared secret is absent", () => {
    expect(() => verifyWorkforceRequest(headers(), body, scope, Number(timestamp)))
      .toThrowError(WorkforceAuthError);
  });
});
