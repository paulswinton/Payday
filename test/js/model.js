// The journal: every change is an event holding the new and previous version of
// each record it touches. Nothing is ever overwritten or deleted from the
// journal, so any change can be undone and any earlier version restored.
// Balances are never stored: they are always calculated from transactions.

export const KINDS = ['account', 'rule', 'occ', 'txn', 'check', 'scenario', 'setting', 'goal'];

export function emptyState() {
  const s = { events: [], seq: 0 };
  for (const k of KINDS) s[k] = {};
  return s;
}

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
export const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function newId(prefix = 'id') {
  const rand = (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  return `${prefix}-${rand}`;
}

// Build an event from a list of intended changes, recording what each replaces.
export function makeEvent(state, label, changes, extra = {}) {
  const ops = changes.map(c => {
    if (!KINDS.includes(c.kind)) throw new Error('Unknown record type ' + c.kind);
    const prev = clone(state[c.kind][c.key]);
    if (c.op === 'remove') {
      if (prev === undefined) throw new Error('Nothing to remove');
      return { op: 'remove', kind: c.kind, key: c.key, prev };
    }
    return { op: 'put', kind: c.kind, key: c.key, value: clone(c.value), prev };
  });
  return {
    id: newId('ev'), seq: state.seq + 1, at: new Date().toISOString(),
    device: extra.device || 'iphone', label, ops, ...(extra.undoes ? { undoes: extra.undoes } : {}),
  };
}

export function applyEvent(state, ev) {
  for (const o of ev.ops) {
    state[o.kind] ??= {};
    if (o.op === 'put') state[o.kind][o.key] = clone(o.value);
    else delete state[o.kind][o.key];
  }
  state.events.push(ev);
  state.seq = Math.max(state.seq, ev.seq || 0);
  return state;
}

export function replay(events) {
  const s = emptyState();
  for (const ev of [...events].sort((a, b) => a.seq - b.seq)) applyEvent(s, ev);
  return s;
}

// Undo is itself a new event, so undoing can also be undone.
export function canUndo(state, ev) {
  if (!ev || state.events.some(e => e.undoes === ev.id)) return { ok: false, why: 'Already undone' };
  for (const o of ev.ops) {
    const now = state[o.kind][o.key];
    if (o.op === 'put' && !same(now, o.value)) return { ok: false, why: 'Changed again since. Restore an earlier version from its history instead.' };
    if (o.op === 'remove' && now !== undefined) return { ok: false, why: 'It has been re-created since.' };
  }
  return { ok: true };
}
export function undoEvent(state, ev) {
  const check = canUndo(state, ev);
  if (!check.ok) throw new Error(check.why);
  const changes = [...ev.ops].reverse().map(o =>
    o.prev === undefined ? { op: 'remove', kind: o.kind, key: o.key } : { op: 'put', kind: o.kind, key: o.key, value: o.prev });
  return makeEvent(state, 'Undo: ' + ev.label, changes, { undoes: ev.id });
}

// Every version a record has had, newest first, including deletions.
export function history(state, kind, key) {
  const out = [];
  for (const ev of state.events) for (const o of ev.ops) {
    if (o.kind === kind && o.key === key) out.push({ event: ev, op: o.op, value: o.value, prev: o.prev, at: ev.at, label: ev.label });
  }
  return out.reverse();
}

// ---- Accounts and balances -------------------------------------------------
// Internal sign: every account holds a "value". For a credit card the value is
// minus the debt, so the same rule works everywhere: money leaves `from`
// (value falls) and arrives in `to` (value rises).
export function postings(txn, accounts) {
  const out = [];
  // An account counts money only from the day it started being tracked.
  const add = (id, d) => { const a = accounts[id]; if (a && a.tracked !== false && !(a.openingDate && txn.date < a.openingDate) && !(txn.unposted || []).includes(id)) out.push({ account: id, delta: d }); };
  if (txn.from) add(txn.from, -txn.amount);
  if (txn.to) add(txn.to, txn.amount);
  return out;
}

export function liveTxns(state) {
  return Object.values(state.txn).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.created || '').localeCompare(b.created || '')));
}

export function balances(state, asOf = null) {
  const out = {};
  for (const a of Object.values(state.account)) out[a.id] = a.tracked === false ? null : a.opening;
  for (const t of liveTxns(state)) {
    if (asOf && t.date > asOf) continue;
    for (const p of postings(t, state.account)) out[p.account] += p.delta;
  }
  return out;
}

export const displayBalance = (account, value) => (value === null ? null : account.type === 'card' ? -value : value);

// Integrity: re-derive and confirm every posting balances and refers to a real account.
export function selfCheck(state) {
  const problems = [];
  for (const t of Object.values(state.txn)) {
    if (!Number.isInteger(t.amount) || t.amount <= 0) problems.push(`${t.desc || t.id}: amount is not a positive whole number of pence`);
    if (!t.from && !t.to) problems.push(`${t.desc || t.id}: no account`);
    for (const id of [t.from, t.to]) if (id && !state.account[id]) problems.push(`${t.desc || t.id}: unknown account ${id}`);
    const start = state.setting.startDate?.value;
    if (start && t.date < start) problems.push(`${t.desc || t.id}: dated before the start date`);
  }
  const seqs = state.events.map(e => e.seq);
  if (new Set(seqs).size !== seqs.length) problems.push('Duplicate journal entries');
  return problems;
}

export function setting(state, key, fallback = null) {
  return state.setting[key] ? state.setting[key].value : fallback;
}
