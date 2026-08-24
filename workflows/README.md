# SiteProof n8n workflows

Contract: [`../siteproof-contract/N8N_WEBHOOKS.md`](../siteproof-contract/N8N_WEBHOOKS.md).  
Backend wiring: [`../INTEGRATION.md`](../INTEGRATION.md).

Import children **02–05**, then **01**. Activate only the master. Webhook path: **`siteproof-job-closed`** (raw body).

## WF1

1. Verify HMAC (`timestamp.rawBody`, 5-minute skew).
2. Dedupe `X-SiteProof-Delivery-Id` and `job.id`.
3. Return **202** immediately.
4. Optional `GET /jobs/:id` with `X-Api-Key` if `photoUrls` missing.
5. **Parallel fan-out** (no wait): always WF2 + WF3 + WF4 + WF5. Children skip when filters are empty.

## WF2

HTML (org branding + findings) → Gotenberg → `POST /webhooks/n8n/report-ready` → `POST /webhooks/n8n/actions` `type=report.pdf`. On renderer error: `status=failed` on both.

## WF3

Always started by master. Filter review\|fail. Channel from `org.settings.alertChannel`. **Gmail** node sends HTML. Link `{adminOrigin}/jobs/{job.id}`. Action `routing.email` or `routing.slack` (or skipped).

Credential: **SiteProof Gmail** (OAuth2). Redirect URI: `http://localhost:5677/rest/oauth2-credential/callback`.

## WF4

Always started by master. Filter fail+high. `org.settings.criticalChannel`. **Gmail** by default. Action `alert.critical` (or skipped). Runs beside WF3, not after it.

## WF5

Upsert Sheet on `jobId`: jobId, site, workerEmail, pass, review, fail, headline, closedAt, reportLink. Action `system.sheet`.

## Manual fixtures

Pinned on **Manual test (fixture)** — backend `job.closed` shape, not the old snake_case payload.
