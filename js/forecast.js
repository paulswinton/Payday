// Forecast: start from today's real balances, then play forward every planned
// payment, transfer and expected salary, day by day, to the end of the plan.
//
// Rules that keep it honest:
// - A transfer between your own accounts moves money; it never changes your total.
// - Bills accounts (e.g. Exp for month) are topped up from the main account on each
//   future payday by exactly what they need until the next payday, less what is
//   already in them. Without this, the main account looks richer than it is and
//   the bills account runs dry.
// - A savings transfer set to "stop at target" only moves what the pot still needs.
// - Anything not yet confirmed (variable amounts, undated payments) is marked as an estimate.
import { addDays, daysBetween, periodFor, addMonths } from './calendar.js';
import { balances, setting } from './model.js';
import { allOccurrences, planPeriods } from './plan.js';
import { fundsToNeed, roleOf } from './roles.js';

export const mainAccountId = state => setting(state, 'mainAccount', 'acc-current');
export const cushionOf = state => setting(state, 'cushion', 0);

export function trackedIds(state) {
  return Object.values(state.account).filter(a => a.tracked !== false && !a.archived).map(a => a.id);
}

// Everyday spending isn't planned payment by payment. Either a spending allowance
// account covers it (money moved there each payday is the spending), or an amount
// per payday is set in Settings and taken off each future payday.
export function everydayFor(state, periodStart) {
  const base = setting(state, 'everydaySpend', null);
  if (base == null) return null;
  let amount = base;
  for (const ch of setting(state, 'everydayChanges', []) || []) {
    if (ch.from <= periodStart && (!ch.to || periodStart <= ch.to)) amount += ch.delta;
  }
  return Math.max(0, amount);
}

export function everydayCover(state) {
  const set = setting(state, 'everydaySpend', null);
  if (set != null) return { source: 'setting', amount: set };
  const main = mainAccountId(state);
  for (const r of Object.values(state.rule)) {
    if (r.deleted || r.end || r.kind !== 'transfer' || r.from !== main || r.sched?.type !== 'payday') continue;
    const to = state.account[r.to];
    if (to && roleOf(state, to) === 'allowance') return { source: 'allowance', account: to, amount: r.amount };
  }
  return null;
}

export const fundKey = (accountId, periodKey) => `${accountId}|${periodKey}`;
export function fundedTxn(state, accountId, periodKey) {
  const k = fundKey(accountId, periodKey);
  return Object.values(state.txn).find(t => t.fund === k) || null;
}

export function project(state, { today, until, extraFlows = [], everyday = true, fund = true }) {
  const start = setting(state, 'startDate', today);
  const now = balances(state, today);
  const ids = trackedIds(state);
  const main = mainAccountId(state);
  const list = planPeriods(state);
  const pending = [];

  for (const o of allOccurrences(state, start, until, today)) {
    if (o.status === 'paid' || o.status === 'skipped') continue;
    const date = o.date < today ? today : o.date;
    if (date > until) continue;
    const from = o.from && ids.includes(o.from) ? o.from : null;
    const to = o.to && ids.includes(o.to) ? o.to : null;
    if (!from && !to) continue;
    const amount = o.paidAmount ? o.remaining : o.amount;
    const target = to && o.untilTarget ? state.account[to]?.target ?? null : null;
    pending.push({ date, amount, from, to, label: o.name, occ: o.key, ruleId: o.ruleId, kind: o.kind, overdue: o.status === 'overdue',
      category: o.category, goal: o.goal, estimate: o.variable || o.undated, cap: target });
  }
  for (const f of extraFlows) {
    if (f.date < today || f.date > until) continue;
    if (f.from !== undefined || f.to !== undefined) {
      const from = f.from && ids.includes(f.from) ? f.from : null, to = f.to && ids.includes(f.to) ? f.to : null;
      if (from || to) pending.push({ ...f, from, to });
    } else if (ids.includes(f.account)) {
      pending.push({ ...f, from: f.delta < 0 ? f.account : null, to: f.delta > 0 ? f.account : null, amount: Math.abs(f.delta) });
    }
  }
  if (everyday && ids.includes(main)) {
    for (const p of list) {
      if (p.start <= today || p.start > until) continue;   // the current period is what safe-to-spend covers
      const amount = everydayFor(state, p.start);
      if (amount) pending.push({ date: p.start, from: main, to: null, amount, label: 'Everyday spending (allowance)', estimate: true, everyday: true });
    }
  }
  if (fund && ids.includes(main)) {
    for (const a of Object.values(state.account)) {
      if (!fundsToNeed(state, a) || !ids.includes(a.id)) continue;
      for (const p of list) {
        if (p.start < today || p.start > until) continue;
        if (fundedTxn(state, a.id, p.key)) continue;
        pending.push({ date: p.start, from: main, to: a.id, amount: 0, label: `Top up ${a.name}`, fund: { account: a.id, end: p.end, buffer: a.buffer || 0, period: p.key },
          kind: 'transfer', category: 'must', first: true });
      }
    }
  }
  for (const a of Object.values(state.account)) {
    if (a.type !== 'card' || !a.apr || !ids.includes(a.id)) continue;
    for (let k = today.slice(0, 7); k <= until.slice(0, 7); k = addMonths(k, 1)) {
      const d = `${k}-01`;
      if (d <= today || d > until) continue;
      pending.push({ date: d, from: a.id, to: null, amount: 0, interest: a.apr, label: `${a.name} interest (estimate)`, estimate: true });
    }
  }
  pending.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (b.first ? 1 : 0) - (a.first ? 1 : 0)));

  // What a bills account still needs between a payday and the day before the next.
  const needFor = (acc, from, to) => {
    let need = 0;
    for (const f of pending) {
      if (f.fund || f.date < from || f.date > to) continue;
      if (f.from === acc) need += f.amount;
      if (f.to === acc) need -= f.amount;
    }
    return need;
  };

  const periodList = list.filter(p => p.end >= today && p.start <= until);
  const bal = {};
  for (const id of ids) bal[id] = now[id] ?? 0;
  const stats = {}, lowest = {}, firstNegative = {}, series = {}, flows = [];
  for (const id of ids) { lowest[id] = { value: bal[id], date: today }; series[id] = []; }
  let i = 0;
  const days = Math.max(0, daysBetween(today, until));
  for (let n = 0; n <= days; n++) {
    const d = addDays(today, n);
    const before = { ...bal };
    const p = periodFor(d, periodList);
    const ps = p ? (stats[p.key] ??= { key: p.key, start: p.start, end: p.end, acc: {} }) : null;
    while (i < pending.length && pending[i].date === d) {
      const f = pending[i++];
      let amt = f.amount;
      if (f.fund) amt = Math.max(0, needFor(f.fund.account, d, f.fund.end) + f.fund.buffer - bal[f.to]);
      if (f.interest) { const debt = -bal[f.from]; amt = debt > 0 ? Math.round(debt * f.interest / 100 / 12) : 0; }
      if (f.cap != null && f.to) amt = Math.max(0, Math.min(amt, f.cap - bal[f.to]));
      if (f.from) bal[f.from] -= amt;
      if (f.to) bal[f.to] += amt;
      const realised = { ...f, amount: amt, planned: f.amount };
      if (amt === 0 && !f.fund && f.cap == null) continue;
      if (f.from) flows.push({ ...realised, account: f.from, delta: -amt });
      if (f.to) flows.push({ ...realised, account: f.to, delta: amt });
      if (ps) for (const [acc, delta] of [[f.from, -amt], [f.to, amt]]) {
        if (!acc) continue;
        const s = ps.acc[acc] ??= { before: before[acc], open: null, low: null, lowDate: d, close: null, in: 0, out: 0 };
        if (delta > 0) s.in += delta; else s.out -= delta;
      }
    }
    for (const id of ids) {
      const v = bal[id];
      if (v < lowest[id].value) lowest[id] = { value: v, date: d };
      if (v < 0 && !firstNegative[id]) firstNegative[id] = d;
      if (ps) {
        const s = ps.acc[id] ??= { before: before[id], open: null, low: null, lowDate: d, close: null, in: 0, out: 0 };
        if (s.open === null) s.open = v;
        if (s.low === null || v < s.low) { s.low = v; s.lowDate = d; }
        s.close = v;
      }
      const arr = series[id];
      if (n === days || !arr.length || arr[arr.length - 1][1] !== v) arr.push([d, v]);
    }
  }
  return { today, until, start: now, end: { ...bal }, flows, periods: periodList.map(p => stats[p.key]).filter(Boolean), lowest, firstNegative, series };
}

export function lowIn(proj, id, from, to) {
  let best = null;
  for (const p of proj.periods) {
    if (p.end < from || p.start > to) continue;
    const s = p.acc[id];
    if (s && s.low !== null && (best === null || s.low < best.value)) best = { value: s.low, date: s.lowDate };
  }
  return best;
}

// What is safe to spend from the main account before the next payday.
export function safeToSpend(state, today) {
  const list = planPeriods(state);
  const per = periodFor(today, list);
  if (!per) return null;
  const main = mainAccountId(state);
  const proj = project(state, { today, until: per.end });
  const cushion = cushionOf(state);
  const low = proj.periods[0]?.acc[main] || { low: proj.start[main], lowDate: today };
  const topups = [];
  for (const a of Object.values(state.account)) {
    if (a.id === main || a.tracked === false || a.archived || a.type === 'card') continue;
    const s = proj.periods[0]?.acc[a.id];
    if (s && s.low < 0) topups.push({ account: a.id, name: a.name, amount: -s.low, date: s.lowDate });
  }
  const topupTotal = topups.reduce((t, x) => t + x.amount, 0);
  const raw = low.low - cushion - topupTotal;
  const outgoing = proj.flows.filter(f => f.account === main && f.delta < 0);
  const incoming = proj.flows.filter(f => f.account === main && f.delta > 0);
  return {
    period: per, nextPayday: addDays(per.end, 1), balance: proj.start[main], lowest: low.low, lowDate: low.lowDate,
    cushion, topups, topupTotal, safe: Math.max(0, raw), raw, outgoing, incoming,
    overdue: outgoing.filter(f => f.overdue),
  };
}

// Scenarios: a copy of the plan with extra items or changes, compared with the real plan.
export function scenarioState(state, scenario) {
  const s = { ...state, rule: { ...state.rule }, occ: { ...state.occ } };
  for (const it of scenario.items || []) {
    if (it.type === 'everyday') continue;
    const id = `sc-${scenario.id}-${it.id}`;
    const sched = it.type === 'once' ? { type: 'once', date: it.date }
      : it.type === 'payday' ? { type: 'payday' } : { type: 'monthly', day: Number(it.day || 1) };
    s.rule[id] = {
      id, name: it.name || 'Scenario item', kind: it.to && it.from ? 'transfer' : it.to ? 'income' : 'bill',
      amount: it.amount, from: it.from || null, to: it.to || null, sched,
      start: it.type === 'once' ? it.date : it.start, end: it.end || null, scenario: true, shift: false,
    };
  }
  const everyday = (scenario.items || []).filter(it => it.type === 'everyday');
  if (everyday.length) {
    const list = [...(setting(state, 'everydayChanges', []) || [])];
    for (const it of everyday) list.push({ id: it.id, from: it.start, to: it.end || null, delta: -it.amount });
    s.setting = { ...state.setting, everydayChanges: { value: list } };
  }
  for (const ch of scenario.changes || []) {
    const r = s.rule[ch.ruleId];
    if (!r) continue;
    const copy = { ...r, versions: [...(r.versions || [])] };
    if (ch.stop) copy.end = addDays(ch.from, -1);
    else copy.versions.push({ from: ch.from, set: { amount: ch.amount } });
    s.rule[ch.ruleId] = copy;
  }
  return s;
}

export function runScenario(state, scenario, today) {
  const list = planPeriods(state);
  const until = scenario.until || list[list.length - 1].end;
  const base = project(state, { today, until });
  const alt = project(scenarioState(state, scenario), { today, until });
  const main = mainAccountId(state);
  const cushion = cushionOf(state);
  const firstShort = proj => proj.periods.find(p => p.acc[main] && p.acc[main].low < cushion) || null;
  const rows = base.periods.map((p, i) => ({
    key: p.key, start: p.start, end: p.end,
    base: p.acc[main], alt: alt.periods[i]?.acc[main],
  }));
  return { base, alt, rows, main, cushion, baseShort: firstShort(base), altShort: firstShort(alt), until };
}
