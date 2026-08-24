import Database from 'better-sqlite3';

const db = new Database('/home/node/.n8n/database.sqlite', { readonly: true });
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table'")
  .all()
  .map((r) => r.name);
console.log(
  'tables',
  tables.filter((t) => /work|cred|web|user|api/i.test(t)).join(','),
);

const cols = db.prepare('PRAGMA table_info(workflow_entity)').all().map((c) => c.name);
console.log('workflow cols', cols.join(','));

const rows = db.prepare('SELECT id, name, active FROM workflow_entity').all();
console.log(JSON.stringify(rows, null, 2));

try {
  const keys = db.prepare('SELECT id, label, apiKey FROM user_api_keys').all();
  console.log('api keys', JSON.stringify(keys.map((k) => ({ id: k.id, label: k.label }))));
} catch (e) {
  console.log('api keys err', e.message);
}
