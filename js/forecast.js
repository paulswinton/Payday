// Forecast: start from today's real balances, then play forward every planned
// payment, transfer and expected salary, day by day, to the end of the plan.
import { addDays, daysBetween, lastDayOfMonth, periodFor, ymd, addMonths } from './calendar.js';
import { balances, setting } from './model.js';
import { allOccurrences, planPeriods } from './plan.js';

export const mainAccountId = state => setting(state, 'mainAccount', 'acc-current');
export const cushionOf = state => setting(state, 'cushion', 0);

function trackedIds(state) {
  return Object.values(state.account).filter(a => a.tracked !== false && !a.archived).map(a => a.id);
}

// Estimated card interest: monthly on the 1st, from the APR entered for the card.
function interestFlows(state, start, until, runningDebt) {
  const flows = [];
  for (const a of Object.values(state.account)) {
    if (a.type !== 'card' || !a.apr || a.tracked === false) continue;
    let k = start.slice(0, 7);
    for (; k <= until.slice(0, 7); k = addMonths(k, 1)) {
      const d = `${k}-01`;
      if (d <= start || d > until) continue;
      flows.push({ date: d, account: a.id, interest: a.apr, label: `${a.name} interest (estimate)`, estimate: true });
    }
  }
  return flows;
}

// Everyday spending isn't planned payment by payment, so each future payday
// period sets aside an allowance for it (Settings). Without it, unspent salary
// would pile up in the forecast and every purchase would look affordable.
export function everydayFor(state, periodStart) {
  const base = setting(state, 'everydaySpend', null);
  if (base == null) return null;
  let amount = base;
  for (const ch of setting(state, 'everydayChanges', []) || []) {
    if (ch.from <= periodStart && (!ch.to || periodStart <= ch.to)) amount += ch.delta;
  }
  return Math.max(0, amount);
}

export function project(state, { today, until, extraFlows = [], everyday = true }) {
  const start = setting(state, 'startDate', today);
  const now = balances(state, today);
  const ids = trackedIds(state);
  const flows = [];
  for (const o of allOccurrences(state, start, until, today)) {
    if (o.status === 'paid' || o.status === 'skipped') continue;
    const date = o.date < today ? today : o.date;
    if (date > until) continue;
    const base = { date, amount: o.amount, label: o.name, occ: o.key, overdue: o.status === 'overdue', kind: o.kind };
    if (o.from && ids.includes(o.from)) flows.push({ ...base, account: o.from, delta: -o.amount });
    if (o.to && ids.includes(o.to)) flows.push({ ...base, account: o.to, delta: o.amount });
  }
  for (const f of extraFlows) if (ids.includes(f.account) && f.date >= today && f.date <= until) flows.push({ ...f });
  const main = mainAccountId(state);
  if (everyday && ids.includes(main)) {
    for (const p of planPeriods(state)) {
      if (p.start <= today || p.start > until) continue;   // the current period is what safe-to-spend covers
      const amount = everydayFor(state, p.start);
      if (amount) flows.push({ date: p.start, account: main, delta: -amount, amount, label: 'Everyday spending (allowance)', estimate: true, everyday: true });
    }
  }
  flows.push(...interestFlows(state, today, until));
  flows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const list = planPeriods(state).filter(p => p.end >= today && p.start <= until);
  const bal = {};
  for (const id of ids) bal[id] = now[id] ?? 0;
  const stats = {};
  const lowest = {}, firstNegative = {}, series = {};
  for (const id of ids) { lowest[id] = { value: bal[id], date: today }; series[id] = []; }
  let i = 0;
  const days = Math.max(0, daysBetween(today, until));
  for (let n = 0; n <= days; n++) {
    const d = addDays(today, n);
    while (i < flows.length && flows[i].date === d) {
      const f = flows[i++];
      if (f.interest) {
        const debt = -bal[f.account];
        if (debt > 0) { f.delta = -Math.round(debt * f.interest / 100 / 12); f.amount = -f.delta; bal[f.account] += f.delta; }
        else f.delta = 0;
      } else bal[f.account] += f.delta;
    }
    const p = periodFor(d, list);
    for (const id of ids) {
      const v = bal[id];
      if (v < lowest[id].value) lowest[id] = { value: v, date: d };
      if (v < 0 && !firstNegative[id]) firstNegative[id] = d;
      if (p) {
        const key = p.key;
        stats[key] ??= { key, start: p.start, end: p.end, acc: {} };
        const s = stats[key].acc[id] ??= { open: v, low: v, lowDate: d, close: v };
        if (v < s.low) { s.low = v; s.lowDate = d; }
        s.close = v;
      }
    }
    const last = n === days;
    for (const id of ids) {
      const arr = series[id];
      if (last || !arr.length || arr[arr.length - 1][1] !== bal[id]) arr.push([d, bal[id]]);
    }
  }
  return { today, until, start: now, end: { ...bal }, flows, periods: list.map(p => stats[p.key]).filter(Boolean), lowest, firstNegative, series };
}

function lowIn(proj, id, from, to) {
  let best = null;
  for (const p of proj.periods) {
    if (p.end < from || p.start > to) continue;
    const s = p.acc[id];
    if (s && (best === null || s.low < best.value)) best = { value: s.low, date: s.lowDate };
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

// Would a purchase fit? Checked from its date until 12 months later.
export function canAfford(state, { today, amount, date, from, months = 12 }) {
  const list = planPeriods(state);
  const planEnd = list[list.length - 1].end;
  const later = (() => { const k = addMonths(date.slice(0, 7), months); const [y, m] = k.split('-').map(Number); return ymd(y, m, Math.min(Number(date.slice(8)), lastDayOfMonth(y, m))); })();
  const windowEnd = later < planEnd ? later : planEnd;
  const main = mainAccountId(state);
  const threshold = from === main ? cushionOf(state) : 0;
  const base = project(state, { today, until: windowEnd });
  const withIt = project(state, { today, until: windowEnd, extraFlows: [{ date, account: from, delta: -amount, amount, label: 'Planned purchase' }] });
  const lowBase = lowIn(base, from, date, windowEnd) ?? { value: base.end[from], date };
  const lowWith = lowIn(withIt, from, date, windowEnd) ?? { value: withIt.end[from], date };
  const paydays = list.filter(p => p.start > today && p.start <= date).length;
  let verdict, short = 0;
  if (lowWith.value >= threshold) verdict = 'yes';
  else if (lowBase.value < threshold) { verdict = 'plan-short'; short = threshold - lowWith.value; }
  else { verdict = 'no'; short = threshold - lowWith.value; }
  const perPayday = short > 0 && paydays > 0 ? Math.ceil(short / paydays) : null;
  return { verdict, margin: lowWith.value - threshold, short, lowBase, lowWith, threshold, windowEnd, paydays, perPayday, from, amount, date };
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
