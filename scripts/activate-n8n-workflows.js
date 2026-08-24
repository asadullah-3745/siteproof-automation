/**
 * Activate/publish SiteProof workflows via n8n Public API.
 * Reads N8N_OWNER_API_KEY from env, or the first key in n8n sqlite (not printed).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const BASE = (process.env.N8N_BASE_URL || 'http://localhost:5677').replace(/\/$/, '');
const DB = path.join(__dirname, '..', 'n8n_data', 'database.sqlite');

function getApiKey() {
  if (process.env.N8N_OWNER_API_KEY) return process.env.N8N_OWNER_API_KEY;
  // read via python without echoing
  const out = execSync(
    `python -c "import sqlite3; c=sqlite3.connect(r'${DB}'); print(c.execute('select apiKey from user_api_keys limit 1').fetchone()[0])"`,
    { encoding: 'utf8' },
  ).trim();
  return out;
}

async function api(method, urlPath, body) {
  const key = getApiKey();
  const res = await fetch(`${BASE}/api/v1${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-N8N-API-KEY': key,
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
  return { ok: res.ok, status: res.status, json };
}

async function main() {
  const list = await api('GET', '/workflows?limit=100');
  if (!list.ok) {
    console.error('List failed', list.status, list.json);
    process.exit(1);
  }
  const items = list.json.data || list.json || [];
  const byName = {};
  for (const w of items) byName[w.name] = w;

  const order = [
    '02 - Report generation',
    '03 - Issue routing',
    '04 - Critical alert',
    '05 - System update',
    '01 - Job-close listener (master)',
  ];

  for (const name of order) {
    const matches = items.filter((w) => w.name === name);
    // prefer active or latest updated
    const w = matches.sort((a, b) => Number(b.active) - Number(a.active))[0];
    if (!w) {
      console.log('MISSING', name);
      continue;
    }
    // deactivate duplicates
    for (const d of matches) {
      if (d.id === w.id) continue;
      const de = await api('POST', `/workflows/${d.id}/deactivate`);
      console.log('deactivate dup', d.id, de.status);
    }
    const act = await api('POST', `/workflows/${w.id}/activate`);
    console.log('activate', name, w.id, act.status, act.ok ? 'OK' : JSON.stringify(act.json).slice(0, 200));
  }

  // probe webhook
  const probe = await fetch(`${BASE}/webhook/siteproof-job-closed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  console.log('webhook probe', probe.status, (await probe.text()).slice(0, 180));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
