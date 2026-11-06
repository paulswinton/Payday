// Bring in the records exported from Payday Studio V19 on the Mac.
// History starts on payday, 29 October 2026, before the salary arrived.
// The 4 November balances (checked against the bank) are kept as checks, and
// every balance is rebuilt from movements so the result can be proved.
import { makeEvent, emptyState, applyEvent, balances, newId } from './model.js';
import { occurrences, planPeriods, FIRST_PERIOD } from './plan.js';
import { paydayFor } from './calendar.js';

export const START_DATE = '2026-10-29';

export function validateExport(data) {
  if (!data || data.format !== 'payday-v19-export' || data.version !== 1) throw new Error('This is not a Payday Studio export file. On the Mac, run "Export for iPhone".');
  for (const k of ['accounts', 'transactions', 'rules', 'snapshot_items']) if (!Array.isArray(data[k])) throw new Error('The export file is incomplete.');
}

// What the 29 October start-up check offers, with sensible defaults.
export function startChoices(data) {
  const paydayRules = data.rules.filter(r => r.sched.type === 'payday' && r.kind === 'transfer' && !r.paused);
  return {
    salary: { date: data.october_salary?.date || START_DATE, amount: data.october_salary?.amount || 0, received: !!data.october_salary?.amount },
    // V18 assumed these left between 29 Oct and 4 Nov. Default: they did.
    snapshot: data.snapshot_items.map(s => ({ ...s, paid: true })),
    // Payday standing orders on 29 Oct were never recorded. Default: not assumed.
    paydayTransfers: paydayRules.map(r => ({ rule: r.id, name: r.name, amount: r.amount, from: r.from, to: r.to, moved: false })),
    statement: {}, // optional: actual 29 Oct morning balances from bank statements
  };
}

function moves(choices) {
  const list = [];
  if (choices.salary.received && choices.salary.amount > 0) list.push({ kind: 'income', amount: choices.salary.amount, date: choices.salary.date, from: null, to: 'acc-current', desc: 'Salary', occ: `r-salary|${choices.salary.date}` });
  for (const s of choices.snapshot) if (s.paid) list.push({ kind: s.to && s.from ? 'transfer' : 'bill', amount: s.amount, date: s.date, from: s.from, to: s.to, desc: s.name, occ: s.occ ? `${s.occ.rule}|${s.occ.nominal}` : null, source: s.source });
  for (const p of choices.paydayTransfers) if (p.moved) list.push({ kind: 'transfer', amount: p.amount, date: START_DATE, from: p.from, to: p.to, desc: p.name + ' (29 Oct payday)', occ: null });
  return list;
}

// Morning-of-29-October balance = 4 Nov balance minus what happened in between.
export function openingBalances(data, choices) {
  const out = {};
  for (const a of data.accounts) out[a.id] = a.opening_date ? a.opening_value : a.opening_4nov;
  const late = new Set(data.accounts.filter(a => a.opening_date).map(a => a.id));
  for (const m of moves(choices)) {
    if (m.from && out[m.from] != null && !late.has(m.from)) out[m.from] += m.amount;
    if (m.to && out[m.to] != null && !late.has(m.to)) out[m.to] -= m.amount;
  }
  return out;
}

export function buildImport(base, data, choices, { device = 'iphone' } = {}) {
  validateExport(data);
  const changes = [];
  const put = (kind, key, value) => changes.push({ kind, key, value });
  const now = new Date().toISOString();
  const opening = openingBalances(data, choices);

  put('setting', 'startDate', { value: START_DATE });
  put('setting', 'firstPeriod', { value: FIRST_PERIOD });
  put('setting', 'mainAccount', { value: 'acc-current' });
  put('setting', 'cushion', { value: data.settings?.cushion ?? 0 });
  put('setting', 'importedFrom', { value: { exported_at: data.exported_at, at: now } });

  let order = 0;
  for (const a of data.accounts) {
    const tracked = a.tracked && opening[a.id] != null;
    const stated = choices.statement?.[a.id];
    put('account', a.id, {
      id: a.id, name: a.name, type: a.type, tracked, opening: tracked ? (a.opening_date ? opening[a.id] : (stated ?? opening[a.id])) : null,
      ...(a.opening_date ? { openingDate: a.opening_date } : {}), archived: !!a.archived,
      target: a.target || null, apr: a.apr ?? null, unconfirmed: !!a.unconfirmed, minimum: a.minimum ?? null, order: order++,
    });
  }

  // Salary rule from the income plan; months with a different figure become occurrence edits.
  const plan = data.income_plan || [];
  const typical = mode(plan.filter(p => p.cycle > FIRST_PERIOD).map(p => p.amount)) ?? plan[0]?.amount ?? 0;
  put('rule', 'r-salary', { id: 'r-salary', name: 'Salary', kind: 'income', amount: typical, from: null, to: 'acc-current',
    sched: { type: 'payday' }, start: START_DATE, end: null, versions: [], shift: false, note: 'Expected take-home pay. Counted only once you confirm it has arrived.' });
  const occ = {};
  for (const p of plan) if (p.amount !== typical) occ[`r-salary|${p.payday}`] = { amount: p.amount };

  for (const r of data.rules) put('rule', r.id, { ...r, versions: r.versions || [] });
  for (const o of data.one_offs || []) put('rule', o.id, { id: o.id, name: o.name, kind: o.kind, amount: o.amount, from: o.from, to: o.to,
    sched: { type: 'once', date: o.date }, start: o.date, end: null, versions: [], shift: false, note: o.note || '' });

  // A provisional state lets skips and edits be matched to real occurrences.
  const tmp = emptyState();
  applyEvent(tmp, makeEvent(tmp, 'tmp', changes));
  const inCycle = (ruleId, cycle) => {
    const r = tmp.rule[ruleId];
    if (!r) return [];
    const per = planPeriods(tmp).find(p => p.key === cycle);
    if (!per) return [];
    return occurrences(r, addMonthsStart(per.start), per.end, tmp).filter(o => o.period === cycle);
  };
  for (const s of data.skips || []) {
    const match = inCycle(s.rule, s.cycle).find(o => !s.date || o.nominal === s.date || o.date === s.date) || inCycle(s.rule, s.cycle)[0];
    if (match) occ[match.key] = { ...(occ[match.key] || {}), skip: true };
  }
  for (const e of data.occurrence_edits || []) {
    const list = inCycle(e.rule, e.cycle);
    const match = list.find(o => o.nominal === e.date) || list[0];
    if (match) occ[match.key] = { ...(occ[match.key] || {}), amount: e.amount, ...(e.date && e.date !== match.date ? { date: e.date } : {}) };
  }

  // Transactions: the 29 Oct–4 Nov moves chosen in the start-up check, then V19's records.
  const txns = [];
  for (const m of moves(choices)) txns.push({ ...m, note: m.source ? 'From the 4 November starting balances' : '', created: now });
  for (const t of data.transactions) txns.push({ kind: t.kind, amount: t.amount, date: t.date < START_DATE ? START_DATE : t.date, from: t.from, to: t.to,
    desc: t.desc, note: t.note || '', occ: t.occ ? `${t.occ.rule}|${t.occ.nominal}` : null, source: t.source, created: now, ...(t.unposted ? { unposted: t.unposted } : {}) });
  // Statement balances that differ from the calculated 29 Oct figures are recorded
  // as a difference on 4 Nov, so the checked 4 Nov balances still hold.
  for (const [id, value] of Object.entries(choices.statement || {})) {
    if (value == null || opening[id] == null || value === opening[id]) continue;
    const diff = opening[id] - value;
    txns.push({ kind: 'adjust', amount: Math.abs(diff), date: data.snapshot_date, from: diff < 0 ? id : null, to: diff > 0 ? id : null,
      desc: 'Unrecorded movements 29 Oct–4 Nov', note: 'Difference between your 29 Oct statement and the checked 4 Nov balance', created: now, statementFor: id, statementValue: value });
  }
  const used = new Set();
  let relinked = 0, unlinked = 0;
  for (const t of txns) {
    if (!t.occ) continue;
    const [ruleId, nominal] = t.occ.split('|');
    const rule = tmp.rule[ruleId];
    const exists = rule && occurrences(rule, nominal, nominal, tmp).some(o => o.key === t.occ);
    if (exists && !used.has(t.occ)) { used.add(t.occ); continue; }
    // Rule dates changed since: link to the same rule's occurrence in that payday period.
    const cycle = planPeriods(tmp).find(p => p.start <= nominal && nominal <= p.end)?.key;
    const alt = rule && cycle ? inCycle(ruleId, cycle).find(o => !used.has(o.key)) : null;
    if (alt) { t.occ = alt.key; used.add(alt.key); relinked++; } else { t.occ = null; unlinked++; }
  }
  for (const t of txns) {
    const id = t.source ? 'tx-' + t.source.replace(/[^a-z0-9]+/gi, '-') : newId('tx');
    if (!t.from && !t.to) continue;
    put('txn', id, { id, ...t, from: t.from || null, to: t.to || null });
  }
  for (const [key, value] of Object.entries(occ)) put('occ', key, value);
  for (const c of data.checks || []) put('check', newId('chk'), { account: c.account, date: c.date, bank: c.bank, at: c.at, imported: true });
  for (const a of data.accounts) if (a.opening_4nov != null && a.tracked && !a.opening_date) put('check', `chk-4nov-${a.id}`, { account: a.id, date: data.snapshot_date, bank: a.opening_4nov, imported: true, note: 'Balance supplied on 4 Nov 2026' });

  const event = makeEvent(base, 'Brought in records from Payday Studio V19', changes, { device });
  return { event, relinked, unlinked, opening };
}

// After importing, prove every balance matches V19 exactly.
export function verifyImport(state, data) {
  const now = balances(state);
  const problems = [];
  for (const a of data.accounts) {
    const acc = state.account[a.id];
    if (!acc || !acc.tracked || a.v19_value == null) continue;
    if (now[a.id] !== a.v19_value) problems.push({ id: a.id, name: a.name, v19: a.v19_value, app: now[a.id] });
  }
  return problems;
}

function mode(list) {
  const n = new Map();
  for (const x of list) n.set(x, (n.get(x) || 0) + 1);
  let best = null, count = 0;
  for (const [k, v] of n) if (v > count) { best = k; count = v; }
  return best;
}
function addMonthsStart(d) { return d.slice(0, 8) + '01' <= d ? d.slice(0, 7) + '-01' : d; }
export { paydayFor };
