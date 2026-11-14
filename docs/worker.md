# Durable message outbox

Inbound provider webhooks are signature-verified, normalized and idempotently written to `inbound_events`. Eligible WhatsApp bot replies and Instagram private replies are written to `message_outbox`; they are not sent inline from the webhook request.

The Vercel Cron route `POST /api/cron/outbox` dispatches a bounded batch every 15 minutes. It rechecks the tenant integration, WhatsApp customer-service window, bot pause state, and Instagram comment's one-private-reply marker immediately before sending. Failed jobs retry with bounded attempts and move to `dead_letter_jobs` after five failures.

A cron schedule is not a substitute for provider approval. WhatsApp templates, out-of-window follow-ups, and marketing sends remain disabled unless approved templates and consent evidence are present. Verify Vercel cron availability/limits for the selected plan before enabling production dispatch.
