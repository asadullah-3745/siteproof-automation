# SiteProof — Automation (Asad)

Everything after "Close job". One master workflow listens for `job.closed` and fans out.

## Run n8n locally
```bash
docker compose up -d       # n8n at http://localhost:5678
```
Then import the JSON files in `workflows/` (n8n: Workflows -> Import from File).

## Workflows
| File | Does |
|---|---|
| `01-job-close-listener.json` | Webhook on `job.closed`, validates, fans out |
| `02-report-generation.json`  | Build a branded PDF from findings + verdicts |
| `03-issue-routing.json`      | Send review/fail findings to the right supervisor |
| `04-critical-alert.json`     | Immediate alert on any high-severity fail |
| `05-system-update.json`      | Append job outcome to Google Sheet / CRM |

## Contract
Consumes the `job.closed` payload in `siteproof-contract/webhooks.md`.
Must be **idempotent** on `job.id`. Every side-effect should write an Action record back to the platform.

## MVP
Listener + report PDF + one routing email + one Sheet row. The rest is Later.
