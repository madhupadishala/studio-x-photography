# Studio X — Photography Growth OS

Independent Next.js application for the Studio X photography experience and owner workspace.

## Preview

- Public website: https://studio-x-blush.vercel.app
- Owner dashboard: https://studio-x-blush.vercel.app/dashboard
- Owner login UI: https://studio-x-blush.vercel.app/dashboard/login
- Five-step onboarding: https://studio-x-blush.vercel.app/onboarding
- Gallery: https://studio-x-blush.vercel.app/studio-x/gallery
- Effects and package estimator: https://studio-x-blush.vercel.app/studio-x/effects
- About: https://studio-x-blush.vercel.app/studio-x/about
- Inquiry: https://studio-x-blush.vercel.app/studio-x/inquire

## Current implementation boundary

The deployed preview includes the public photography experience, responsive owner dashboard, sample lead pipeline, social profile URL management UI, content planner, automation rule preview, login screen and five-step onboarding.

The preview uses demonstration data. Dashboard edits are in-memory; onboarding progress is browser-local. The login screen is explicitly a UI preview and does not authenticate a real owner. Social profile URLs do not grant API access. WhatsApp links use a generic handoff until the studio owner supplies and verifies the official number.

## Production phases from the build guide

1. **Phase A — Skeleton:** public routes, responsive visual system, gallery/effects/about/inquiry, owner login, onboarding and dashboard UI.
2. **Phase B — Browser features:** pure utilities and tests, carousel/gallery interactions, form validation, date picker, WhatsApp link builder, browser persistence and client-side media handling.
3. **Phase C — APIs and automation:** Neon schema and tenant isolation, OTP/session auth, real dashboard queries/actions, lead and coupon persistence, analytics, Cloudflare R2 uploads, onboarding API, WhatsApp/Instagram webhooks and conversation automation.
4. **Phase D — Launch:** isolation and security verification, rate limits, accessibility, performance, privacy and end-to-end tests.

Phase C integrations must not be represented as active until credentials, callbacks and the database are configured and the documented tenant-isolation checks pass. Social platform integrations require official OAuth scopes and approvals.

## Local development

```bash
npm install
npm run dev
npm run typecheck
```

No production secrets belong in this repository. Configure secrets only in local environment files or deployment environment settings.
