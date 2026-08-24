# SiteProof n8n webhooks

Locked contract for **Asad / the n8n repo**. The backend emits **one** signed event after Close job; n8n fans out; n8n writes PDF + action rows back. Do not invent a second event body. Mobile/admin contracts are in `FRONTEND_API.md`.

MVP automation (spec): job-close listener, branded PDF, issue routing, critical alert, one system update (Google Sheet **or** CRM). **Out of MVP:** follow-up calendar tasks, client-facing report email, extra CRMs. Build those folders later; do not block PDF/routing/alert/sheet on them.

---

## What is live vs what we will ship

| Phase | Automation-related API | Backend |
| --- | --- | --- |
| 1–2 | Login + `GET /jobs/:id` with **user JWT** (empty findings) | **live** — use to test HTTP nodes |
| 3 | Signed `photoUrls` on findings / webhook payload | **live** (upload now; findings attach in Phase 6) |
| 4 | Org rulebook exists so close payloads have `rulebookId` | **live** (seed AC SOP) |
| 6 | Findings + verdicts exist to put in the webhook | **live** |
| 7 | `POST /jobs/:id/close` → signed `job.closed` → your webhook; `POST /webhooks/n8n/report-ready`; `POST /webhooks/n8n/actions`; `PATCH /reports/:id`; `GET /jobs/:id` with **X-Api-Key** | **live** |
| 8 | Admin shows `actions[]` and PDF; issues queue | **will ship** (frontend) |

Today `POST /webhooks/n8n/*` checks `X-Api-Key` and writes report/action rows. `POST /jobs/:id/close` is live and enqueues signed `job.closed`.

---

## 1. Local vs deployed

| | This API | n8n Webhook URL (set as `N8N_WEBHOOK_URL`) |
| --- | --- | --- |
| Local | `http://localhost:3000/api/v1` | `http://localhost:5677/webhook/siteproof-job-closed` |
| Railway API + hosted n8n | `https://<railway-api-host>/api/v1` | `https://<n8n-host>/webhook/siteproof-job-closed` |

### Local

1. API: `npm run migrate && npm run seed && npm run dev` (`PHASES.md`).
2. Backend `.env`:

```
N8N_WEBHOOK_URL=http://localhost:5677/webhook/siteproof-job-closed
WEBHOOK_SECRET=<same secret n8n uses to verify HMAC>
N8N_API_KEY=<same key n8n sends as X-Api-Key>
SKIP_PGVECTOR=true
```

3. n8n Webhook node: **POST**, path `siteproof-job-closed`. Enable **raw body** (HMAC is over bytes, not re-serialized JSON).
4. Docker n8n + API on Windows host:
   - Backend `N8N_WEBHOOK_URL=http://localhost:5677/webhook/siteproof-job-closed`
   - n8n HTTP Request base URL `http://host.docker.internal:3000/api/v1`
5. pgAdmin is only for `event_outbox`, `reports`, `actions`. n8n must **not** use a Postgres node against SiteProof.

### Deployed (Railway API)

```
N8N_WEBHOOK_URL=https://<n8n-host>/webhook/siteproof-job-closed
WEBHOOK_SECRET=<production>
N8N_API_KEY=<production>
DATABASE_URL=<Railway Postgres — API service only>
```

n8n HTTP nodes: **public** API URL + `X-Api-Key`. Never the private Railway DB URL.

---

## 2. Credentials in n8n (create once)

| Credential | Used for |
| --- | --- |
| `WEBHOOK_SECRET` | Verify `X-SiteProof-Signature` |
| `N8N_API_KEY` | Header `X-Api-Key` on all calls **to** SiteProof |
| SMTP / Gmail or Slack | Routing + critical alert (Gmail OAuth in n8n for MVP) |
| Google Sheet **or** CRM | One system-of-record append/update |
| Optional Cloudinary | PDF hosting if you upload the report to Cloudinary; otherwise HTML-to-PDF → HTTP callback |

Also set n8n env `ADMIN_ORIGIN` (e.g. `http://localhost:3001`) for “open in dashboard” links, or read `job` + we will put `org.settings.adminOrigin` on the payload in Phase 7.

---

## 3. Event `job.closed` (the only inbound trigger)

**When (Phase 7):** `POST /jobs/:id/close` commits in one DB transaction: `jobs.status=closed`, `reports` row `pending`, issue rows for `review`/`fail` findings, `event_outbox` row `pending`. A dispatcher (not the worker’s HTTP request) POSTs to `N8N_WEBHOOK_URL`. Close stays fast even if n8n is down; outbox retries.

**Not in MVP:** `finding.failed` as its own webhook. Filter inside this payload.

### HTTP from backend → n8n

```
POST {N8N_WEBHOOK_URL}
Content-Type: application/json
X-SiteProof-Event: job.closed
X-SiteProof-Delivery-Id: <outbox uuid>
X-SiteProof-Timestamp: <unix seconds>
X-SiteProof-Signature: sha256=<hex>
```

```
HMAC_SHA256(WEBHOOK_SECRET, "{timestamp}.{raw_body}")
```

Reject if `|now - timestamp| > 300s`. Deduplicate on `X-SiteProof-Delivery-Id` **and** on `job.id` for side effects (re-delivery is normal).

Idempotent means: same `job.id` must not send a second Slack, must not append a second Sheet row, must not mint a second PDF unless the first PDF action was `failed`.

### Payload (lock this)

```json
{
  "event": "job.closed",
  "deliveryId": "3d2a0b1e-4c55-4c0e-9c3a-0b9f6e2a1111",
  "occurredAt": "2026-08-19T09:20:00.000Z",
  "org": {
    "id": "org-uuid",
    "name": "KeepCodeIn Solar",
    "branding": { "primaryColor": "#0B3D2E", "logoUrl": null },
    "settings": {
      "alertChannel": "email",
      "supervisorEmail": "supervisor@siteproof.local",
      "criticalChannel": "email",
      "adminOrigin": "http://localhost:3001",
      "sheetId": null
    }
  },
  "job": {
    "id": "job-uuid",
    "site": "12 Oak Lane, inverter bay",
    "jobType": "solar_install_inspection",
    "status": "closed",
    "closedAt": "2026-08-19T09:20:00.000Z",
    "rulebookId": "rulebook-uuid",
    "worker": {
      "id": "user-uuid",
      "name": "Ali Worker",
      "email": "worker@siteproof.local"
    },
    "counts": { "pass": 1, "review": 1, "fail": 1 },
    "headline": "fail",
    "findings": [
      {
        "id": "finding-uuid",
        "transcript": "wiring exposed near the inverter",
        "attributes": {
          "object": "cable",
          "condition": "exposed",
          "location": "inverter",
          "apparentIssue": "conductors not enclosed"
        },
        "verdict": "fail",
        "severity": "high",
        "citedClause": {
          "ref": "SOP §4.2",
          "text": "Conductors must be enclosed."
        },
        "reason": "Exposed cabling at the inverter is not enclosed.",
        "photoUrls": ["https://signed-url"]
      }
    ],
    "report": { "id": "report-uuid", "status": "pending" }
  }
}
```

- `headline`: `fail` if any fail, else `review` if any review, else `pass` (or `open` if no findings — still generate a thin PDF).
- `photoUrls` are short-lived. **Download bytes in the same run** for the PDF. If a URL 403s, `GET {API}/jobs/:id` with `X-Api-Key` (Phase 7) for fresh URLs.
- `org.settings` is the routing config. Do not hard-code the supervisor email in nodes.

### Fixture for today

Paste the JSON above into a Manual Trigger → the same Function/Split nodes. Swap to the Webhook node when Phase 7 is marked done in `PHASES.md`.

---

## 4. Master workflow (build this graph now)

```
Webhook (or Manual fixture)
  → Verify HMAC (skip on Manual)
  → Optional GET /jobs/:id (X-Api-Key) if photos missing
  → Split / parallel:
        ├─ Report generation          (always)
        ├─ Issue routing              (any review|fail)
        ├─ Critical alert             (any fail + high)
        └─ System update (Sheet/CRM)  (always)
  Each branch ends with POST /webhooks/n8n/actions
```

**Fail-soft:** PDF fail must not skip alert; Sheet fail must not skip PDF. No single “Error Trigger that aborts siblings”.

**Config-driven:** email / channel / sheet id from `org.settings`, not from node hard-codes.

---

## 5. n8n → SiteProof (all Phase 7 — live; key already enforced)

Every call:

```
X-Api-Key: {N8N_API_KEY}
X-SiteProof-Timestamp: <unix seconds>
Idempotency-Key: {jobId}:{type}
Content-Type: application/json
```

No user JWT. Wrong key → `401`. Timestamp must be within `WEBHOOK_REPLAY_WINDOW_SECONDS` (default 300) of the server clock, or the API returns `401`.

### `GET {API}/jobs/:id`

Phase 7 **will** accept `X-Api-Key` (today this route is JWT-only). Response = frontend job detail (`findings`, `photoUrls`, `report`, `actions`). Use when the webhook body is truncated or photo URLs expired.

### `POST {API}/webhooks/n8n/report-ready`

After PDF is in storage (n8n uploaded, or you POST bytes to `POST /media` with `type` unused — prefer reporting a `pdfStorageKey` the API already knows, or a public HTTPS URL in `pdfUrl`).

```json
{
  "reportId": "report-uuid",
  "jobId": "job-uuid",
  "status": "ready",
  "pdfStorageKey": "reports/job-uuid.pdf",
  "pdfUrl": null
}
```

On renderer crash:

```json
{
  "reportId": "report-uuid",
  "jobId": "job-uuid",
  "status": "failed",
  "error": "html-to-pdf timeout"
}
```

API sets `reports.status` and `pdf_storage_key`. Admin poll then shows the PDF.

Alias: `PATCH {API}/reports/:id` with the same JSON (also `X-Api-Key`).

### `POST {API}/webhooks/n8n/actions` — required for every side-effect

```json
{
  "jobId": "job-uuid",
  "type": "report.pdf",
  "target": "storage",
  "status": "ok",
  "metadata": { "pdfStorageKey": "reports/job-uuid.pdf" }
}
```

| `type` | `target` | When |
| --- | --- | --- |
| `report.pdf` | `storage` | PDF stored or renderer failed |
| `routing.email` | supervisor email address | review/fail digest sent |
| `routing.slack` | channel id | same digest |
| `alert.critical` | `email` or slack channel | high-severity fail |
| `system.sheet` | spreadsheet id | row upserted |
| `system.crm` | record id | CRM updated |

`status`: `ok` | `failed` | `skipped`.  
`skipped` = branch did not run (e.g. routing when all findings `pass`). Still log it so the dashboard is honest.

Admin Job detail reads `GET /jobs/:id/actions` (already live, empty until you POST).

---

## 6. Sub-flows to implement

### 6.1 Report generation — MVP — always

1. HTML template: org name + `branding.primaryColor` + `branding.logoUrl`, job site / worker / closedAt, then each finding: image, transcript, attributes, colour-coded verdict, `citedClause.ref` + `text`, `reason`.
2. HTML → PDF (n8n HTML/PDF node or Gotenberg).
3. Store the file (n8n binary → Cloudinary **or** HTTP `report-ready` with a `pdfStorageKey` / URL the API can persist).
4. `POST report-ready` `{ status: "ready" }`.
5. `POST actions` `type=report.pdf`.

If HTML-to-PDF throws: `report-ready` `{ status: "failed", error }` + action `failed`. Do not retry infinitely; one retry is enough.

### 6.2 Issue routing — MVP — if any `review` or `fail`

1. Filter `job.findings` where `verdict` in `review`,`fail`.
2. Look up `org.settings.supervisorEmail` or Slack from `alertChannel`.
3. Message: site, worker, headline counts, each finding’s reason + clause ref, link `{adminOrigin}/jobs/{job.id}`.
4. Action `routing.email` or `routing.slack`. If no findings match: action `skipped`.

### 6.3 Critical alert — MVP — if any `verdict=fail` AND `severity=high`

Separate from 6.2. Immediate, not batched. Include site, finding, cited clause. Action `alert.critical`. Else `skipped`.

### 6.4 System update — MVP — one target

Google Sheet **or** one CRM record. Columns / fields:

`jobId | site | workerEmail | pass | review | fail | headline | closedAt | reportLink`

Deduplicate on `jobId` (update row if it exists). Action `system.sheet` or `system.crm`.

### 6.5 Later (do not block MVP)

- Follow-up calendar event for fails
- Email branded PDF to the end client
- Extra Slack channels per job type

---

## 7. HMAC Code node

```javascript
const crypto = require('crypto');
const secret = $credentials.siteproofWebhook.secret;
const headers = $node["Webhook"].json.headers;
const ts = headers['x-siteproof-timestamp'];
const sig = String(headers['x-siteproof-signature'] || '').replace('sha256=', '');
const raw = $node["Webhook"].json.bodyRaw || JSON.stringify($node["Webhook"].json.body);

if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) {
  throw new Error('stale webhook');
}
const expected = crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
if (sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
  throw new Error('bad signature');
}
return $node["Webhook"].json.body;
```

Webhook node: **rawBody = true**. We sign `{unixSeconds}.{exact bytes of JSON}`.

---

## 8. Suggested n8n node list (MVP)

1. Webhook `siteproof-job-closed`
2. Code — HMAC
3. IF — already processed `job.id`? (static data / Data Store) → stop
4. HTTP GET `/jobs/:id` (optional)
5. Function — compute `needsRouting`, `needsCritical`, `headline`
6. **Parallel**
   - Function HTML → HTML-to-PDF → upload → HTTP `report-ready` → HTTP `actions`
   - IF routing → email/Slack → HTTP `actions`
   - IF critical → email/Slack → HTTP `actions`
   - HTTP/Google Sheets upsert → HTTP `actions`
7. (Optional) Set processed `job.id`

---

## 9. Outbox / debug

| `event_outbox.status` | Meaning |
| --- | --- |
| `pending` | Not 2xx from your Webhook yet |
| `delivered` | Your Webhook returned 2xx (sub-flow errors are **actions**, not this) |
| `failed` | Retries exhausted — `last_error` |

Local: pgAdmin → `event_outbox`, `reports`, `actions`.  
After Phase 7: `GET {API}/jobs/:id/actions` with a supervisor JWT or (Phase 7) API key.

Return **2xx from the Webhook node quickly** (after HMAC). Do the PDF in the same execution if it finishes in seconds; if PDF is slow, still 2xx the webhook and run PDF async **only if** you can still POST `report-ready` later. Preferred MVP: one execution, PDF included, webhook responds 200 at the **end** if the run is under ~30s; if not, 200 immediately after validate and run children — either is fine as long as actions are written.

---

## 10. End-to-end (matches the spec walkthrough)

1. Worker closes Job #218 on the phone → Phase 7 `POST /jobs/:id/close`.
2. You receive `job.closed` with fail/high on exposed cable + SOP §4.2.
3. PDF branded with org colour; supervisor email of failed findings; critical alert; Sheet row `Failed`.
4. Admin job detail: photos, clause, PDF, action log all `ok`.

Until Phase 7: implement 3–4 against the **fixture JSON**. Flip the trigger to Webhook when close is live.

---

## 11. n8n build checklist

- [ ] Webhook path `siteproof-job-closed` + raw body
- [ ] HMAC + 5-minute skew + delivery-id / job-id idempotency
- [ ] Four MVP branches, fail-soft
- [ ] `report-ready` + one `actions` POST per branch
- [ ] Routing + alert from `org.settings`, not hard-coded
- [ ] Sheet/CRM upsert on `job.id`
- [ ] Manual fixture payload for development
- [ ] HTTP credentials: `X-Api-Key` only, no JWT
- [ ] Later: client email, calendar follow-up (separate workflow)
