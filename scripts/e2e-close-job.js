/**
 * Full SiteProof close-job → n8n → callbacks E2E.
 * Creates a real job + findings (with tiny PNG media), closes it, waits for outbox/n8n.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = process.env.SITEPROOF_API_URL_HOST || 'http://localhost:3000/api/v1';
const EMAIL = process.env.SEED_WORKER_EMAIL || 'worker@siteproof.local';
const PASS = process.env.SEED_WORKER_PASSWORD || 'Worker123!';
const OWNER_EMAIL = process.env.SEED_OWNER_EMAIL || 'owner@siteproof.local';
const OWNER_PASS = process.env.SEED_OWNER_PASSWORD || 'Owner123!';
const API_KEY =
  process.env.N8N_API_KEY ||
  '6e7a13827c81a340912848525588109f893aabcb017d7c59769d817ee3aa12c42350e1b599ae0134a3d11883b3044f73';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function login(email, password, client = 'office') {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, client }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`login ${email}/${client}: ${res.status} ${JSON.stringify(json)}`);
  const token =
    json.data?.accessToken ||
    json.accessToken ||
    json.data?.tokens?.accessToken ||
    json.data?.access?.token ||
    json.data?.token;
  if (!token) throw new Error('no token in ' + JSON.stringify(json).slice(0, 400));
  return token;
}

async function authed(token, method, urlPath, body, isForm) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Idempotency-Key': crypto.randomUUID(),
  };
  let payload = body;
  if (!isForm && body && typeof body === 'object' && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${urlPath}`, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function n8nApi(method, urlPath, body) {
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': API_KEY,
      'X-SiteProof-Timestamp': ts,
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

function tinyPng() {
  // 1x1 PNG
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
}

async function main() {
  const report = { steps: [] };
  const log = (k, v) => {
    report.steps.push({ [k]: v });
    console.log(k, typeof v === 'string' ? v : JSON.stringify(v).slice(0, 500));
  };

  const workerToken = await login(EMAIL, PASS, 'mobile');
  log('login_worker', 'ok');

  // Create job
  const created = await authed(workerToken, 'POST', '/jobs', {
    site: `E2E SiteProof ${new Date().toISOString()}`,
    jobType: 'solar_install_inspection',
  });
  log('create_job', { status: created.status, body: created.json });
  const jobId = created.json.data?.id || created.json.id;
  if (!jobId) throw new Error('no job id');

  // Upload media
  const form = new FormData();
  form.append('file', new Blob([tinyPng()], { type: 'image/png' }), 'dot.png');
  form.append('type', 'photo');
  form.append('jobId', jobId);
  const mediaRes = await fetch(`${API}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${workerToken}` },
    body: form,
  });
  const mediaJson = await mediaRes.json();
  log('upload_media', { status: mediaRes.status, body: mediaJson });
  const mediaId = mediaJson.data?.id || mediaJson.id;
  if (!mediaId) throw new Error('no media id');

  // Findings: pass + review + fail high (mixed)
  const findings = [
    {
      mediaIds: [mediaId],
      transcript: 'Array clamps look good.',
      attributes: { object: 'solar_array', condition: 'secured' },
      verdict: 'pass',
      severity: 'low',
      citedClause: { ref: 'SOP §2.1', text: 'Modules must be fastened.' },
      reason: 'OK',
    },
    {
      mediaIds: [mediaId],
      transcript: 'Label hard to read.',
      attributes: { object: 'inverter', condition: 'label_unclear' },
      verdict: 'review',
      severity: 'med',
      citedClause: { ref: 'SOP §3.1', text: 'Labels must be legible.' },
      reason: 'Needs human review',
    },
    {
      mediaIds: [mediaId],
      transcript: 'Ground wire loose.',
      attributes: { object: 'grounding', condition: 'loose' },
      verdict: 'fail',
      severity: 'high',
      citedClause: { ref: 'SOP §4.2', text: 'Grounding must be secure.' },
      reason: 'Safety fail',
    },
  ];
  for (const f of findings) {
    const r = await authed(workerToken, 'POST', `/jobs/${jobId}/findings`, f);
    log('finding_' + f.verdict, { status: r.status, id: r.json.data?.id || r.json.id, err: r.json.error });
  }

  // Close job (triggers outbox → n8n)
  const closed = await authed(workerToken, 'POST', `/jobs/${jobId}/close`, {});
  log('close_job', { status: closed.status, body: closed.json });

  // Poll job actions / report via n8n API key
  let final = null;
  for (let i = 0; i < 36; i++) {
    await sleep(3000);
    const job = await n8nApi('GET', `/jobs/${jobId}`);
    const actions = job.json.data?.actions || job.json.actions || [];
    const reportRow = job.json.data?.report || job.json.report;
    log('poll_' + i, {
      status: job.status,
      actions: actions.map((a) => `${a.type}:${a.status}`),
      reportStatus: reportRow?.status,
      pdfUrl: reportRow?.pdfUrl || reportRow?.pdfStorageKey,
    });
    if (actions.length) {
      final = { jobId, actions, report: reportRow };
      const byType = {};
      for (const a of actions) {
        byType[a.type] = a.status;
      }
      const pdfOk = byType['report.pdf'] === 'ok' && !actions.some((a) => a.type === 'report.pdf' && a.status === 'failed');
      const routingOk = byType['routing.email'] === 'ok' || byType['routing.slack'] === 'ok';
      const alertOk = byType['alert.critical'] === 'ok';
      const sheetOk = byType['system.sheet'] === 'ok';
      if (pdfOk && routingOk && alertOk && sheetOk && reportRow?.status === 'ready') {
        break;
      }
    }
  }

  // Also check outbox via owner? skip — use job actions
  console.log('\n=== FINAL ===');
  console.log(JSON.stringify(final || { jobId, note: 'no actions yet' }, null, 2));
  fs.writeFileSync(
    path.join(__dirname, '..', 'fixtures', '_last-e2e-result.json'),
    JSON.stringify({ report, final }, null, 2),
  );
}

main().catch((e) => {
  console.error('E2E FAILED', e);
  process.exit(1);
});
