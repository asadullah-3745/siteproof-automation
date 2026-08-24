SiteProof Automation — Corrected Implementation Plan

Owner: Asad Ullah (Automation)
Aligned to: Technical Spec v1.2 §4–§6, Product Doc v1.0 §4–§7
Scope: Everything after a worker taps Close job
Replaces: SiteProof_Automation_Implementation_Plan.md



What was wrong in the previous plan







Issue



Why it is wrong



Correction





Diagram nests Critical Alert under Issue Routing



Spec: critical alert is immediate and separate from routine routing; fail-soft requires independence



Critical Alert is a sibling fan-out from the master (conditional)





Master “waits for branches then logs Actions”



Couples observability to orchestration; races with retries; contradicts fail-soft



Each sub-workflow owns its Action write (claim → side-effect → complete)





Idempotency = “check if Action exists, then act”



Classic TOCTOU race: two webhook retries both pass the check and double-send



Claim-first: write pending Action with unique (event_id, type) (or fail on unique constraint), then act, then mark success/failed





Thin vs fat webhook left open



Spec already defines payload: job id, org, findings with verdicts, cited clauses



Treat webhook as fat; optional GET /jobs/:id only for enrichment (report_id, signed media URLs, site)





Issue routing/System update need “report PDF link” while PDF is still rendering



Parallel fan-out cannot await PDF without breaking fail-soft / <60s alert path



Notifications and Sheet use admin job URL (always available). PDF is attached only to the Report record





Assumed PATCH /reports/:id without lifecycle context



Spec: POST /jobs/:id/close creates the report record, then emits webhook



Automation only attaches pdf_ref; request report_id on the event (or via GET)





Build order: Sheets first, PDF last



Product roadmap Week 3 exit: n8n generates PDF from sample JSON



Build PDF path early against sample payload; Sheets/routing after listener skeleton





Action types only implied



Product model lists route / alert / crm_update; PDF is also a side-effect



Use: report_generate, issue_route, critical_alert, system_update (+ skipped status when no-op)





Missing contracts



No Action API, no webhook auth, no event_id



Lock contracts below before wiring production webhooks



Ownership boundary (unchanged, clarified)

Asad owns: five MVP n8n workflows (listener + four effects). Follow-up scheduling and client delivery stay Later.

Does not own: finding/verdict content (Compliance API), supervisor policy beyond reading org config, admin UI (reads Action rows Asad writes).

Upstream: Event service emits job.closed on POST /jobs/:id/close (after report row is created).
Downstream: object store (PDF), supervisor email, critical-alert channel, Google Sheet, Action table → admin job-detail “automation action log”.



Target architecture

flowchart TD
  close["POST /jobs/:id/close"] --> jobSvc["Job service"]
  jobSvc --> reportRow["Creates Report record"]
  jobSvc --> eventSvc["Event service"]
  eventSvc -->|"job.closed webhook"| master["WF1 Job-close listener"]
  master --> validate["Validate + idempotency gate"]
  validate --> enrich["Optional GET /jobs/:id enrichment"]
  enrich --> fanout["Parallel fan-out"]
  fanout --> wf2["WF2 Report generation"]
  fanout --> wf3["WF3 Issue routing"]
  fanout --> wf5["WF5 System update"]
  fanout -->|"only if fail+high"| wf4["WF4 Critical alert"]
  wf2 --> pdf["PDF to object store + attach pdf_ref"]
  wf3 --> email["Supervisor email"]
  wf4 --> slack["Slack critical channel"]
  wf5 --> sheets["Google Sheets append"]
  wf2 --> actions["Action records"]
  wf3 --> actions
  wf4 --> actions
  wf5 --> actions
  actions --> admin["Admin job detail action log"]

Rules:





Fan-out is parallel. Failure in one sub-workflow must not stop the others (Continue on Fail / per-workflow error branch).



Critical Alert is never downstream of Issue Routing.



Master does not wait on PDF before kicking routing/alert/Sheet.



Locked MVP choices







Decision



Choice



Rationale





System update target



Google Sheets (one sheet, append row)



Spec §6 example; native n8n node; fastest demo





Issue routing channel



Email (SMTP/SendGrid)



Spec walkthrough: “emails the supervisor”





Critical alert channel



Slack (Incoming Webhook)



Spec: one channel, distinct from routine email





PDF pipeline



HTML template → hosted HTML-to-PDF API (e.g. PDFShift/DocRaptor) for MVP



Avoid owning Chromium ops in prototype; swap to self-hosted Puppeteer later if needed





Notification / Sheet “report link”



Admin job URL https://{admin}/jobs/{job_id}



Avoids PDF race; PDF still visible on job detail when ready





Org config for MVP



Single JSON/config row per org in n8n (or GET /orgs/:id/settings if Sufyan exposes it)



Admin “Integrations” UI is Later; Settings is MVP minimal



Contracts to lock with Sufyan (Week 1)

1. job.closed webhook (fat, per spec)

{
  "event_id": "evt_...",
  "event_type": "job.closed",
  "occurred_at": "ISO-8601",
  "job_id": "...",
  "report_id": "...",
  "org_id": "...",
  "site": "...",
  "worker_id": "...",
  "closed_at": "ISO-8601",
  "findings": [
    {
      "id": "...",
      "media_refs": ["..."],
      "transcript": "...",
      "extracted_attrs": {},
      "verdict": "pass|review|fail",
      "severity": "low|med|high",
      "cited_clause": { "ref": "SOP §4.2", "text": "..." },
      "reason": "..."
    }
  ],
  "counts": { "pass": 0, "review": 0, "fail": 0 }
}





Spec already requires job id, org, findings + verdicts + cited clauses.



Add event_id (idempotency), report_id (PDF attach), site, counts (Sheet mapping without recompute errors).



Webhook auth: shared secret header or HMAC signature (n8n Webhook header check).

2. APIs automation calls







Need



Endpoint (agree)



Purpose





Enrichment



GET /jobs/:id



Full job + signed/resolvable media URLs if webhook refs are opaque





Attach PDF



PATCH /reports/:id { "pdf_ref": "..." }



Spec creates report on close; automation fills pdf_ref (missing from §1.2.5 table — must be added)





Action audit



POST /actions + unique on (event_id, type)



Observable + claim-first idempotency





Optional config



GET /orgs/:id/automation-config



Supervisor email, Slack webhook URL, Sheet id — else hardcode one pilot org in n8n credentials/config for MVP

3. Action record shape

{
  "job_id": "...",
  "event_id": "...",
  "type": "report_generate|issue_route|critical_alert|system_update",
  "target": "storage|email:user@...|slack:#critical|sheet:...",
  "status": "pending|success|failed|skipped",
  "error": null,
  "timestamp": "ISO-8601"
}

Admin job detail already expects this log (Spec §3.3).



Workflow-by-workflow build plan

WF1 — Job-close listener (master)

Trigger: n8n Webhook on job.closed.

Steps:





Verify webhook secret/signature; reject unauthorized.



Validate required fields: event_id, job_id, org_id, report_id, findings[].



Optional enrichment: GET /jobs/:id when media URLs or site missing.



Compute flags: needs_routing (any review|fail), needs_critical (any fail + high).



Fan-out in parallel via Execute Workflow (wait enabled only if you need aggregated master status; prefer each child self-logging):





Always: WF2, WF5



If needs_routing: WF3 (else log Action issue_route/skipped in master or a tiny no-op path)



If needs_critical: WF4



Master may write one listener_received log only if useful; side-effect Actions live in children.

WF2 — Report generation

Trigger: Execute Workflow from master (job + findings + report_id).

Steps:





Claim Action report_generate / pending (unique on event_id+type). If duplicate → exit success (idempotent).



Resolve media to renderable URLs if needed.



Map header + findings into branded HTML (logo/colors from org branding when available).



HTML → PDF via chosen API.



Upload PDF to same object-store convention as Media & Storage.



PATCH /reports/:id with pdf_ref.



Mark Action success or failed + error.

Output: PDF in storage, linked on report, visible on admin/mobile job views.

WF3 — Issue routing

Trigger: Master when any finding is review or fail.

Steps:





Claim Action issue_route.



Filter to review|fail findings only.



Lookup supervisor from org automation config (MVP: one email per org; Later: by job type/severity).



Compose email: site, finding list (verdict, severity, clause ref, reason), link to admin job URL (not PDF).



Send email.



Complete Action.

If filter empty: should not be invoked; if invoked, Action skipped.

WF4 — Critical alert

Trigger: Master only when ≥1 finding has verdict=fail AND severity=high.

Steps:





Claim Action critical_alert.



Filter to those findings only (do not dump whole job).



Terse Slack message: site, finding, cited clause, admin job URL.



Complete Action.

Runs in parallel with WF3, not after it.

WF5 — System update (Google Sheets)

Trigger: Always from master.

Steps:





Claim Action system_update.



Map row: job_id, site, pass, review, fail, overall status, closed_at, admin job URL.



Append row (Sheets node). Idempotency: claim Action prevents duplicate rows on webhook retry; optionally also key a column on event_id.



Complete Action.

Do not wait for PDF. Sheet reflects outcome; PDF lives on the report/dashboard.



Design principles (how to implement them)





Idempotent — event_id + claim-first Action unique constraint; never “check then act” without claiming.



Observable — no external side-effect without an Action row; failures store error for admin visibility / manual retry.



Config-driven — supervisor email, Slack webhook, Sheet id, admin base URL live in per-org config (one pilot row for MVP).



Fail-soft — each Execute Workflow / branch has error handling; one dead integration does not block PDF or alerts.



Build order (aligned to Product roadmap)







Order



Work



Why





1



Agree webhook + Action + PATCH /reports/:id contracts



Unblocks parallel build (Product Week 1)





2



Sample job.closed JSON fixture + WF2 PDF path



Week 3 milestone: PDF from sample





3



WF1 skeleton (webhook auth, validate, fan-out stubs)



Ready when Event service lands





4



WF5 Google Sheets



Early E2E smoke without PDF dependency





5



WF3 email routing



Reuses message patterns





6



WF4 Slack critical



Same pattern; gate on fail+high





7



Wire real fan-out + claim-first Actions on all four



Integration week





8



Branding pass on HTML template



With Khurram assets; does not block 3–6



Testing plan





Per workflow: manual Execute with fixture payloads (all-pass; review-only; fail+high; mixed).



Idempotency: POST same webhook twice → one PDF, one email, one Slack, one Sheet row; second run shows Actions already claimed.



Fail-soft: break Sheet id → PDF + email + Slack still succeed; Sheet Action = failed.



No-op: all-pass job → no supervisor email, no Slack; Sheet + PDF still run; routing/critical skipped.



E2E staging: real Close job → <60s to PDF on report (Product success metric) + Action log on admin job detail.



Auth negative: webhook without secret → rejected, no Actions.



Explicitly out of scope (prototype)





Follow-up scheduling / calendar



Client delivery of PDF by email



Full routing matrix / admin Integrations UI



CRM (HubSpot etc.) — Sheets only for MVP



Owning Chromium PDF infra (unless PDF API proves insufficient)



Delivery checklist





Lock job.closed + event_id + report_id + webhook auth with Sufyan



Lock POST /actions and PATCH /reports/:id



Fixture payload + WF2 HTML→PDF→storage→PATCH



WF1 webhook skeleton + parallel fan-out



WF5 Sheets append



WF3 supervisor email (admin job URL)



WF4 Slack on fail+high only



Claim-first Action logging on all side-effects



Fail-soft + idempotency + all-pass tests



Staging E2E on a real closed job



Workspace note

[C:\Users\ADMIN\Documents\SiteProof Workflow](C:\Users\ADMIN\Documents\SiteProof Workflow) is currently empty. After plan approval, the corrected markdown plan should be written into that workspace (and optionally replace/supersede the Downloads copy). n8n workflow JSON exports and sample payloads can live beside it.