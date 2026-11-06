// "Can I afford it?" — checked against every account you track, at every date,
// for a year after the purchase. Four honest answers: fits, fits but tight,
// doesn't fit, or can't tell yet. When it doesn't fit, Payday works out what
// would make it fit: saving each payday, a later date, or a lower amount.
import { project, scenarioState, mainAccountId, lowIn, everydayCover, trackedIds } from './forecast.js';
import { planPeriods } from './plan.js';
import { floorOf, roleOf } from './roles.js';
import { setting } from './model.js';
import { addMonths, lastDayOfMonth, ymd, daysBetween } from './calendar.js';
import { paydaysBefore } from './goals.js';

const plusMonths = (date, n) => {
  const k = addMonths(date.slice(0, 7), n);
  const [y, m] = k.split('-').map(Number);
  return ymd(y, m, Math.min(Number(date.slice(8)), lastDayOfMonth(y, m)));
};

export const comfortOf = state => setting(state, 'comfortMargin', 25000);

function scenarioFor(input) {
  const it = input.monthly
    ? { id: 'x', type: 'monthly', name: input.what, amount: input.amount, from: input.from, day: Number(input.date.slice(8)), start: input.date, end: input.end || null }
    : { id: 'x', type: 'once', name: input.what, amount: input.amount, from: input.from, date: input.date };
  return { id: 'afford', items: [it, ...(input.extraItems || [])] };
}

function lastCheckOf(state, id) {
  return Object.values(state.check).filter(c => c.account === id).sort((a, b) => (b.at || b.date).localeCompare(a.at || a.date))[0] || null;
}

// Compare the plan with and without the purchase on every tracked account.
function compare(state, input, today, windowEnd, base) {
  const alt = project(scenarioState(state, scenarioFor(input)), { today, until: windowEnd });
  const problems = [];
  for (const id of trackedIds(state)) {
    const a = state.account[id];
    if (a.type === 'card' || roleOf(state, a) === 'allowance') continue;
    const thr = floorOf(state, a);
    const bl = lowIn(base, id, today, windowEnd), al = lowIn(alt, id, today, windowEnd);
    if (!al || al.value >= thr) continue;
    const already = bl && bl.value < thr;
    if (already && al.value >= bl.value) continue; // unchanged by this purchase
    problems.push({ id, name: a.name, low: al.value, date: al.date, short: thr - al.value, threshold: thr, already, worse: already ? bl.value - al.value : null });
  }
  const payerLow = lowIn(alt, input.from, input.date, windowEnd);
  return { alt, problems, payerLow };
}

export function assess(state, input, today, { fixes = true } = {}) {
  const list = planPeriods(state);
  const planEnd = list[list.length - 1].end;
  const later = plusMonths(input.date, 12);
  const windowEnd = later < planEnd ? later : planEnd;
  const main = mainAccountId(state);
  const base = project(state, { today, until: windowEnd });
  const { alt, problems, payerLow } = compare(state, input, today, windowEnd, base);
  const payer = state.account[input.from];
  const thr = floorOf(state, payer);
  const margin = payerLow ? payerLow.value - thr : null;
  const mainLow = lowIn(alt, main, today, windowEnd);

  // What could make the answer wrong.
  const caveats = [];
  let unknown = null;
  const cover = everydayCover(state);
  if (!cover) {
    caveats.push('Day-to-day spending is not set, so the forecast assumes you spend nothing day to day.');
    if (input.from === main) unknown = 'Set how your day-to-day spending is paid (a spending allowance account or an amount per payday) first.';
  }
  for (const id of new Set([input.from, main])) {
    const c = lastCheckOf(state, id);
    const name = state.account[id]?.name;
    if (!c) { caveats.push(`${name} has never been checked against your bank.`); unknown ??= `Check ${name} against your bank first, so the starting figure is right.`; }
    else if (daysBetween(c.date, today) > 14) caveats.push(`${name} was last checked against your bank ${daysBetween(c.date, today)} days ago.`);
  }
  const estimates = [...new Set(alt.flows.filter(f => f.estimate && !f.everyday && f.ruleId && (f.account === input.from || f.account === main)).map(f => f.ruleId))]
    .map(id => state.rule[id]?.name).filter(Boolean);
  if (estimates.length) caveats.push(`Estimated, not confirmed: ${estimates.slice(0, 4).join(', ')}${estimates.length > 4 ? ` and ${estimates.length - 4} more` : ''}.`);
  const overdue = alt.flows.filter(f => f.overdue && f.delta < 0 && (f.account === input.from || f.account === main));
  if (overdue.length) caveats.push(`${overdue.length} overdue payment${overdue.length === 1 ? ' is' : 's are'} counted as still to go out today.`);

  const fresh = problems.filter(p => !p.already || p.worse > 0);
  const newOnes = problems.filter(p => !p.already);
  let verdict;
  if (newOnes.length) verdict = 'no';
  else if (problems.some(p => p.already)) verdict = 'plan-short';
  else if (unknown) verdict = 'unknown';
  else if (input.from === main && margin < comfortOf(state)) verdict = 'tight';
  else verdict = 'yes';

  const result = { verdict, input, windowEnd, problems, fresh, payerLow, margin, threshold: thr, mainLow, caveats, unknown, cover, fixes: null };
  if (fixes && verdict === 'no') result.fixes = findFixes(state, input, today, windowEnd, base, problems);
  return result;
}

function fits(state, input, today) {
  const r = assess(state, input, today, { fixes: false });
  return r.verdict === 'yes' || r.verdict === 'tight' || r.verdict === 'unknown';
}

function findFixes(state, input, today, windowEnd, base, problems) {
  const main = mainAccountId(state);
  const out = {};
  // 1. Save into the paying pot each payday before the date.
  const payerProblem = problems.find(p => p.id === input.from && !p.already);
  const paydays = paydaysBefore(state, today, input.date);
  if (payerProblem && input.from !== main && paydays.length) {
    const per = Math.ceil(payerProblem.short / paydays.length);
    const extra = [{ id: 'save', type: 'payday', name: `Save for ${input.what}`, amount: per, from: main, to: input.from, start: paydays[0].start, end: paydays[paydays.length - 1].start }];
    const ok = fits(state, { ...input, extraItems: extra }, today);
    out.save = { perPayday: per, paydays: paydays.length, into: state.account[input.from].name, ok };
  } else if (payerProblem && input.from === main && paydays.length) {
    out.save = { perPayday: Math.ceil(payerProblem.short / paydays.length), paydays: paydays.length, into: null, ok: null };
  }
  // 2. The earliest month it fits at the same price (up to two years on).
  for (let k = 1; k <= 24; k++) {
    const d = plusMonths(input.date, k);
    if (d > planPeriods(state).slice(-1)[0].end) break;
    if (fits(state, { ...input, date: d }, today)) { out.later = { date: d, months: k }; break; }
  }
  // 3. The most it could cost on the date you chose, to the nearest pound.
  let lo = 0, hi = Math.floor((input.amount - 1) / 100);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(state, { ...input, amount: mid * 100 }, today)) lo = mid; else hi = mid - 1;
  }
  lo *= 100;
  out.maxAmount = lo;
  return out;
}
