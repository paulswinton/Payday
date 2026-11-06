// The payday checklist: what to do with this payday's salary, worked out from
// actual scheduled payments and the money already in each account.
import { balances, makeEvent, newId } from './model.js';
import { allOccurrences, planPeriods } from './plan.js';
import { addDays, addMonths } from './calendar.js';
import { project, mainAccountId, cushionOf, fundedTxn, fundKey } from './forecast.js';
import { categoryOf, roleOf, accountsWithRole, fundsToNeed } from './roles.js';
import { goalStatus } from './goals.js';
import { validateTxn } from './commands.js';
import { formatPounds } from './money.js';


export function payRun(state, periodKey, today) {
  const list = planPeriods(state);
  const i = list.findIndex(p => p.key === periodKey);
  if (i < 0) return null;
  const p = list[i], next = list[i + 1] || null;
  const main = mainAccountId(state);
  const ready = p.start <= today;
  const recordsStart = state.setting.startDate?.value || p.start;
  const from = addDays(p.start, -40) > recordsStart ? addDays(p.start, -40) : recordsStart;
  const occ = allOccurrences(state, from, p.end, today);
  const inPeriod = occ.filter(o => o.period === p.key && o.status !== 'skipped');

  // Salary
  const salaryOcc = inPeriod.find(o => o.ruleId === 'r-salary') || null;
  const salary = salaryOcc ? {
    key: salaryOcc.key, expected: salaryOcc.amount, received: salaryOcc.status === 'paid' ? salaryOcc.txn.amount : null,
    done: salaryOcc.status === 'paid', date: salaryOcc.date,
  } : null;
  // Balances at the end of the previous period: real if that has passed, forecast if not.
  const startBal = p.start <= today ? balances(state, addDays(p.start, -1))
    : project(state, { today, until: addDays(p.start, -1), fund: true }).end;
  const broughtForward = startBal[main] ?? 0;

  // Direct debits and card payments that come straight out of the main account this period.
  const keep = inPeriod.filter(o => o.from === main && o.ruleId !== 'r-salary' && !isPaydayRule(state, o))
    .map(o => ({ ...o, done: o.status === 'paid' }));
  // Anything from before this payday that should have gone out of the main account and hasn't been marked.
  const overdue = p.start > today ? [] : occ.filter(o => o.from === main && o.date < p.start && o.status === 'overdue').map(o => ({ ...o, done: false }));
  const keepTotal = [...keep, ...overdue].filter(o => !o.done).reduce((t, o) => t + (o.remaining ?? o.amount), 0);

  // Bills accounts: what they need before next payday, less what is already there.
  const fund = Object.values(state.account).filter(a => fundsToNeed(state, a)).map(a => {
    const outs = inPeriod.filter(o => o.from === a.id);
    const need = outs.reduce((t, o) => t + o.amount, 0) - inPeriod.filter(o => o.to === a.id && o.from !== main).reduce((t, o) => t + o.amount, 0);
    // Money in the account at the end of the last period, less anything from before that is still to come out.
    const before = startBal[a.id] ?? 0;
    const owedEarlier = p.start > today ? 0 : occ.filter(o => o.from === a.id && o.date < p.start && (o.status === 'overdue' || o.status === 'planned')).reduce((t, o) => t + o.amount, 0);
    const available = before - owedEarlier;
    const buffer = a.buffer || 0;
    const amount = Math.max(0, need + buffer - available);
    const txn = fundedTxn(state, a.id, p.key);
    return { account: a, need, buffer, available, before, owedEarlier, amount, done: !!txn, txn, payments: outs };
  });
  const fundTotal = fund.filter(f => !f.done).reduce((t, f) => t + f.amount, 0);

  // Standing orders and allocations made on payday, grouped by what they are for.
  const payday = inPeriod.filter(o => o.from === main && isPaydayRule(state, o)).map(o => {
    const cat = categoryOf(state, state.rule[o.ruleId] || o);
    let amount = o.amount, note = '';
    const to = state.account[o.to];
    if (o.untilTarget && to?.target != null && to.tracked !== false) {
      const now = balances(state, today)[to.id] ?? 0;
      const room = Math.max(0, to.target - now);
      if (o.status !== 'paid' && room < amount) { amount = room; note = room === 0 ? `${to.name} has reached its ${formatPounds(to.target)} target` : `Tops ${to.name} up to its ${formatPounds(to.target)} target`; }
    }
    return { ...o, category: cat, amount, planned: o.amount, note, done: o.status === 'paid' };
  });
  const groups = ['must', 'allowance', 'saving'].map(c => ({ category: c, items: payday.filter(o => o.category === c) }));
  const paydayTotal = payday.filter(o => !o.done).reduce((t, o) => t + o.amount, 0);

  // Money set aside for known payments (e.g. accommodation): covered until when?
  const until = addDays(p.start, 400);
  const holdProj = accountsWithRole(state, 'holding').length ? project(state, { today, until }) : null;
  const upcoming = holdProj ? allOccurrences(state, today, until, today) : [];
  const holding = accountsWithRole(state, 'holding').filter(a => upcoming.some(o => o.from === a.id)).map(a => {
    const proj = holdProj;
    const neg = proj.firstNegative[a.id] || null;
    const outs = occ.filter(o => o.from === a.id);
    const next = upcoming.filter(o => o.from === a.id && o.status !== 'paid' && o.status !== 'skipped');
    const coveredUntil = neg ? next.filter(o => o.date < neg).pop()?.date || null : next[next.length - 1]?.date || null;
    const short = neg ? -(proj.series[a.id].find(([d]) => d === neg)?.[1] ?? 0) : 0;
    return { account: a, firstShort: neg, coveredUntil, short, payments: next.length, monthlyOut: outs[0]?.amount || 0 };
  });

  // Goals that need extra each payday.
  const goals = Object.values(state.goal || {}).map(g => goalStatus(state, g.id, today)).filter(Boolean).filter(g => g.open.length);

  const salaryAmount = salary ? (salary.received ?? salary.expected) : 0;
  const committed = keepTotal + fundTotal + paydayTotal;
  // What the main account has once everything due this period has gone.
  const doneOut = keep.filter(o => o.done).reduce((t, o) => t + o.txn.amount, 0) + fund.filter(f => f.done).reduce((t, f) => t + f.txn.amount, 0)
    + payday.filter(o => o.done).reduce((t, o) => t + o.txn.amount, 0);
  const left = broughtForward + salaryAmount - doneOut - committed;
  const cushion = cushionOf(state);
  const goalNeed = goals.reduce((t, g) => t + (g.perPayday || 0), 0);
  const spare = left - cushion;

  const steps = [salary && !salary.done, ...fund.map(f => !f.done && f.amount > 0), ...payday.map(o => !o.done && o.amount > 0)];
  const todo = steps.filter(Boolean).length;
  const total = (salary ? 1 : 0) + fund.filter(f => f.amount > 0 || f.done).length + payday.filter(o => o.amount > 0 || o.done).length;
  return { period: p, next, ready, salary, broughtForward, keep, overdue, keepTotal, fund, fundTotal, groups, payday, paydayTotal, holding, goals, goalNeed,
    left, cushion, spare, todo, total, complete: todo === 0, main };
}

function isPaydayRule(state, o) {
  const r = state.rule[o.ruleId];
  return r?.sched?.type === 'payday';
}

// Record what is left to do in one go, exactly as shown. Salary must be confirmed first.
export function recordAll(state, run, today) {
  if (!run.ready) throw new Error('This can be done on payday.');
  if (run.salary && !run.salary.done) throw new Error('Confirm your salary first.');
  const date = run.period.start <= today ? run.period.start : today;
  const now = new Date().toISOString();
  const changes = [];
  const add = t => { const x = { id: newId('tx'), created: now, note: '', occ: null, ...t }; validateTxn(state, x, today); changes.push({ kind: 'txn', key: x.id, value: x }); };
  for (const f of run.fund) if (!f.done && f.amount > 0) add(fundTxn(run, f, date));
  for (const o of run.payday) if (!o.done && o.amount > 0) add({ kind: o.kind === 'bill' ? 'bill' : 'transfer', amount: o.amount, date: o.date <= today ? o.date : date, from: o.from, to: o.to || null, desc: o.name, occ: o.key });
  if (!changes.length) throw new Error('Everything is already done.');
  return makeEvent(state, `Payday ${run.period.start}: recorded ${changes.length} item${changes.length === 1 ? '' : 's'}`, changes);
}

export function fundTxn(run, f, date) {
  return { kind: 'transfer', amount: f.amount, date, from: run.main, to: f.account.id, desc: `Top up ${f.account.name}`, fund: fundKey(f.account.id, run.period.key),
    note: `Needed before next payday: ${formatPounds(f.need + f.buffer)}. Already there: ${formatPounds(f.available)}.` };
}

export function recordFund(state, run, f, today, amount) {
  const date = run.period.start <= today ? run.period.start : today;
  const t = { id: newId('tx'), created: new Date().toISOString(), occ: null, ...fundTxn(run, f, date), amount };
  validateTxn(state, t, today);
  return makeEvent(state, `Moved ${formatPounds(amount)} to ${f.account.name}`, [{ kind: 'txn', key: t.id, value: t }]);
}

export { roleOf, addMonths };
