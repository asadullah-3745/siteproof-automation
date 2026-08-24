# Action callbacks (n8n → API)

Canonical details: [N8N_WEBHOOKS.md](N8N_WEBHOOKS.md) §5.

```
POST {API}/webhooks/n8n/actions
X-Api-Key: {N8N_API_KEY}
X-SiteProof-Timestamp: <unix seconds>
Idempotency-Key: {jobId}:{type}
```

```json
{
  "jobId": "uuid",
  "type": "report.pdf",
  "target": "storage",
  "status": "ok",
  "metadata": {}
}
```

`status`: `ok` | `failed` | `skipped`.

| type | when |
|---|---|
| `report.pdf` | PDF stored or renderer failed |
| `routing.email` / `routing.slack` | review/fail digest, or skipped |
| `alert.critical` | fail+high, or skipped |
| `system.sheet` | Sheet upsert |

PDF attach:

```
POST {API}/webhooks/n8n/report-ready
{ "reportId", "jobId", "status": "ready"|"failed", "pdfStorageKey", "pdfUrl", "error" }
```
