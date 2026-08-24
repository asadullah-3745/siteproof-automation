# SiteProof — Automation

n8n workflows that run after a SiteProof job is closed: PDF report, supervisor email, critical alert, and Google Sheet update.

- Contract: [`siteproof-contract/N8N_WEBHOOKS.md`](siteproof-contract/N8N_WEBHOOKS.md)
- Backend wiring: [`INTEGRATION.md`](INTEGRATION.md)
- Workflow notes: [`workflows/README.md`](workflows/README.md)

## Prerequisites

- Docker Desktop
- SiteProof backend on port **3000**
- Optional: admin dashboard on **5173**

## Quick start

```bash
copy .env.example .env
# Edit .env — set WEBHOOK_SECRET, N8N_API_KEY, Cloudinary, sheet id, supervisor email
docker compose up -d
node scripts/generate-workflows.js
```

n8n UI: **http://localhost:5677** (override with `N8N_PORT`).

Config is **baked from `.env` into workflow JSON** at generate time. Code nodes do not read `$env`. After any `.env` change, regenerate and re-sync/import.

### Secrets — do not commit

| Tracked | Ignored (local only) |
|---|---|
| `.env.example` | `.env`, `.env.*` |
| Placeholder workflow JSON | `n8n_data/` (SQLite, OAuth tokens, executions) |
| Docs / scripts | `credentials.json`, `*.pem`, `*.key`, Cloudinary/Google secrets |

Before pushing workflow JSON that you generated with a real `.env`, rewrite placeholders:

```bash
# Windows PowerShell
$env:ENV_FILE='.env.example'; node scripts/generate-workflows.js
# Then regenerate again from your private .env for local use
node scripts/generate-workflows.js
```

## Backend webhook

In **siteproof-backend** `.env`:

```
N8N_WEBHOOK_URL=http://localhost:5677/webhook/siteproof-job-closed
WEBHOOK_SECRET=<same as automation>
N8N_API_KEY=<same as automation>
```

If the API also runs in Docker, point it at `http://host.docker.internal:5677/webhook/siteproof-job-closed`.

From Docker n8n → host API: `SITEPROOF_API_URL=http://host.docker.internal:3000/api/v1`.

## Import / sync workflows

**Option A — UI:** import `workflows/02` … `05`, then `01`. Create Gmail + Google Sheets OAuth credentials in n8n. Activate master.

**Option B — live SQLite sync** (this machine’s Compose volume):

```bash
docker compose stop n8n
python scripts/sync-live-n8n.py
docker compose up -d n8n
```

Credential names default to **Gmail account** and **Google Sheets account** (`N8N_GMAIL_CREDENTIAL_NAME` / `N8N_SHEETS_CREDENTIAL_NAME`).

## Workflows

| File | Role |
|---|---|
| `01-job-close-listener.json` | HMAC webhook `siteproof-job-closed`, 202, parallel fan-out to WF2–WF5 |
| `02-report-generation.json` | HTML → Gotenberg → Cloudinary PDF → `report-ready` + action `report.pdf` |
| `03-issue-routing.json` | review\|fail → Gmail → `routing.email` (else skipped) |
| `04-critical-alert.json` | fail+high → Gmail → `alert.critical` (else skipped) |
| `05-system-update.json` | Sheet append → `system.sheet` |

All callbacks use `X-Api-Key`, `X-SiteProof-Timestamp`, and `Idempotency-Key` (no JWT).

### Cloudinary PDF delivery

Upload succeeds even when delivery is blocked. On a free Cloudinary plan, enable **Settings → Security → Allow delivery of PDF and ZIP files**, then open the report link from the admin job page.

Sheet columns (header row):  
`jobId | site | workerEmail | pass | review | fail | headline | closedAt | reportLink`

## Test

```bash
node scripts/e2e-close-job.js          # full close-job against live API + n8n
node scripts/e2e-webhook-test.js       # signed webhook smoke test
```

| Case | Expect |
|---|---|
| Mixed / fail+high | PDF + Sheet + routing email + critical |
| All-pass | PDF + Sheet; routing/critical skipped |
| Bad HMAC | `401`, no fan-out |
| Same `job.id` twice | no duplicate side-effects when prior action was `ok` |

Dashboard: `http://localhost:5173/#/jobs/{id}` → PDF + Automation log.
