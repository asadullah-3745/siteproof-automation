# Integrate siteproof-automation ↔ siteproof-backend

## Flow (parallel)

```
Close job (backend)
  → HMAC POST /webhook/siteproof-job-closed
  → WF1 verifies, responds 202
  → Fan-out (parallel, wait=false):
       WF2 PDF → POST report-ready + action report.pdf
       WF3 Gmail supervisor → action routing.email (or skipped)
       WF4 Gmail critical → action alert.critical (or skipped)
       WF5 Google Sheet → action system.sheet
  → Admin job detail shows PDF + Automation log
```

Children always start together. WF3/WF4 self-skip when there is nothing to route/alert.

## Shared secrets (must match)

| Variable | Backend | Automation |
|---|---|---|
| HMAC | `WEBHOOK_SECRET` | baked into WF1 from same value |
| Callbacks | `N8N_API_KEY` | baked into HTTP/Code nodes as `X-Api-Key` |
| Webhook URL | `N8N_WEBHOOK_URL=http://localhost:5677/webhook/siteproof-job-closed` | n8n on `N8N_PORT=5677` |
| API base (from Docker n8n) | `http://localhost:3000/api/v1` | `SITEPROOF_API_URL=http://host.docker.internal:3000/api/v1` |

After editing automation `.env`:

```bash
node scripts/generate-workflows.js
```

## Org settings (payload `org.settings`)

Set in Admin → Settings (or seed):

- `supervisorEmail` — WF3/WF4 Gmail `to`
- `alertChannel` / `criticalChannel` — `email` \| `slack`
- `adminOrigin` — link base (`http://localhost:5173`)
- `sheetId` — Google Spreadsheet id (WF5; falls back to `SITEPROOF_SHEET_ID`)

## Wire n8n

1. `docker compose up -d` in this repo
2. Import **02 → 05**, then **01** (UI), **or** upsert with stable IDs:

```bash
# Create key in n8n UI: Settings → API
set N8N_OWNER_API_KEY=n8n_api_...
node scripts/import-workflows.js
```

3. On master, confirm each Execute node points at the matching child by name
4. Credentials: **SiteProof Gmail**, **SiteProof Google Sheets**
5. Activate **only** `01 - Job-close listener (master)`

## Backend checklist

```bash
# siteproof-backend .env
N8N_WEBHOOK_URL=http://localhost:5677/webhook/siteproof-job-closed
WEBHOOK_SECRET=<same as automation>
N8N_API_KEY=<same as automation>
```

`npm run seed` writes default automation settings onto the org.

## Verify

1. Close a job (or POST a signed fixture)
2. n8n Executions: WF1 + four children
3. Job detail → Automation: `report.pdf`, `routing.*`, `alert.critical`, `system.sheet`
