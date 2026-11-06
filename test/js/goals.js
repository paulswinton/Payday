// Goals: something you are saving for, paid in one or more instalments from a pot
// (e.g. a holiday: deposit in December, balance in February). Each instalment is a
// real planned payment, so the forecast, Today and the payday checklist all see it.
// Payday works out the extra you need to save each payday so that EVERY instalment
// is covered on its date, not just the total by the last one.
import { makeEvent, newId, balances } from './model.js';
import { allOccurrences, planPeriods } from './plan.js';
import { project, scenarioState, mainAccountId, cushionOf, lowIn } from './forecast.js';
import { floorOf } from './roles.js';
import { addDays, addMonths } from './calendar.js';

export const goalRules = (state, goalId) => Object.values(state.rule).filter(r => r.goal === goalId && !r.deleted && r.kind !== 'transfer');
export const goalSavingRules = (state, goalId) => Object.values(state.rule).filter(r => r.goal === goalId && !r.deleted && r.kind === 'transfer');

export function goalInstalments(state, goalId, today) {
  const rules = goalRules(state, goalId);
  if (!rules.length) return [];
  const dates = rules.map(r => r.sched.date).sort();
  return allOccurrences(state, dates[0], dates[dates.length - 1], today).filter(o => o.goal === goalId);
}

// Paydays you can still save from before a date (today counts if the salary hasn't been confirmed yet).
export function paydaysBefore(state, today, date) {
  const salaryPaid = new Set(Object.values(state.txn).filter(t => t.occ?.startsWith('r-salary|')).map(t => t.occ.split('|')[1]));
  return planPeriods(state).filter(p => (p.start > today || (p.start === today && !salaryPaid.has(p.start))) && p.start <= date);
}

// Smallest extra amount per payday that keeps the pot at or above its floor on every
// day up to `until`, given the balances in a projection.
function extraNeeded(state, proj, pot, today, until) {
  const floor = floorOf(state, state.account[pot]);
  let need = 0, impossible = null, worst = null;
  for (const [d, v] of proj.series[pot] || []) {
    if (d > until || v >= floor) continue;
    const short = floor - v;
    const n = paydaysBefore(state, today, d).length;
    if (!worst || short > worst.short) worst = { date: d, short };
    if (n === 0) { if (!impossible) impossible = { date: d, short }; continue; }
    need = Math.max(need, Math.ceil(short / n));
  }
  return { perPayday: need, impossible, worst };
}

export function goalStatus(state, goalId, today) {
  const goal = state.goal?.[goalId];
  if (!goal) return null;
  const inst = goalInstalments(state, goalId, today).sort((a, b) => a.date.localeCompare(b.date));
  const total = inst.reduce((t, o) => t + o.amount, 0);
  const paid = inst.reduce((t, o) => t + (o.status === 'paid' ? o.amount : o.paidAmount || 0), 0);
  const open = inst.filter(o => o.status !== 'paid' && o.status !== 'skipped');
  const pot = goal.pot;
  const potNow = balances(state, today)[pot] ?? 0;
  const last = open.length ? open[open.length - 1].date : null;
  const base = { goal, instalments: inst, total, paid, open, potNow, last, saving: goalSavingRules(state, goalId) };
  if (!last || !state.account[pot] || state.account[pot].tracked === false) return { ...base, onTrack: !open.length, perPayday: 0 };
  const until = last < today ? today : last;
  const proj = project(state, { today, until });
  const { perPayday, impossible, worst } = extraNeeded(state, proj, pot, today, until);
  const paydays = paydaysBefore(state, today, until);
  // Each instalment: will the pot have enough on the day?
  const perInstalment = open.map(o => {
    const bal = (proj.series[pot] || []).filter(([d]) => d <= (o.date < today ? today : o.date)).pop()?.[1] ?? potNow;
    return { ...o, covered: bal >= floorOf(state, state.account[pot]), potAfter: bal };
  });
  let carry = null;
  if (perPayday > 0 && paydays.length) carry = canCarry(state, today, goal, perPayday, paydays[0].start, paydays[paydays.length - 1].start);
  return { ...base, onTrack: perPayday === 0 && !impossible, perPayday, impossible, worst, paydays: paydays.length, perInstalment, carry };
}

// Can the main account afford to move `amount` into the goal's pot each payday?
export function canCarry(state, today, goal, amount, first, last) {
  const main = mainAccountId(state);
  const scen = { id: 'carry', items: [{ id: 'save', type: 'payday', name: `Save for ${goal.name}`, amount, from: main, to: goal.pot, start: first, end: last }] };
  const until = addDays(last, 40);
  const alt = project(scenarioState(state, scen), { today, until });
  const base = project(state, { today, until });
  const low = lowIn(alt, main, today, until), baseLow = lowIn(base, main, today, until);
  const cushion = cushionOf(state);
  return { ok: !low || low.value >= cushion, low, baseLow, cushion };
}

// ---- Commands --------------------------------------------------------------------
export function saveGoal(state, { id, name, pot, instalments, adopt = [] }) {
  name = String(name || '').trim();
  if (!name) throw new Error('Give the goal a name.');
  if (!pot || !state.account[pot]) throw new Error('Choose the pot it is saved in.');
  if (!instalments.length) throw new Error('Add at least one payment.');
  for (const it of instalments) {
    if (!Number.isInteger(it.amount) || it.amount <= 0) throw new Error('Every payment needs an amount.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date || '')) throw new Error('Every payment needs a date.');
  }
  const goalId = id || newId('goal');
  const changes = [{ kind: 'goal', key: goalId, value: { id: goalId, name, pot, created: state.goal?.[goalId]?.created || new Date().toISOString() } }];
  const keep = new Set();
  for (const it of instalments) {
    const rid = it.ruleId || newId('r');
    keep.add(rid);
    const old = state.rule[rid];
    changes.push({ kind: 'rule', key: rid, value: { ...(old || {}), id: rid, name: `${name}: ${it.label || 'payment'}`, label: it.label || 'payment', kind: 'bill', amount: it.amount,
      from: it.from || pot, to: null, sched: { type: 'once', date: it.date }, start: it.date, end: null, versions: [], shift: false, goal: goalId, category: 'must' } });
  }
  for (const r of goalRules(state, goalId)) if (!keep.has(r.id)) changes.push({ kind: 'rule', key: r.id, value: { ...r, deleted: true } });
  // Existing one-off payments that belong to this goal are replaced, so nothing is counted twice.
  for (const rid of adopt) if (state.rule[rid] && !keep.has(rid)) changes.push({ kind: 'rule', key: rid, value: { ...state.rule[rid], deleted: true, replacedBy: goalId } });
  return makeEvent(state, `${state.goal?.[goalId] ? 'Changed' : 'Added'} goal: ${name}`, changes);
}

export function deleteGoal(state, goalId) {
  const g = state.goal?.[goalId];
  if (!g) throw new Error('That goal no longer exists.');
  const changes = [{ op: 'remove', kind: 'goal', key: goalId }];
  for (const r of [...goalRules(state, goalId), ...goalSavingRules(state, goalId)]) changes.push({ kind: 'rule', key: r.id, value: { ...r, deleted: true } });
  return makeEvent(state, `Deleted goal: ${g.name}`, changes);
}

// Add the extra saving to the real plan: a transfer into the goal's pot each payday.
export function addGoalSaving(state, goalId, amount, first, last) {
  const g = state.goal[goalId];
  const id = newId('r');
  return makeEvent(state, `Saving ${amount / 100} each payday for ${g.name}`, [{ kind: 'rule', key: id, value: {
    id, name: `Save for ${g.name}`, kind: 'transfer', amount, from: mainAccountId(state), to: g.pot, sched: { type: 'payday' },
    start: first, end: last, versions: [], shift: false, goal: goalId, category: 'saving' } }]);
}

export { addMonths };
