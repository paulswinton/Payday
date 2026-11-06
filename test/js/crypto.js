// Backups are encrypted on the phone before they leave it: AES-256-GCM with a
// key made from your passphrase (PBKDF2-SHA-256, 600,000 rounds). Without the
// passphrase a backup cannot be read, by GitHub or anyone else.
export const ITERATIONS = 600000;
const enc = new TextEncoder(), dec = new TextDecoder();

export function toB64(bytes) {
  let s = '';
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function newSalt() { return toB64(crypto.getRandomValues(new Uint8Array(16))); }

export async function deriveKey(passphrase, saltB64, iterations = ITERATIONS) {
  if (String(passphrase).length < 10) throw new Error('Use a passphrase of at least 10 characters.');
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptJSON(key, saltB64, obj, meta = {}) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return JSON.stringify({ format: 'payday-backup', version: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: saltB64 },
    iv: toB64(iv), ct: toB64(ct), ...meta });
}

export function readEnvelope(text) {
  let env;
  try { env = JSON.parse(text); } catch { throw new Error('This file is not a Payday backup.'); }
  if (env.format !== 'payday-backup' || env.version !== 1 || !env.iv || !env.ct || !env.kdf?.salt) throw new Error('This file is not a Payday backup.');
  return env;
}

export async function decryptJSON(key, env) {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv) }, key, fromB64(env.ct));
    return JSON.parse(dec.decode(pt));
  } catch {
    throw new Error('Could not open the backup: the passphrase is wrong, or the file has been damaged.');
  }
}
