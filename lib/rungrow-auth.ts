import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const RUNGROW_PRODUCT_ID = "photo-studio-growth-os";
export type WorkforceHeaders = Pick<Headers, "get">;
export class WorkforceAuthError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export function signWorkforceRequest(body: Buffer | string, timestamp: string, workforceTenantId: string,
  externalTenantId: string, scopes: string[], secret: string): string {
  const canonicalScopes = [...new Set(scopes)].sort().join(",");
  const digest = createHash("sha256").update(body).digest("hex");
  const binding = [timestamp, RUNGROW_PRODUCT_ID, workforceTenantId, externalTenantId, canonicalScopes, digest].join(".");
  return "sha256=" + createHmac("sha256", secret).update(binding).digest("hex");
}
export function verifyWorkforceRequest(headers: WorkforceHeaders, body: Buffer, requiredScope: string,
  nowSeconds = Date.now() / 1000) {
  const secret = process.env.RUNGROW_WORKFORCE_HMAC_SECRET;
  if (!secret) throw new WorkforceAuthError("Workforce adapter is not configured", 503);
  const signature = headers.get("x-rungrow-signature") ?? "";
  const timestamp = headers.get("x-rungrow-timestamp") ?? "";
  const productId = headers.get("x-rungrow-product-id") ?? "";
  const externalTenantId = headers.get("x-rungrow-external-tenant-id") ?? "";
  const workforceTenantId = headers.get("x-rungrow-tenant-id") ?? "";
  const scopesHeader = headers.get("x-rungrow-scopes") ?? "";
  const scopes = scopesHeader.split(",").map(s => s.trim()).filter(Boolean);
  const canonicalScopes = [...new Set(scopes)].sort().join(",");
  if (!signature || !timestamp || !externalTenantId || !workforceTenantId || productId !== RUNGROW_PRODUCT_ID)
    throw new WorkforceAuthError("Missing or invalid adapter identity headers", 401);
  if (!/^\d{10}$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > 300)
    throw new WorkforceAuthError("Adapter timestamp outside 300-second replay window", 401);
  if (!scopes.length || canonicalScopes !== scopesHeader || !scopes.includes(requiredScope))
    throw new WorkforceAuthError("Missing required sorted product scope", 403);
  const expected = signWorkforceRequest(body, timestamp, workforceTenantId, externalTenantId, scopes, secret);
  const supplied = signature.startsWith("sha256=") ? signature : "sha256=" + signature;
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    throw new WorkforceAuthError("Invalid workforce HMAC signature", 401);
  return { externalTenantId, workforceTenantId, scopes };
}
