# Studio X — production architecture

## Runtime boundaries
- Next.js App Router is the public website and owner workspace/API tier.
- PostgreSQL is the system of record. Every tenant-owned table uses forced row-level security; each transaction sets `app.tenant_id` from the verified owner session or a tenant resolved from a verified hostname.
- The application database role must be least-privilege and must not own tables or bypass RLS. Never use the Neon owner role as `DATABASE_URL`.
- Cloudflare R2 uses short-lived signed PUT URLs. Object keys are tenant-prefixed and gallery writes validate that the resulting URL belongs to that tenant.
- WhatsApp and Meta integrations are official-provider adapters. Missing credentials or approval means disabled, never simulated as connected.

## Security invariants
1. Tenant ID for protected actions comes only from the signed HttpOnly session.
2. Public requests resolve tenants from verified hostname mappings; the request body cannot select a tenant.
3. All SQL values are parameterized. Dynamic column names are restricted to static allowlists.
4. OTPs are HMAC-hashed, expire after 10 minutes, allow at most five verification attempts, and requests are throttled.
5. Outbound marketing messages require recorded consent, provider approval, eligible messaging window, and a non-opted-out contact.
6. Provider webhooks must pass signature verification and idempotency checks before processing.
7. Pricing, quotes, booking confirmation, and outbound sends require owner authorization; no autonomous booking confirmation.

## Current implementation
- Database migration: `db/schema.sql`.
- Tenant transaction, signed session, OTP, R2 presigning and lead creation: `lib/server.ts`.
- Pure lead scoring, WhatsApp link and conversation state machine: `lib/domain.ts`.
- API route surface: `app/api/[...path]/route.ts`.
- Deterministic unit tests: `tests/domain.test.ts`.

## Activation boundaries
The code does not claim that OAuth, WhatsApp messaging, R2 uploads or persistent storage are live until the matching production credentials, tenant configuration and provider approval are installed and the end-to-end acceptance tests pass. The first owner membership is established only after the OTP is sent to the tenant's configured owner phone.
