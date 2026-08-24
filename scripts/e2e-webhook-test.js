const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEBHOOK = process.env.N8N_WEBHOOK_URL || 'http://localhost:5677/webhook/siteproof-job-closed';
const SECRET = process.env.WEBHOOK_SECRET || 'change-me-to-a-long-random-webhook-secret';
const API = process.env.SITEPROOF_API_URL_HOST || 'http://localhost:3000/api/v1';
const API_KEY = process.env.N8N_API_KEY || '6e7a13827c81a340912848525588109f893aabcb017d7c59769d817ee3aa12c42350e1b599ae0134a3d11883b3044f73';

async function signedPost(fixtureFile, { badSig = false, jobId, reportId } = {}) {
  const o = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', fixtureFile), 'utf8'));
  o.deliveryId = crypto.randomUUID();
  o.job.id = jobId || crypto.randomUUID();
  if (reportId) {
    o.job.report = o.job.report || { status: 'pending' };
    o.job.report.id = reportId;
  }
  const body = JSON.stringify(o);
  const ts = Math.floor(Date.now() / 1000);
  let sig = crypto.createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
  if (badSig) sig = 'deadbeef';
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SiteProof-Event': 'job.closed',
      'X-SiteProof-Delivery-Id': o.deliveryId,
      'X-SiteProof-Timestamp': String(ts),
      'X-SiteProof-Signature': `sha256=${sig}`,
    },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text, jobId: o.job.id, deliveryId: o.deliveryId, fixture: fixtureFile };
}

async function api(method, urlPath, body) {
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

async function login() {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.SEED_WORKER_EMAIL || 'worker@siteproof.local',
      password: process.env.SEED_WORKER_PASSWORD || 'Worker123!',
      client: 'admin',
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error('login failed ' + res.status + ' ' + JSON.stringify(json));
  return json.data?.accessToken || json.accessToken || json.data?.tokens?.accessToken;
}

async function main() {
  console.log('--- health ---');
  console.log('n8n', (await fetch('http://localhost:5677/healthz')).status);
  console.log('api', (await fetch('http://localhost:3000/api/v1/health')).status);

  console.log('\n--- HMAC webhook ---');
  const bad = await signedPost('job-closed-mixed.json', { badSig: true });
  console.log('bad-sig', bad.status, bad.body.slice(0, 200));
  const good = await signedPost('job-closed-mixed.json');
  console.log('good-mixed', good.status, good.body.slice(0, 400));

  // wait for fan-out side effects
  await new Promise((r) => setTimeout(r, 8000));

  console.log('\n--- direct callback smoke (needs real job) ---');
  // try login + create job path
  let token;
  try {
    token = await login();
    console.log('login ok');
  } catch (e) {
    console.log('login skip', e.message);
  }

  if (token) {
    // list rulebooks / create job
    const create = await fetch(`${API}/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ site: 'E2E automation test site', jobType: 'solar_install_inspection' }),
    });
    const created = await create.json();
    console.log('create job', create.status, JSON.stringify(created).slice(0, 300));
  }

  // actions lookup by random fixture job will 404 — expected
  const actions = await api('GET', `/jobs/${good.jobId}/actions`);
  console.log('actions for webhook job', actions.status, JSON.stringify(actions.json).slice(0, 300));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
