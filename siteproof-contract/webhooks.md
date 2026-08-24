# Automation contracts

Canonical n8n contract (HMAC, payload, callbacks): **[N8N_WEBHOOKS.md](N8N_WEBHOOKS.md)**.

This folder previously described a snake_case `event_id` webhook. That shape is **retired**. The backend emits the nested camelCase `job.closed` body in `N8N_WEBHOOKS.md` only.

Inbound path: `POST /webhook/siteproof-job-closed`.

n8n → API:

- `POST /api/v1/webhooks/n8n/report-ready`
- `POST /api/v1/webhooks/n8n/actions`
- `GET /api/v1/jobs/:id` (optional, `X-Api-Key`)
