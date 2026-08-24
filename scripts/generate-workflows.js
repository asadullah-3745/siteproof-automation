#!/usr/bin/env node
/**
 * Generates n8n workflow JSON from siteproof-contract / N8N_WEBHOOKS.md
 * Run: node scripts/generate-workflows.js
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'workflows');
const ROOT = path.join(__dirname, '..');

function loadDotEnv() {
  const preferred = process.env.ENV_FILE
    ? path.resolve(ROOT, process.env.ENV_FILE)
    : path.join(ROOT, '.env');
  const file = fs.existsSync(preferred) ? preferred : path.join(ROOT, '.env.example');
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const DOTENV = loadDotEnv();
function cfg(key, fallback) {
  const v = DOTENV[key];
  return v != null && v !== '' ? v : fallback;
}

/** Literals baked into Code nodes — n8n $env is unreliable in Docker for some setups. */
const LIT = {
  apiBase: cfg('SITEPROOF_API_URL', 'http://host.docker.internal:3000/api/v1').replace(/\/$/, ''),
  apiKey: cfg('N8N_API_KEY', ''),
  webhookSecret: cfg('WEBHOOK_SECRET', cfg('SITEPROOF_WEBHOOK_SECRET', 'change-me-to-a-long-random-webhook-secret')),
  fromEmail: cfg('SITEPROOF_FROM_EMAIL', 'alerts@siteproof.local'),
  supervisorEmail: cfg('SITEPROOF_SUPERVISOR_EMAIL', 'supervisor@siteproof.local'),
  slackWebhook: cfg('SITEPROOF_SLACK_WEBHOOK', ''),
  sheetId: cfg('SITEPROOF_SHEET_ID', ''),
  sheetTab: cfg('SITEPROOF_SHEET_TAB', 'Job Outcomes'),
  pdfApiUrl: cfg('SITEPROOF_PDF_API_URL', 'http://gotenberg:3000/forms/chromium/convert/html'),
  adminOrigin: cfg('ADMIN_ORIGIN', cfg('SITEPROOF_ADMIN_URL', 'http://localhost:5173')).replace(/\/$/, ''),
  orgName: cfg('SITEPROOF_ORG_NAME', 'KeepCodeIn Solar'),
  logoUrl: cfg('SITEPROOF_LOGO_URL', ''),
  primaryColor: cfg('SITEPROOF_PRIMARY_COLOR', '#0B3D2E'),
  cloudName: cfg('CLOUDINARY_CLOUD_NAME', ''),
  cloudApiKey: cfg('CLOUDINARY_API_KEY', ''),
  cloudApiSecret: cfg('CLOUDINARY_API_SECRET', ''),
  cloudFolder: cfg('CLOUDINARY_FOLDER', 'siteproof/reports'),
  gmailCredName: cfg('N8N_GMAIL_CREDENTIAL_NAME', 'Gmail account'),
  sheetsCredName: cfg('N8N_SHEETS_CREDENTIAL_NAME', 'Google Sheets account'),
};

function gmailSendNode(id, name, position) {
  return {
    id,
    name,
    type: 'n8n-nodes-base.gmail',
    typeVersion: 2.1,
    position,
    onError: 'continueErrorOutput',
    credentials: {
      gmailOAuth2: { id: 'gmail-account', name: LIT.gmailCredName },
    },
    parameters: {
      resource: 'message',
      operation: 'send',
      sendTo: '={{ $json.email.to }}',
      subject: '={{ $json.email.subject }}',
      emailType: 'html',
      message: '={{ $json.email.html }}',
      options: {
        appendAttribution: false,
      },
    },
  };
}

function codeNode(id, name, position, jsCode, extra = {}) {
  return {
    id,
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
    parameters: { mode: 'runOnceForAllItems', jsCode: jsCode.trim() },
    ...extra,
  };
}

function sticky(id, position, width, height, color, content) {
  return {
    id,
    name: id,
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position,
    parameters: { content, width, height, color },
  };
}

function noOp(id, name, position) {
  return {
    id,
    name,
    type: 'n8n-nodes-base.noOp',
    typeVersion: 1,
    position,
    parameters: {},
  };
}

function ifBool(id, name, position, leftValue) {
  return {
    id,
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: `${id}-cond`,
            leftValue,
            rightValue: '',
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
  };
}

function executeSub(id, name, position, workflowId, cachedName) {
  // Prefer stable workflow `id` from our JSON. After import, if the Execute
  // node is empty, pick the child by name (cachedResultName). waitForSubWorkflow
  // false = fire all children in parallel without blocking the master.
  return {
    id,
    name,
    type: 'n8n-nodes-base.executeWorkflow',
    typeVersion: 1.2,
    position,
    onError: 'continueRegularOutput',
    parameters: {
      source: 'database',
      workflowId: {
        __rl: true,
        value: workflowId,
        mode: 'id',
        cachedResultName: cachedName,
      },
      mode: 'once',
      options: { waitForSubWorkflow: false },
    },
  };
}

function connectionsFrom(edges) {
  const connections = {};
  for (const edge of edges) {
    const [from, to, out = 0, type = 'main'] = edge;
    if (!connections[from]) connections[from] = { main: [] };
    if (!connections[from][type]) connections[from][type] = [];
    const bucket = connections[from][type];
    while (bucket.length <= out) bucket.push([]);
    const targets = Array.isArray(to) ? to : [to];
    for (const t of targets) {
      bucket[out].push({ node: t, type: 'main', index: 0 });
    }
  }
  return connections;
}

function workflow({ id, name, nodes, connections }) {
  return {
    id,
    name,
    active: false,
    nodes,
    connections,
    pinData: {},
    settings: { executionOrder: 'v1', callerPolicy: 'workflowsFromSameOwner' },
    meta: { templateCredsSetupCompleted: false },
    tags: [],
  };
}

const CONFIG_JS = `
function envConfig() {
  return {
    api_base_url: ${JSON.stringify(LIT.apiBase)},
    api_key: ${JSON.stringify(LIT.apiKey)},
    webhook_secret: ${JSON.stringify(LIT.webhookSecret)},
    from_email: ${JSON.stringify(LIT.fromEmail)},
    supervisor_email_default: ${JSON.stringify(LIT.supervisorEmail)},
    slack_webhook_url: ${JSON.stringify(LIT.slackWebhook)},
    pdf_api_url: ${JSON.stringify(LIT.pdfApiUrl)},
    sheet_tab: ${JSON.stringify(LIT.sheetTab)},
    sheet_id_default: ${JSON.stringify(LIT.sheetId)},
    admin_origin_default: ${JSON.stringify(LIT.adminOrigin)},
    org_name_default: ${JSON.stringify(LIT.orgName)},
    logo_url_default: ${JSON.stringify(LIT.logoUrl)},
    primary_color_default: ${JSON.stringify(LIT.primaryColor)},
    cloudinary_cloud_name: ${JSON.stringify(LIT.cloudName)},
    cloudinary_api_key: ${JSON.stringify(LIT.cloudApiKey)},
    cloudinary_api_secret: ${JSON.stringify(LIT.cloudApiSecret)},
    cloudinary_folder: ${JSON.stringify(LIT.cloudFolder)},
  };
}

function normalizeFinding(f) {
  const clause = f.citedClause || f.cited_clause || {};
  const photos = f.photoUrls || f.media_refs || [];
  return {
    id: f.id,
    transcript: f.transcript || '',
    attributes: f.attributes || f.extracted_attrs || {},
    extracted_attrs: f.attributes || f.extracted_attrs || {},
    verdict: f.verdict,
    severity: f.severity,
    citedClause: clause,
    cited_clause: clause,
    reason: f.reason || '',
    photoUrls: photos,
    media_refs: photos,
  };
}

function countFindings(findings) {
  return {
    pass: findings.filter(function (f) { return f.verdict === 'pass'; }).length,
    review: findings.filter(function (f) { return f.verdict === 'review'; }).length,
    fail: findings.filter(function (f) { return f.verdict === 'fail'; }).length,
  };
}

function headlineFromCounts(counts) {
  if (counts.fail) return 'fail';
  if (counts.review) return 'review';
  if (counts.pass) return 'pass';
  return 'open';
}

function wrapPayload(input) {
  const envc = envConfig();
  let body = input;
  if (input && input.body && (input.body.job || input.body.event === 'job.closed' || input.body.event_type)) {
    body = input.body;
  }
  if (body.job && body.job.id) {
    const jobIn = body.job;
    const org = body.org || {};
    const settings = org.settings || {};
    const branding = org.branding || {};
    const findings = (jobIn.findings || []).map(normalizeFinding);
    const counts = jobIn.counts || countFindings(findings);
    const admin = String(settings.adminOrigin || envc.admin_origin_default || 'http://localhost:5173').replace(/\\/$/, '');
    const job = Object.assign({}, jobIn, {
      findings: findings,
      counts: counts,
      headline: jobIn.headline || headlineFromCounts(counts),
      jobType: jobIn.jobType || jobIn.job_type || '',
    });
    return {
      deliveryId: body.deliveryId || '',
      occurredAt: body.occurredAt,
      org: org,
      job: job,
      flags: {
        needs_routing: findings.some(function (f) { return f.verdict === 'review' || f.verdict === 'fail'; }),
        needs_critical: findings.some(function (f) { return f.verdict === 'fail' && String(f.severity).toLowerCase() === 'high'; }),
        needs_enrichment: findings.some(function (f) {
          return !(f.photoUrls && f.photoUrls.length);
        }),
      },
      config: Object.assign({}, envc, {
        supervisor_email: settings.supervisorEmail || envc.supervisor_email_default,
        alert_channel: settings.alertChannel || 'email',
        critical_channel: settings.criticalChannel || 'email',
        sheet_id: settings.sheetId || envc.sheet_id_default,
        admin_origin: admin,
        timestamp: String(Math.floor(Date.now() / 1000)),
        branding: {
          name: org.name || envc.org_name_default,
          logo_url: branding.logoUrl || envc.logo_url_default,
          primary_color: branding.primaryColor || envc.primary_color_default,
        },
      }),
      job_url: admin + '/jobs/' + job.id,
      report_url: admin + '/jobs/' + job.id,
    };
  }
  throw new Error('INVALID_PAYLOAD: expected job.closed body with job.id');
}

async function siteproofRequest(method, urlPath, body, idempotencyType, ctx) {
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Key': ctx.config.api_key,
    'X-SiteProof-Timestamp': ts,
  };
  if (idempotencyType) headers['Idempotency-Key'] = ctx.job.id + ':' + idempotencyType;
  return this.helpers.httpRequest({
    method: method,
    url: ctx.config.api_base_url + urlPath,
    headers: headers,
    body: body,
    json: true,
    ignoreHttpStatusErrors: true,
    returnFullResponse: true,
  });
}

async function postAction(ctx, type, target, status, metadata) {
  const key = ctx.job.id + ':' + type;
  const staticData = $getWorkflowStaticData('global');
  staticData.claims = staticData.claims || {};
  staticData.claims[key] = { status: status, at: new Date().toISOString() };
  try {
    await siteproofRequest.call(this, 'POST', '/webhooks/n8n/actions', {
      jobId: ctx.job.id,
      type: type,
      target: target || null,
      status: status,
      metadata: metadata || {},
    }, type, ctx);
  } catch (e) {}
  return { type: type, target: target, status: status, metadata: metadata || {} };
}

function alreadyDone(jobId, type) {
  const staticData = $getWorkflowStaticData('global');
  staticData.claims = staticData.claims || {};
  const row = staticData.claims[jobId + ':' + type];
  return row && row.status === 'ok';
}
`.trim();

function hmacJs() {
  return `
const crypto = require('crypto');
${CONFIG_JS}

const item = $input.first();
const rawJson = item.json || {};
const headers = rawJson.headers || {};

const secret = String(envConfig().webhook_secret || '');
const ts = headers['x-siteproof-timestamp'] || headers['X-SiteProof-Timestamp'] || '';
const sigHeader = String(headers['x-siteproof-signature'] || headers['X-SiteProof-Signature'] || '');
const sig = sigHeader.replace(/^sha256=/i, '');

if (!secret || secret.length < 16) {
  return [{ json: { ok: false, httpStatus: 401, error: 'WEBHOOK_SECRET is not configured' } }];
}
if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) {
  return [{ json: { ok: false, httpStatus: 401, error: 'stale webhook' } }];
}

let raw = '';
try {
  if (item.binary && (item.binary.data || item.binary.body)) {
    const field = item.binary.data ? 'data' : 'body';
    const buf = await this.helpers.getBinaryDataBuffer(0, field);
    raw = Buffer.from(buf).toString('utf8');
  }
} catch (e) {}
if (!raw) {
  raw = rawJson.bodyRaw || (rawJson.body ? JSON.stringify(rawJson.body) : JSON.stringify(rawJson));
}

const expected = crypto.createHmac('sha256', secret).update(String(ts) + '.' + raw).digest('hex');
const a = Buffer.from(sig, 'utf8');
const b = Buffer.from(expected, 'utf8');
if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
  return [{ json: { ok: false, httpStatus: 401, error: 'bad signature' } }];
}

let payload;
try {
  payload = rawJson.body && rawJson.body.job ? rawJson.body : JSON.parse(raw);
} catch (e) {
  payload = rawJson.body || rawJson;
}
if (!payload.job || !payload.job.id) {
  return [{ json: { ok: false, httpStatus: 400, error: 'INVALID_PAYLOAD: missing job.id' } }];
}
if (payload.event && payload.event !== 'job.closed') {
  return [{ json: { ok: false, httpStatus: 400, error: 'INVALID_PAYLOAD: expected event job.closed' } }];
}

const deliveryId = headers['x-siteproof-delivery-id'] || headers['X-SiteProof-Delivery-Id'] || payload.deliveryId;
payload.deliveryId = payload.deliveryId || deliveryId;

const staticData = $getWorkflowStaticData('global');
staticData.deliveries = staticData.deliveries || {};
staticData.jobs = staticData.jobs || {};
if (deliveryId && staticData.deliveries[deliveryId]) {
  const ctx = wrapPayload(payload);
  ctx.ok = true;
  ctx.httpStatus = 202;
  ctx.duplicateDelivery = true;
  return [{ json: ctx }];
}
if (deliveryId) staticData.deliveries[deliveryId] = true;

const ctx = wrapPayload(payload);
ctx.ok = true;
ctx.httpStatus = 202;
ctx.duplicateJob = Boolean(staticData.jobs[ctx.job.id]);
return [{ json: ctx }];
`.trim();
}

function normalizeJs() {
  return `
${CONFIG_JS}
const item = $input.first().json;
if (item.job && item.config && item.job.id) {
  return [{ json: item }];
}
try {
  const ctx = wrapPayload(item);
  ctx.ok = true;
  return [{ json: ctx }];
} catch (e) {
  return [{ json: { ok: false, httpStatus: 400, error: e.message } }];
}
`.trim();
}

function postActionJs(type, targetJs, statusLiteral, metadataJs) {
  return `
${CONFIG_JS}
let ctx = $input.first().json || {};
if (!ctx.job || !ctx.job.id || !ctx.config) {
  try { ctx = { ...$('Normalize input').first().json, ...ctx }; } catch (e) {}
}
if (!ctx.job || !ctx.job.id) {
  return [{ json: { ok: false, error: 'Missing job context before action ' + ${JSON.stringify(type)}, inputKeys: Object.keys($input.first().json || {}) } }];
}
const type = ${JSON.stringify(type)};
const status = ${statusLiteral};
const target = ${targetJs};
const metadata = ${metadataJs || '{}'};
if (status === 'ok' && alreadyDone(ctx.job.id, type)) {
  return [{ json: { ...ctx, action: { type: type, status: 'ok', duplicate: true } } }];
}
const action = await postAction.call(this, ctx, type, target, status, metadata);
return [{ json: { ...ctx, action: action } }];
`.trim();
}

function captureErrorJs() {
  return `
${CONFIG_JS}
let prior = {};
try { prior = $('Normalize input').first().json || {}; } catch (e) {}
const incoming = $input.first().json || {};
const message = (incoming.error && (incoming.error.message || incoming.error.description))
  || incoming.message
  || incoming.error_message
  || 'side-effect failed';
return [{ json: { ...prior, ...incoming, error_message: String(message) } }];
`.trim();
}

function alreadyJs(type) {
  return `
${CONFIG_JS}
const ctx = $input.first().json || {};
if (!ctx.job || !ctx.job.id) {
  return [{
    json: {
      ok: false,
      httpStatus: 400,
      error: 'Missing job on input — run from Manual test / When called by master so Normalize runs first',
      inputKeys: Object.keys(ctx),
      already: false,
    },
  }];
}
const already = alreadyDone(ctx.job.id, ${JSON.stringify(type)});
return [{ json: { ...ctx, already: already } }];
`.trim();
}

function childPrefix({ wf, title, color, steps, type }) {
  return [
    sticky(`${wf}-note`, [-40, 0], 500, 300, color, ['## ' + title, '', steps].join('\n')),
    {
      id: `${wf}-exec-trigger`,
      name: 'When called by master',
      type: 'n8n-nodes-base.executeWorkflowTrigger',
      typeVersion: 1.1,
      position: [0, 360],
      parameters: { inputSource: 'passthrough' },
    },
    {
      id: `${wf}-manual`,
      name: 'Manual test (fixture)',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [0, 560],
      parameters: {},
    },
    codeNode(`${wf}-normalize`, 'Normalize input', [280, 440], normalizeJs()),
    codeNode(`${wf}-already`, 'Check job idempotency', [560, 440], alreadyJs(type)),
    ifBool(`${wf}-if-done`, 'Already ok for this job?', [840, 440], '={{ Boolean($json.already) }}'),
    noOp(`${wf}-dup`, 'Idempotent exit', [1120, 280]),
  ];
}

function childPrefixEdges(afterNode) {
  return [
    ['When called by master', 'Normalize input'],
    ['Manual test (fixture)', 'Normalize input'],
    ['Normalize input', 'Check job idempotency'],
    ['Check job idempotency', 'Already ok for this job?'],
    ['Already ok for this job?', 'Idempotent exit', 0],
    ['Already ok for this job?', afterNode, 1],
  ];
}

function wf1() {
  const nodes = [
    sticky('wf1-note', [-40, 0], 560, 360, 7, [
      '## WF1 — job.closed listener',
      '',
      'Path: `POST /webhook/siteproof-job-closed` (raw body)',
      'HMAC: `sha256 = HMAC(WEBHOOK_SECRET, timestamp.rawBody)`',
      'Dedupe: delivery id + job.id',
      'After 202: fan-out **in parallel** to WF2–WF5.',
      'WF2 PDF · WF3 routing · WF4 critical · WF5 sheet',
      'Children skip / no-op when filters empty.',
      'Config from `org.settings`. Callbacks use `X-Api-Key`.',
    ].join('\n')),

    {
      id: 'wf1-webhook',
      name: 'Webhook job.closed',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 420],
      webhookId: 'siteproof-job-closed',
      parameters: {
        httpMethod: 'POST',
        path: 'siteproof-job-closed',
        responseMode: 'responseNode',
        options: { rawBody: true },
      },
    },
    {
      id: 'wf1-manual',
      name: 'Manual test (fixture)',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [0, 640],
      parameters: {},
    },
    codeNode('wf1-hmac', 'Verify HMAC', [280, 420], hmacJs()),
    codeNode('wf1-normalize', 'Normalize fixture', [280, 640], normalizeJs()),
    noOp('wf1-merge', 'Validated payload', [560, 520]),
    ifBool('wf1-if-ok', 'Payload valid?', [800, 520], '={{ $json.ok !== false }}'),
    {
      id: 'wf1-respond-err',
      name: 'Respond 4xx',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.1,
      position: [1080, 720],
      parameters: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify({ accepted: false, error: $json.error }) }}',
        options: { responseCode: '={{ $json.httpStatus || 401 }}' },
      },
    },
    {
      id: 'wf1-respond-ok',
      name: 'Respond 202 accepted',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.1,
      position: [1080, 400],
      parameters: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify({ accepted: true, deliveryId: $json.deliveryId, jobId: $json.job.id, flags: $json.flags, duplicate: $json.duplicateDelivery || $json.duplicateJob }) }}',
        options: { responseCode: 202 },
      },
    },
    ifBool('wf1-if-dup', 'Duplicate job?', [1360, 400], '={{ Boolean($json.duplicateDelivery || $json.duplicateJob) }}'),
    noOp('wf1-dup-stop', 'Already processed job', [1640, 280]),
    ifBool('wf1-if-enrich', 'Needs photo refresh?', [1640, 480], '={{ $json.flags.needs_enrichment }}'),
    {
      id: 'wf1-get-job',
      name: 'GET /jobs/:id',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1920, 360],
      onError: 'continueRegularOutput',
      parameters: {
        method: 'GET',
        url: '={{ $json.config.api_base_url }}/jobs/{{ $json.job.id }}',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'X-Api-Key', value: '={{ $json.config.api_key }}' },
            { name: 'X-SiteProof-Timestamp', value: '={{ $json.config.timestamp }}' },
          ],
        },
        options: { response: { response: { neverError: true } } },
      },
    },
    codeNode('wf1-merge-job', 'Merge fresh photoUrls', [2200, 360], `
${CONFIG_JS}
const ctx = $('Respond 202 accepted').first().json;
const res = $input.first().json || {};
const data = res.data || res;
const findings = data.findings;
if (Array.isArray(findings) && findings.length) {
  const byId = {};
  findings.forEach(function (f) { if (f && f.id) byId[f.id] = normalizeFinding(f); });
  ctx.job.findings = (ctx.job.findings || []).map(function (f) {
    const extra = byId[f.id];
    if (!extra) return f;
    return Object.assign({}, f, extra, {
      photoUrls: (extra.photoUrls && extra.photoUrls.length) ? extra.photoUrls : f.photoUrls,
      media_refs: (extra.photoUrls && extra.photoUrls.length) ? extra.photoUrls : f.media_refs,
    });
  });
}
ctx.flags.needs_enrichment = false;
return [{ json: ctx }];
`),
    noOp('wf1-fanout', 'Fan-out (parallel)', [2480, 480]),
    executeSub('wf1-exec-wf2', 'Execute WF2 Report generation', [2760, 120], 'siteproof-wf2-report-generation', '02 - Report generation'),
    executeSub('wf1-exec-wf3', 'Execute WF3 Issue routing', [2760, 320], 'siteproof-wf3-issue-routing', '03 - Issue routing'),
    executeSub('wf1-exec-wf4', 'Execute WF4 Critical alert', [2760, 520], 'siteproof-wf4-critical-alert', '04 - Critical alert'),
    executeSub('wf1-exec-wf5', 'Execute WF5 System update', [2760, 720], 'siteproof-wf5-system-update', '05 - System update'),
  ];

  const connections = connectionsFrom([
    ['Webhook job.closed', 'Verify HMAC'],
    ['Manual test (fixture)', 'Normalize fixture'],
    ['Verify HMAC', 'Validated payload'],
    ['Normalize fixture', 'Validated payload'],
    ['Validated payload', 'Payload valid?'],
    ['Payload valid?', 'Respond 202 accepted', 0],
    ['Payload valid?', 'Respond 4xx', 1],
    ['Respond 202 accepted', 'Duplicate job?'],
    ['Duplicate job?', 'Already processed job', 0],
    ['Duplicate job?', 'Needs photo refresh?', 1],
    ['Needs photo refresh?', 'GET /jobs/:id', 0],
    ['Needs photo refresh?', 'Fan-out (parallel)', 1],
    ['GET /jobs/:id', 'Merge fresh photoUrls'],
    ['Merge fresh photoUrls', 'Fan-out (parallel)'],
    // Same output index → n8n runs all four Execute nodes concurrently
    ['Fan-out (parallel)', [
      'Execute WF2 Report generation',
      'Execute WF3 Issue routing',
      'Execute WF4 Critical alert',
      'Execute WF5 System update',
    ]],
  ]);

  return workflow({
    id: 'siteproof-wf1-job-close-listener',
    name: '01 - Job-close listener (master)',
    nodes,
    connections,
  });
}

function wf2() {
  const nodes = [
    ...childPrefix({
      wf: 'wf2',
      title: 'WF2 — Report generation',
      color: 4,
      type: 'report.pdf',
      steps: [
        'Always runs.',
        'HTML (org branding + findings) → Gotenberg PDF',
        '`POST /webhooks/n8n/report-ready`',
        '`POST /webhooks/n8n/actions` type=report.pdf',
      ].join('\n'),
    }),
    codeNode('wf2-html', 'Build branded HTML', [840, 520], `
const ctx = $input.first().json;
const job = ctx.job;
const b = ctx.config.branding;
const color = b.primary_color || '#0B3D2E';
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function verdictColor(v) {
  if (v === 'fail') return '#B42318';
  if (v === 'review') return '#B54708';
  return '#027A48';
}
const findingsHtml = (job.findings || []).map(function (f, i) {
  const imgs = (f.photoUrls || []).filter(function (u) { return /^https?:\\/\\//i.test(u); }).map(function (u) {
    return '<img src="' + esc(u) + '" alt="" style="max-width:220px;border-radius:8px;margin:8px 8px 0 0;" />';
  }).join('');
  const clause = f.citedClause || {};
  const attrs = f.attributes || {};
  const attrLine = Object.keys(attrs).map(function (k) { return esc(k) + ': ' + esc(attrs[k]); }).join(' · ');
  return [
    '<article style="border:1px solid #E4E7EC;border-radius:12px;padding:16px;margin:0 0 16px;">',
    '<div style="display:flex;justify-content:space-between;gap:12px;"><strong>Finding ' + (i + 1) + '</strong>',
    '<span style="background:' + verdictColor(f.verdict) + ';color:#fff;border-radius:999px;padding:4px 10px;font-size:12px;text-transform:uppercase;">',
    esc(f.verdict) + ' · ' + esc(f.severity || ''),
    '</span></div>',
    f.transcript ? '<p>' + esc(f.transcript) + '</p>' : '',
    attrLine ? '<p class="muted">' + attrLine + '</p>' : '',
    f.reason ? '<p><strong>Reason:</strong> ' + esc(f.reason) + '</p>' : '',
    clause.ref ? '<p><strong>Clause ' + esc(clause.ref) + ':</strong> ' + esc(clause.text || '') + '</p>' : '',
    imgs,
    '</article>',
  ].join('');
}).join('');
const logo = b.logo_url ? '<img src="' + esc(b.logo_url) + '" alt="" style="height:40px;" />' : '';
const worker = (job.worker && job.worker.name) || '';
const html = [
  '<!DOCTYPE html><html><head><meta charset="utf-8" /><title>SiteProof ' + esc(job.id) + '</title>',
  '<style>body{font-family:Arial,Helvetica,sans-serif;color:#101828;margin:0;} .muted{color:#667085;font-size:13px;}</style></head><body>',
  '<header style="background:' + color + ';color:#fff;padding:24px 32px;">', logo,
  '<p style="letter-spacing:0.08em;font-size:12px;">SITEPROOF FIELD AUDIT</p>',
  '<h1 style="margin:8px 0;">' + esc(b.name) + '</h1>',
  '<p>' + esc(job.site || '') + '</p></header><main style="padding:28px 32px;">',
  '<p>Worker ' + esc(worker) + ' · Closed ' + esc(job.closedAt || '') + ' · Outcome <strong>' + esc(job.headline) + '</strong></p>',
  '<p class="muted">Pass ' + job.counts.pass + ' · Review ' + job.counts.review + ' · Fail ' + job.counts.fail + '</p>',
  findingsHtml || '<p>No findings on this job.</p>',
  '<p class="muted"><a href="' + esc(ctx.job_url) + '">Open job</a></p></main></body></html>',
].join('');
return [{ json: { ...ctx, html: html } }];
`),
    codeNode('wf2-bin', 'HTML as binary', [1120, 520], `
const ctx = $input.first().json;
const binary = await this.helpers.prepareBinaryData(Buffer.from(ctx.html, 'utf8'), 'index.html', 'text/html');
return [{ json: ctx, binary: { html: binary } }];
`),
    {
      id: 'wf2-pdf',
      name: 'HTML to PDF',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1400, 520],
      onError: 'continueRegularOutput',
      parameters: {
        method: 'POST',
        url: "={{ $('Build branded HTML').item.json.config.pdf_api_url }}",
        sendBody: true,
        contentType: 'multipart-form-data',
        bodyParameters: {
          parameters: [{ parameterType: 'formBinaryData', name: 'files', inputDataFieldName: 'html' }],
        },
        options: { response: { response: { responseFormat: 'file', neverError: true } } },
      },
    },
    codeNode('wf2-ready', 'Upload PDF + report-ready', [1680, 520], `
${CONFIG_JS}
const crypto = require('crypto');
const ctx = $('Build branded HTML').first().json;
const reportId = ctx.job.report && ctx.job.report.id;
const jobId = ctx.job.id;
if (alreadyDone(jobId, 'report.pdf')) {
  return [{ json: { ...ctx, action: { duplicate: true, type: 'report.pdf', status: 'ok' } } }];
}

const item = $input.first();
const bin = item.binary || {};
const errHint = (item.json && (item.json.error || item.json.message)) || '';

function isPdfBuffer(buf) {
  if (!buf || !buf.length || buf.length < 5) return false;
  const head = Buffer.from(buf.slice(0, 5)).toString('utf8');
  return head === '%PDF-';
}

function looksLikePdfMeta(meta) {
  if (!meta) return false;
  const mime = String(meta.mimeType || '').toLowerCase();
  const name = String(meta.fileName || meta.fileExtension || '').toLowerCase();
  return mime.includes('pdf') || name.endsWith('.pdf') || name === 'pdf' || String(meta.fileType || '').toLowerCase() === 'pdf';
}

// HTTP Request file response keeps prior binaries (e.g. html) AND adds data=pdf — prefer PDF.
const binKeys = Object.keys(bin).filter(function (k) { return Boolean(bin[k]); });
let binKey = binKeys.find(function (k) { return looksLikePdfMeta(bin[k]); }) || null;

async function uploadCloudinary(buffer) {
  const cloud = ctx.config.cloudinary_cloud_name;
  const apiKey = ctx.config.cloudinary_api_key;
  const apiSecret = ctx.config.cloudinary_api_secret;
  const folder = ctx.config.cloudinary_folder || 'siteproof/reports';
  if (!cloud || !apiKey || !apiSecret) throw new Error('Cloudinary is not configured');
  const timestamp = Math.floor(Date.now() / 1000);
  // image/upload keeps PDFs publicly deliverable; public_id without extension + format=pdf
  // yields a secure_url ending in .pdf that browsers open correctly.
  const publicId = 'job-' + jobId;
  const toSign = 'folder=' + folder + '&format=pdf&public_id=' + publicId + '&timestamp=' + timestamp + apiSecret;
  const signature = crypto.createHash('sha1').update(toSign).digest('hex');
  const res = await this.helpers.httpRequest({
    method: 'POST',
    url: 'https://api.cloudinary.com/v1_1/' + cloud + '/image/upload',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: {
      file: 'data:application/pdf;base64,' + Buffer.from(buffer).toString('base64'),
      api_key: apiKey,
      timestamp: String(timestamp),
      signature: signature,
      folder: folder,
      public_id: publicId,
      format: 'pdf',
    },
    json: true,
  });
  if (!res || !res.secure_url) throw new Error('Cloudinary upload missing secure_url');
  let url = String(res.secure_url);
  if (!/\\.pdf(\\?|$)/i.test(url)) {
    url = url.includes('?') ? url.replace('?', '.pdf?') : (url + '.pdf');
  }
  return url;
}

if (!binKeys.length) {
  const err = String(errHint || 'html-to-pdf produced no binary');
  try {
    await siteproofRequest.call(this, 'POST', '/webhooks/n8n/report-ready', {
      reportId: reportId, jobId: jobId, status: 'failed', error: err,
    }, 'report.pdf', ctx);
  } catch (e) {}
  const action = await postAction.call(this, ctx, 'report.pdf', 'storage', 'failed', { error: err });
  return [{ json: { ...ctx, action: action } }];
}

try {
  let buf = null;
  let meta = binKey ? bin[binKey] : null;
  if (binKey) {
    buf = await this.helpers.getBinaryDataBuffer(0, binKey);
  }
  if (!buf || (!looksLikePdfMeta(meta) && !isPdfBuffer(buf))) {
    for (const k of binKeys) {
      const candidate = await this.helpers.getBinaryDataBuffer(0, k);
      if (isPdfBuffer(candidate)) {
        binKey = k;
        buf = candidate;
        meta = bin[k];
        break;
      }
    }
  }
  if (!buf || (!looksLikePdfMeta(meta) && !isPdfBuffer(buf))) {
    throw new Error(String(errHint || 'html-to-pdf output is not a PDF'));
  }
  const pdfUrl = await uploadCloudinary.call(this, buf);
  await siteproofRequest.call(this, 'POST', '/webhooks/n8n/report-ready', {
    reportId: reportId,
    jobId: jobId,
    status: 'ready',
    pdfStorageKey: pdfUrl,
    pdfUrl: pdfUrl,
  }, 'report.pdf', ctx);
  const action = await postAction.call(this, ctx, 'report.pdf', 'storage', 'ok', { pdfUrl: pdfUrl });
  const staticData = $getWorkflowStaticData('global');
  staticData.jobs = staticData.jobs || {};
  staticData.jobs[jobId] = 'done';
  return [{ json: { ...ctx, action: action, pdfUrl: pdfUrl } }];
} catch (e) {
  const err = String((e && e.message) || e || 'pdf upload failed');
  try {
    await siteproofRequest.call(this, 'POST', '/webhooks/n8n/report-ready', {
      reportId: reportId, jobId: jobId, status: 'failed', error: err,
    }, 'report.pdf', ctx);
  } catch (e2) {}
  const action = await postAction.call(this, ctx, 'report.pdf', 'storage', 'failed', { error: err });
  return [{ json: { ...ctx, action: action } }];
}
`),
  ];

  const connections = connectionsFrom([
    ...childPrefixEdges('Build branded HTML'),
    ['Build branded HTML', 'HTML as binary'],
    ['HTML as binary', 'HTML to PDF'],
    ['HTML to PDF', 'Upload PDF + report-ready'],
  ]);

  return workflow({
    id: 'siteproof-wf2-report-generation',
    name: '02 - Report generation',
    nodes,
    connections,
  });
}

function wf3() {
  const nodes = [
    ...childPrefix({
      wf: 'wf3',
      title: 'WF3 — Issue routing',
      color: 5,
      type: 'routing.email',
      steps: [
        'Always invoked from master (parallel).',
        'If any review|fail → Gmail supervisor.',
        'Else action routing.* skipped.',
        'Link `{adminOrigin}/jobs/{job.id}`.',
      ].join('\n'),
    }),
    codeNode('wf3-filter', 'Filter review|fail', [840, 520], `
const ctx = $input.first().json;
const routed = (ctx.job.findings || []).filter(function (f) {
  return f.verdict === 'review' || f.verdict === 'fail';
});
return [{ json: { ...ctx, routed: routed, skip: routed.length === 0 } }];
`),
    ifBool('wf3-if-empty', 'Nothing to route?', [1120, 520], '={{ $json.skip }}'),
    codeNode('wf3-skip', 'Action routing skipped', [1400, 360], postActionJs('routing.email', "ctx.config.supervisor_email || 'none'", "'skipped'", '{ reason: "empty filter" }')),
    ifBool('wf3-if-slack', 'Alert channel Slack?', [1400, 640], "={{ $json.config.alert_channel === 'slack' }}"),
    codeNode('wf3-email', 'Compose + send email body', [1680, 520], `
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const ctx = $input.first().json;
const rows = ctx.routed.map(function (f) {
  const clause = f.citedClause || {};
  return '<tr><td>' + esc(f.verdict) + '</td><td>' + esc(f.severity) + '</td><td>' + esc(clause.ref || '') + '</td><td>' + esc(f.reason || f.transcript || '') + '</td></tr>';
}).join('');
const worker = (ctx.job.worker && ctx.job.worker.name) || '';
const subject = '[SiteProof] ' + (ctx.job.site || ctx.job.id) + ' — ' + ctx.job.headline;
const html = [
  '<p>Job at <strong>' + esc(ctx.job.site) + '</strong> (' + esc(worker) + ') needs action.</p>',
  '<p>Pass ' + ctx.job.counts.pass + ' · Review ' + ctx.job.counts.review + ' · Fail ' + ctx.job.counts.fail + '</p>',
  '<table border="1" cellpadding="6" cellspacing="0"><thead><tr><th>Verdict</th><th>Severity</th><th>Clause</th><th>Reason</th></tr></thead><tbody>' + rows + '</tbody></table>',
  '<p><a href="' + esc(ctx.job_url) + '">Open in dashboard</a></p>',
].join('');
return [{ json: { ...ctx, email: { to: ctx.config.supervisor_email, from: ctx.config.from_email, subject: subject, html: html } } }];
`),
    gmailSendNode('wf3-send', 'Send supervisor email (Gmail)', [1960, 520]),
    codeNode('wf3-ok', 'Action routing.email ok', [2240, 440], `
${CONFIG_JS}
const ctx = $('Compose + send email body').first().json;
const type = 'routing.email';
if (alreadyDone(ctx.job.id, type)) {
  return [{ json: { ...ctx, action: { type: type, status: 'ok', duplicate: true } } }];
}
const action = await postAction.call(this, ctx, type, ctx.config.supervisor_email, 'ok', { channel: 'gmail' });
return [{ json: { ...ctx, action: action } }];
`),
    codeNode('wf3-err', 'Capture email error', [2240, 680], `
${CONFIG_JS}
const prior = $('Compose + send email body').first().json;
const incoming = $input.first().json || {};
const message = (incoming.error && (incoming.error.message || incoming.error.description)) || incoming.message || 'gmail send failed';
return [{ json: { ...prior, error_message: String(message) } }];
`),
    codeNode('wf3-fail', 'Action routing.email failed', [2520, 680], `
${CONFIG_JS}
const ctx = $input.first().json;
const action = await postAction.call(this, ctx, 'routing.email', ctx.config.supervisor_email, 'failed', { error: ctx.error_message });
return [{ json: { ...ctx, action: action } }];
`),
    codeNode('wf3-slack', 'POST routing Slack', [1680, 760], `
${CONFIG_JS}
const ctx = $input.first().json;
if (!ctx.config.slack_webhook_url) {
  return [{ json: { ...ctx, error_message: 'Slack webhook missing' } }];
}
const lines = ctx.routed.map(function (f) {
  const clause = f.citedClause || {};
  return '• ' + (f.reason || f.transcript) + (clause.ref ? ' (' + clause.ref + ')' : '');
}).join('\\n');
try {
  await this.helpers.httpRequest({
    method: 'POST',
    url: ctx.config.slack_webhook_url,
    body: { text: 'SiteProof issues at ' + (ctx.job.site || ctx.job.id) + '\\n' + lines + '\\n' + ctx.job_url },
    json: true,
    ignoreHttpStatusErrors: true,
  });
} catch (e) {
  return [{ json: { ...ctx, error_message: e.message } }];
}
return [{ json: ctx }];
`),
    ifBool('wf3-if-slack-err', 'Slack routing failed?', [1960, 760], '={{ Boolean($json.error_message) }}'),
    codeNode('wf3-slack-ok', 'Action routing.slack ok', [2240, 860], postActionJs('routing.slack', 'ctx.config.slack_webhook_url', "'ok'", '{ channel: "slack" }')),
    codeNode('wf3-slack-fail', 'Action routing.slack failed', [2240, 1000], postActionJs('routing.slack', "'slack'", "'failed'", '{ error: ctx.error_message }')),
  ];

  const connections = connectionsFrom([
    ...childPrefixEdges('Filter review|fail'),
    ['Filter review|fail', 'Nothing to route?'],
    ['Nothing to route?', 'Action routing skipped', 0],
    ['Nothing to route?', 'Alert channel Slack?', 1],
    ['Alert channel Slack?', 'POST routing Slack', 0],
    ['Alert channel Slack?', 'Compose + send email body', 1],
    ['Compose + send email body', 'Send supervisor email (Gmail)'],
    ['Send supervisor email (Gmail)', 'Action routing.email ok', 0],
    ['Send supervisor email (Gmail)', 'Capture email error', 0, 'error'],
    ['Capture email error', 'Action routing.email failed'],
    ['POST routing Slack', 'Slack routing failed?'],
    ['Slack routing failed?', 'Action routing.slack failed', 0],
    ['Slack routing failed?', 'Action routing.slack ok', 1],
  ]);

  return workflow({
    id: 'siteproof-wf3-issue-routing',
    name: '03 - Issue routing',
    nodes,
    connections,
  });
}

function wf4() {
  const nodes = [
    ...childPrefix({
      wf: 'wf4',
      title: 'WF4 — Critical alert',
      color: 3,
      type: 'alert.critical',
      steps: [
        'Always invoked from master (parallel).',
        'Only fail+high → Gmail/Slack; else skipped.',
        'Sibling of routing (not after it).',
        'Action alert.critical.',
      ].join('\n'),
    }),
    codeNode('wf4-filter', 'Filter fail+high', [840, 520], `
const ctx = $input.first().json;
const critical = (ctx.job.findings || []).filter(function (f) {
  return f.verdict === 'fail' && String(f.severity).toLowerCase() === 'high';
});
return [{ json: { ...ctx, critical: critical, skip: critical.length === 0 } }];
`),
    ifBool('wf4-if-empty', 'Nothing critical?', [1120, 520], '={{ $json.skip }}'),
    codeNode('wf4-skip', 'Action alert skipped', [1400, 360], postActionJs('alert.critical', "ctx.config.critical_channel || 'email'", "'skipped'", '{}')),
    ifBool('wf4-if-email', 'Critical via email?', [1400, 640], "={{ $json.config.critical_channel !== 'slack' }}"),
    codeNode('wf4-email', 'Compose critical email', [1680, 520], `
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const ctx = $input.first().json;
const f = ctx.critical[0] || {};
const clause = f.citedClause || {};
const subject = 'CRITICAL: ' + (ctx.job.site || ctx.job.id);
const html = '<p><strong>' + esc(ctx.job.site) + '</strong></p><p>' + esc(f.reason || f.transcript) + '</p><p>' + esc(clause.ref || '') + ' — ' + esc(clause.text || '') + '</p><p><a href="' + esc(ctx.job_url) + '">Open job</a></p>';
return [{ json: { ...ctx, email: { to: ctx.config.supervisor_email, from: ctx.config.from_email, subject: subject, html: html } } }];
`),
    gmailSendNode('wf4-send', 'Send critical email (Gmail)', [1960, 520]),
    codeNode('wf4-ok', 'Action alert.critical ok', [2240, 440], `
${CONFIG_JS}
const ctx = $('Compose critical email').first().json;
const type = 'alert.critical';
if (alreadyDone(ctx.job.id, type)) {
  return [{ json: { ...ctx, action: { type: type, status: 'ok', duplicate: true } } }];
}
const action = await postAction.call(this, ctx, type, 'gmail', 'ok', { channel: 'gmail' });
return [{ json: { ...ctx, action: action } }];
`),
    codeNode('wf4-err', 'Capture critical email error', [2240, 680], `
${CONFIG_JS}
const prior = $('Compose critical email').first().json;
const incoming = $input.first().json || {};
const message = (incoming.error && (incoming.error.message || incoming.error.description)) || incoming.message || 'gmail send failed';
return [{ json: { ...prior, error_message: String(message) } }];
`),
    codeNode('wf4-fail', 'Action alert.critical failed', [2520, 680], `
${CONFIG_JS}
const ctx = $input.first().json;
const action = await postAction.call(this, ctx, 'alert.critical', 'gmail', 'failed', { error: ctx.error_message });
return [{ json: { ...ctx, action: action } }];
`),
    codeNode('wf4-slack', 'POST critical Slack', [1680, 800], `
${CONFIG_JS}
const ctx = $input.first().json;
if (!ctx.config.slack_webhook_url) {
  return [{ json: { ...ctx, error_message: 'SITEPROOF_SLACK_WEBHOOK is not configured' } }];
}
const f = ctx.critical[0] || {};
const clause = f.citedClause || {};
try {
  await this.helpers.httpRequest({
    method: 'POST',
    url: ctx.config.slack_webhook_url,
    body: {
      text: 'CRITICAL: ' + (ctx.job.site || ctx.job.id) + ' — ' + (f.reason || f.transcript || '') + (clause.ref ? ' (' + clause.ref + ')' : '') + '\\n' + ctx.job_url,
    },
    json: true,
    ignoreHttpStatusErrors: true,
  });
} catch (e) {
  return [{ json: { ...ctx, error_message: e.message } }];
}
return [{ json: ctx }];
`),
    ifBool('wf4-if-slack-err', 'Slack critical failed?', [1960, 800], '={{ Boolean($json.error_message) }}'),
    codeNode('wf4-slack-ok', 'Action alert.critical slack ok', [2240, 900], postActionJs('alert.critical', "'slack'", "'ok'", '{ channel: "slack" }')),
    codeNode('wf4-slack-fail', 'Action alert.critical slack failed', [2240, 1040], postActionJs('alert.critical', "'slack'", "'failed'", '{ error: ctx.error_message }')),
  ];

  const connections = connectionsFrom([
    ...childPrefixEdges('Filter fail+high'),
    ['Filter fail+high', 'Nothing critical?'],
    ['Nothing critical?', 'Action alert skipped', 0],
    ['Nothing critical?', 'Critical via email?', 1],
    ['Critical via email?', 'Compose critical email', 0],
    ['Critical via email?', 'POST critical Slack', 1],
    ['Compose critical email', 'Send critical email (Gmail)'],
    ['Send critical email (Gmail)', 'Action alert.critical ok', 0],
    ['Send critical email (Gmail)', 'Capture critical email error', 0, 'error'],
    ['Capture critical email error', 'Action alert.critical failed'],
    ['POST critical Slack', 'Slack critical failed?'],
    ['Slack critical failed?', 'Action alert.critical slack failed', 0],
    ['Slack critical failed?', 'Action alert.critical slack ok', 1],
  ]);

  return workflow({
    id: 'siteproof-wf4-critical-alert',
    name: '04 - Critical alert',
    nodes,
    connections,
  });
}

function wf5() {
  const nodes = [
    ...childPrefix({
      wf: 'wf5',
      title: 'WF5 — System update',
      color: 6,
      type: 'system.sheet',
      steps: [
        'Always. Upsert Google Sheet on jobId.',
        'jobId | site | workerEmail | pass | review | fail | headline | closedAt | reportLink',
        'Action system.sheet.',
      ].join('\n'),
    }),
    codeNode('wf5-map', 'Map sheet row', [840, 520], `
const ctx = $input.first().json;
if (!ctx.config.sheet_id) {
  return [{ json: { ...ctx, error_message: 'sheetId is not configured (org.settings.sheetId or SITEPROOF_SHEET_ID)' } }];
}
const workerEmail = (ctx.job.worker && ctx.job.worker.email) || '';
const row = {
  jobId: String(ctx.job.id),
  site: String(ctx.job.site || ''),
  workerEmail: String(workerEmail),
  pass: String(ctx.job.counts.pass),
  review: String(ctx.job.counts.review),
  fail: String(ctx.job.counts.fail),
  headline: String(ctx.job.headline || ''),
  closedAt: String(ctx.job.closedAt || ''),
  reportLink: String(ctx.job_url || ''),
};
return [{ json: Object.assign({}, ctx, row, { row: row }) }];
`),
    ifBool('wf5-if-cfg', 'Sheet id missing?', [1120, 520], '={{ Boolean($json.error_message) }}'),
    codeNode('wf5-fail-cfg', 'Action system.sheet failed (config)', [1400, 360], postActionJs('system.sheet', "'unconfigured'", "'failed'", '{ error: ctx.error_message }')),
    {
      id: 'wf5-sheets',
      name: 'Upsert Google Sheet row',
      type: 'n8n-nodes-base.googleSheets',
      typeVersion: 4.5,
      position: [1400, 640],
      onError: 'continueRegularOutput',
      alwaysOutputData: true,
      credentials: { googleSheetsOAuth2Api: { id: 'google-sheets-account', name: LIT.sheetsCredName } },
      parameters: {
        operation: 'append',
        documentId: {
          __rl: true,
          value: "={{ $json.config.sheet_id }}",
          mode: 'id',
        },
        sheetName: {
          __rl: true,
          value: "={{ $json.config.sheet_tab }}",
          mode: 'name',
        },
        columns: {
          mappingMode: 'defineBelow',
          value: {
            jobId: '={{ $json.jobId }}',
            site: '={{ $json.site }}',
            workerEmail: '={{ $json.workerEmail }}',
            pass: '={{ $json.pass }}',
            review: '={{ $json.review }}',
            fail: '={{ $json.fail }}',
            headline: '={{ $json.headline }}',
            closedAt: '={{ $json.closedAt }}',
            reportLink: '={{ $json.reportLink }}',
          },
          schema: [
            { id: 'jobId', displayName: 'jobId', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
            { id: 'site', displayName: 'site', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
            { id: 'workerEmail', displayName: 'workerEmail', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
            { id: 'pass', displayName: 'pass', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
            { id: 'review', displayName: 'review', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
            { id: 'fail', displayName: 'fail', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
            { id: 'headline', displayName: 'headline', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
            { id: 'closedAt', displayName: 'closedAt', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
            { id: 'reportLink', displayName: 'reportLink', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          ],
          matchingColumns: [],
          attemptToConvertTypes: false,
          convertFieldsToString: false,
        },
        options: {
          useAppend: true,
          cellFormat: 'USER_ENTERED',
        },
      },
    },
    codeNode('wf5-ok', 'Action system.sheet ok', [1680, 560], `
${CONFIG_JS}
const sheetItem = $input.first().json || {};
const ctx = $('Map sheet row').first().json;
const type = 'system.sheet';
const sheetErr = (sheetItem.error && (sheetItem.error.message || sheetItem.error.description || sheetItem.error))
  || sheetItem.error_message
  || null;
if (sheetErr) {
  const action = await postAction.call(this, ctx, type, ctx.config.sheet_id, 'failed', { error: String(sheetErr) });
  return [{ json: { ...ctx, action: action } }];
}
if (alreadyDone(ctx.job.id, type)) {
  return [{ json: { ...ctx, action: { type: type, status: 'ok', duplicate: true } } }];
}
const action = await postAction.call(this, ctx, type, ctx.config.sheet_id, 'ok', { jobId: ctx.job.id });
return [{ json: { ...ctx, action: action } }];
`),
  ];

  const connections = connectionsFrom([
    ...childPrefixEdges('Map sheet row'),
    ['Map sheet row', 'Sheet id missing?'],
    ['Sheet id missing?', 'Action system.sheet failed (config)', 0],
    ['Sheet id missing?', 'Upsert Google Sheet row', 1],
    ['Upsert Google Sheet row', 'Action system.sheet ok'],
  ]);

  return workflow({
    id: 'siteproof-wf5-system-update',
    name: '05 - System update',
    nodes,
    connections,
  });
}

const fixtureDir = path.join(__dirname, '..', 'fixtures');
function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

function pinManual(wf, payload) {
  wf.pinData = { 'Manual test (fixture)': [{ json: payload }] };
  return wf;
}

const files = {
  '01-job-close-listener.json': pinManual(wf1(), loadFixture('job-closed-mixed.json')),
  '02-report-generation.json': pinManual(wf2(), loadFixture('job-closed-mixed.json')),
  '03-issue-routing.json': pinManual(wf3(), loadFixture('job-closed-review-only.json')),
  '04-critical-alert.json': pinManual(wf4(), loadFixture('job-closed-fail-high.json')),
  '05-system-update.json': pinManual(wf5(), loadFixture('job-closed-mixed.json')),
};

fs.mkdirSync(OUT, { recursive: true });
console.log('Baked config from .env:', {
  apiBase: LIT.apiBase,
  apiKey: LIT.apiKey ? LIT.apiKey.slice(0, 8) + '…' : '(empty)',
  supervisorEmail: LIT.supervisorEmail,
  sheetId: LIT.sheetId ? LIT.sheetId.slice(0, 8) + '…' : '(empty)',
  adminOrigin: LIT.adminOrigin,
});
for (const [file, data] of Object.entries(files)) {
  const dest = path.join(OUT, file);
  fs.writeFileSync(dest, JSON.stringify(data, null, 2) + '\n');
  console.log('wrote', dest);
}
