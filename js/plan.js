// Regular payments ("rules") and their individual occurrences.
import { addDays, addMonths, lastDayOfMonth, monthKey, nextWorkingDay, paydayFor, periods, periodFor, ymd } from './calendar.js';

export const FIRST_PERIOD = '2026-10';
export const LAST_PERIOD = '2031-04';

export function planPeriods(state) {
  const overrides = state.setting.paydayOverrides?.value || {};
  const first = state.setting.firstPeriod?.value || FIRST_PERIOD;
  const last = state.setting.lastPeriod?.value || LAST_PERIOD;
  return periods(first, last, overrides);
}

// A rule's fields in force on a date: base values overlaid by dated versions.
export function versionAt(rule, date) {
  const v = { ...rule };
  for (const ver of [...(rule.versions || [])].sort((a, b) => a.from.localeCompare(b.from))) {
    if (ver.from <= date) Object.assign(v, ver.set);
  }
  return v;
}

function inRange(rule, nominal) {
  return nominal >= rule.start && (!rule.end || nominal <= rule.end);
}

// Every occurrence of a rule whose nominal date falls in [from, to].
export function occurrences(rule, from, to, state) {
  if (rule.deleted) return [];
  const list = planPeriods(state);
  const overrides = state.setting.paydayOverrides?.value || {};
  const out = [];
  const push = (nominal, expected, period) => {
    const v = versionAt(rule, nominal);
    if (v.paused) return;
    const key = `${rule.id}|${nominal}`;
    const o = state.occ[key] || {};
    out.push({
      key, ruleId: rule.id, nominal, date: o.date || expected, amount: o.amount ?? v.amount,
      name: v.name, kind: v.kind, from: v.from, to: v.to, skipped: !!o.skip, edited: o.amount != null || !!o.date,
      variable: !!v.variable, undated: v.sched.type === 'undated', period: period?.key || null,
    });
  };
  const type = rule.sched.type;
  if (type === 'payday' || type === 'undated') {
    for (const p of list) {
      if (p.start < from || p.start > to || !inRange(rule, p.start)) continue;
      push(p.start, p.start, p);
    }
  } else if (type === 'monthly' || type === 'annual') {
    let k = monthKey(from);
    const lastK = monthKey(to);
    for (; k <= lastK; k = addMonths(k, 1)) {
      const [y, m] = k.split('-').map(Number);
      const v = versionAt(rule, ymd(y, m, 1));
      if (type === 'annual' && m !== v.sched.month) continue;
      const day = Math.min(v.sched.day, lastDayOfMonth(y, m));
      const nominal = ymd(y, m, day);
      if (nominal < from || nominal > to || !inRange(rule, nominal)) continue;
      const expected = rule.shift === false ? nominal : nextWorkingDay(nominal);
      push(nominal, expected, periodFor(expected, list));
    }
  } else if (type === 'once') {
    const d = rule.sched.date;
    if (d >= from && d <= to) push(d, d, periodFor(d, list));
  }
  return out.map(o => ({ ...o, period: o.period || periodFor(o.date, list)?.key || null }));
}

export function settledIndex(state) {
  const idx = {};
  for (const t of Object.values(state.txn)) if (t.occ) idx[t.occ] = t;
  return idx;
}

// All occurrences of all rules in a date window, with their status today.
export function allOccurrences(state, from, to, today) {
  const settled = settledIndex(state);
  const out = [];
  for (const r of Object.values(state.rule)) {
    for (const o of occurrences(r, from, to, state)) {
      const txn = settled[o.key];
      const status = txn ? 'paid' : o.skipped ? 'skipped' : o.date < today ? 'overdue' : 'planned';
      out.push({ ...o, status, txn: txn || null });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name)));
}

export function occurrenceByKey(state, key) {
  const [ruleId, nominal] = key.split('|');
  const r = state.rule[ruleId];
  if (!r) return null;
  return occurrences(r, nominal, nominal, state).find(o => o.key === key) || null;
}

export function describeSchedule(rule) {
  const s = rule.sched;
  if (s.type === 'payday') return 'Every payday';
  if (s.type === 'undated') return 'Monthly · date to confirm';
  if (s.type === 'monthly') return `Monthly on the ${ordinal(s.day)}`;
  if (s.type === 'annual') return `Every year on ${s.day} ${new Date(Date.UTC(2026, s.month - 1, 1)).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })}`;
  if (s.type === 'once') return 'One-off';
  return '';
}
export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
export { addDays };
