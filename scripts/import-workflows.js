#!/usr/bin/env node
/**
 * Upsert workflow JSON into a running n8n instance with stable IDs so the
 * master Execute nodes (siteproof-wf2…wf5) stay wired.
 *
 * Requires an n8n API key (Settings → API in the n8n UI), not N8N_API_KEY
 * from SiteProof (that one is for callbacks into the backend).
 *
 *   set N8N_BASE_URL=http://localhost:5677
 *   set N8N_OWNER_API_KEY=n8n_api_...
 *   node scripts/import-workflows.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'workflows');
const BASE = (process.env.N8N_BASE_URL || 'http://localhost:5677').replace(/\/$/, '');
const KEY = process.env.N8N_OWNER_API_KEY || process.env.N8N_IMPORT_API_KEY || '';

const FILES = [
  '02-report-generation.json',
  '03-issue-routing.json',
  '04-critical-alert.json',
  '05-system-update.json',
  '01-job-close-listener.json',
];

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE}/api/v1${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-N8N-API-KEY': KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg = json?.message || json?.raw || res.statusText;
    throw new Error(`${method} ${urlPath} → ${res.status}: ${msg}`);
  }
  return json;
}

function sanitize(wf) {
  // n8n create/update bodies reject some export-only fields
  const {
    id,
    name,
    nodes,
    connections,
    settings,
    staticData,
    pinData,
  } = wf;
  return { id, name, nodes, connections, settings, staticData, pinData };
}

async function upsert(file) {
  const wf = JSON.parse(fs.readFileSync(path.join(OUT, file), 'utf8'));
  const body = sanitize(wf);
  let existing = null;
  try {
    existing = await api('GET', `/workflows/${wf.id}`);
  } catch {
    existing = null;
  }
  if (existing && existing.id) {
    const updated = await api('PUT', `/workflows/${wf.id}`, body);
    console.log('updated', file, '→', updated.id || wf.id, updated.name || wf.name);
    return updated;
  }
  const created = await api('POST', '/workflows', body);
  console.log('created', file, '→', created.id || wf.id, created.name || wf.name);
  return created;
}

async function main() {
  if (!KEY) {
    console.error('Set N8N_OWNER_API_KEY (n8n Settings → API). Not the SiteProof N8N_API_KEY.');
    process.exit(1);
  }
  for (const file of FILES) {
    await upsert(file);
  }
  console.log('\nActivate only: 01 - Job-close listener (master)');
  console.log('Attach credentials: SiteProof Gmail (WF3/4), SiteProof Google Sheets (WF5)');
  console.log('Webhook:', `${BASE}/webhook/siteproof-job-closed`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
