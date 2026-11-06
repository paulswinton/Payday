// Automatic off-phone backup to a PRIVATE GitHub repository you own.
// Each save replaces one encrypted file; GitHub keeps every earlier version.
import { encryptJSON, readEnvelope, decryptJSON } from './crypto.js';

const API = 'https://api.github.com';
export const BACKUP_PATH = 'payday-backup.json';

function headers(cfg, raw = false) {
  return { Authorization: `Bearer ${cfg.token}`, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}
async function call(cfg, path, opts = {}, raw = false) {
  let r;
  try { r = await fetch(API + path, { ...opts, headers: { ...headers(cfg, raw), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } }); }
  catch { const e = new Error('No internet connection. The backup will be sent when you are back online.'); e.offline = true; throw e; }
  if (r.status === 401) throw new Error('GitHub did not accept the access token. Create a new one and enter it in Settings.');
  if (r.status === 403) throw new Error('The access token cannot write to that repository. Check its permissions.');
  return r;
}
const contentPath = cfg => `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${BACKUP_PATH}`;

export async function checkRepo(cfg) {
  const r = await call(cfg, `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`);
  if (r.status === 404) throw new Error('Repository not found. Check the owner and name, and that the token can see it.');
  const info = await r.json();
  if (!info.private) throw new Error('That repository is public. Use a PRIVATE repository for backups.');
  if (info.permissions && !info.permissions.push) throw new Error('The token can read but not write this repository.');
  return info;
}

async function remoteSha(cfg) {
  const r = await call(cfg, contentPath(cfg));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub error ${r.status}`);
  return (await r.json()).sha;
}

// Upload the whole journal, refusing to overwrite a backup another device changed.
export async function upload(cfg, key, salt, events, { knownSha = null, force = false, device = 'iphone' } = {}) {
  const head = events[events.length - 1];
  const text = await encryptJSON(key, salt, { events }, { created: new Date().toISOString(), seq: head?.seq || 0, device });
  const sha = await remoteSha(cfg);
  if (sha && knownSha && sha !== knownSha && !force) {
    const e = new Error('The backup on GitHub was changed by another device since this phone last saved. Choose which copy to keep in Settings.');
    e.conflict = true; throw e;
  }
  const body = { message: `Payday backup · ${events.length} changes · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, content: btoa(text) };
  if (sha) body.sha = sha;
  const r = await call(cfg, contentPath(cfg), { method: 'PUT', body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`GitHub did not save the backup (error ${r.status}).`);
  const out = await r.json();
  return { sha: out.content.sha, at: new Date().toISOString(), seq: head?.seq || 0 };
}

export async function versions(cfg) {
  const r = await call(cfg, `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/commits?path=${BACKUP_PATH}&per_page=30`);
  if (!r.ok) throw new Error(`Could not list backups (error ${r.status}).`);
  return (await r.json()).map(c => ({ ref: c.sha, at: c.commit.committer?.date || c.commit.author?.date, message: c.commit.message }));
}

export async function download(cfg, ref = null) {
  const r = await call(cfg, contentPath(cfg) + (ref ? `?ref=${ref}` : ''), {}, true);
  if (r.status === 404) throw new Error('No backup found in that repository yet.');
  if (!r.ok) throw new Error(`Could not download the backup (error ${r.status}).`);
  return readEnvelope(await r.text());
}

export async function openBackup(env, key) {
  const data = await decryptJSON(key, env);
  if (!Array.isArray(data.events)) throw new Error('The backup is incomplete.');
  const seqs = data.events.map(e => e.seq);
  if (new Set(seqs).size !== seqs.length) throw new Error('The backup contains duplicate entries.');
  return data.events;
}
