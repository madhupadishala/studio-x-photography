# Studio X — Photography Growth OS

Independent Next.js application and Vercel project for the Studio X photography experience and owner workspace. It is not part of the Creative i Studios repository.

## Preview

- Public website: https://studio-x-blush.vercel.app
- Owner dashboard: https://studio-x-blush.vercel.app/dashboard
- Owner login: https://studio-x-blush.vercel.app/dashboard/login
- Five-step onboarding: https://studio-x-blush.vercel.app/onboarding
- Gallery: https://studio-x-blush.vercel.app/studio-x/gallery
- Effects and package estimator: https://studio-x-blush.vercel.app/studio-x/effects
- About: https://studio-x-blush.vercel.app/studio-x/about
- Inquiry: https://studio-x-blush.vercel.app/studio-x/inquire
- YouTube-to-WhatsApp attribution bridge: `/go/youtube?studio=<tenant-slug>`

## Implemented in this repository

- Responsive public photography website, gallery, effects, about and inquiry experiences.
- Owner workspace with live tenant-scoped enquiry and summary APIs, lead status actions, owner-alert feed, social profile metadata, and the 30-day Instagram-to-WhatsApp funnel by keyword and media.
- Five-step tenant onboarding API, OTP/session authentication, lead intake, analytics events, signed media upload flow for R2, and tenant-scoped PostgreSQL access with row-level security policies.
- WhatsApp Cloud API integration adapters, signed webhook verification, interactive button/list parsing, deterministic conversation qualification, consent evidence, STOP handling, lead scoring, and an outbox dispatcher.
- Instagram comment ingestion, whole-word keyword matching, one-private-reply guard, six-day eligibility window, attribution references, and WhatsApp handoff.
- Tenant-timezone-aware follow-up worker: quiet hours, 3-hour and 22-hour free-form nudges, approved-template follow-ups, and post-event review request scheduling.
- YouTube CTA bridge that creates a per-click attribution reference and redirects to WhatsApp; channel links can ask the visitor where they discovered the studio.
- Unit tests for the documented lead-scoring cases, conversation state machine, date parsing, phone normalization, WhatsApp links, and nudge policy.
- Meta app-review evidence register and 16-item external provider verification log.

## Live integration boundary

The code paths are implemented, but a successful Vercel build is not proof of live provider operation. Real database persistence, OTP delivery, R2 uploads, Meta/Google OAuth, webhook delivery, WhatsApp messages, and scheduled jobs require the corresponding environment variables, verified provider accounts, approved scopes/templates, database migration, and live test evidence.

No live Meta, WhatsApp, Instagram or YouTube account has been verified in this repository. Social passwords are never collected; profile URLs alone do not grant API access. Instagram private replies are intentionally limited to one attempt per eligible comment. WhatsApp follow-ups are gated by the customer-service window, consent, opt-out, lead status, bot pause, and quiet hours. No guaranteed lead volume, ranking, reach or revenue is claimed.

## Database and operations

- Apply `db/schema.sql` to the Neon database using a least-privilege application role. Do not use the database owner/superuser connection string as `DATABASE_URL`.
- Configure secrets using `.env.example` as the key inventory. Never commit real secrets.
- Vercel cron invokes `/api/cron/outbox` every 15 minutes and requires `CRON_SECRET`.
- Complete `docs/verification-log.md`, `docs/app-review.md`, and the live end-to-end checks before enabling production automations.
- Test with provider-owned test accounts and numbers until the guide's go-live conditions are met.

## Local development

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
```


## RunGrow Workforce Adapter v1

The product-side workforce routes are available at `/api/v1/workforce/summary` and `/api/v1/workforce/prospects/handoff`. Requests require scope-bound HMAC-SHA256 headers, a 300-second timestamp window, distinct Workforce/external tenant bindings, and a sorted `X-RunGrow-Scopes` header. The handoff route requires an `Idempotency-Key` and persists its request hash and approval/correlation/source provenance.

Before enabling the adapter, apply `db/migrations/20261120_rungrow_workforce_v1.sql` after `db/schema.sql`, then configure `RUNGROW_WORKFORCE_HMAC_SECRET` in the deployment secret store. Do not commit the secret. Payment, WhatsApp and media provider calls remain unavailable unless their production credentials and provider verification are configured; production code must not report synthetic provider success.
