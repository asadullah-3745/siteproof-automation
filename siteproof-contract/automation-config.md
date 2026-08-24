# Org settings (from `job.closed`)

Do not call `GET /orgs/:id/automation-config`. Routing lives on the webhook payload:

`org.settings.supervisorEmail`, `alertChannel`, `criticalChannel`, `adminOrigin`, `sheetId`.

See [N8N_WEBHOOKS.md](N8N_WEBHOOKS.md).
