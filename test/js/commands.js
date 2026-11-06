// Every user action becomes one journal event. These functions validate the
// action against the current state and return the event; nothing is changed
// until the caller saves and applies it.
import { makeEvent, newId, balances } from './model.js';
import { occurrenceByKey } from './plan.js';
import { formatPounds } from './money.js';
import { addDays } from './calendar.js';

const KIND_LABEL = { spend: 'Spend', bill: 'Payment', income: 'Money in', transfer: 'Transfer', adjust: 'Bank correction' };

export function validateTxn(state, t, today) {
  if (!Number.isInteger(t.amount) || t.amount <= 0 || t.amount > 100000000) throw new Error('Enter an amount between £0.01 and £1,000,000.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date || '')) throw new Error('Choose a date.');
  if (t.date > today) throw new Error('That date is in the future. Plan it as a payment instead, or record it on the day.');
  const start = state.setting.startDate?.value;
  if (start && t.date < start) throw new Error('Payday records start on ' + start + '. Choose a later date.');
  if (!t.from && !t.to) throw new Error('Choose an account.');
  if (t.from && t.from === t.to) throw new Error('Choose two different accounts.');
  for (const id of [t.from, t.to]) if (id && !state.account[id]) throw new Error('That account no longer exists.');
  if (!String(t.desc || '').trim()) throw new Error('Add a short description.');
}

export function addTxn(state, input, today) {
  const t = { id: newId('tx'), created: new Date().toISOString(), note: '', occ: null, ...input, desc: String(input.desc || '').trim().slice(0, 120) };
  validateTxn(state, t, today);
  if (t.occ && Object.values(state.txn).some(x => x.occ === t.occ) && !state.rule[t.occ.split('|')[0]]?.goal) throw new Error('This planned payment is already marked as paid.');
  return makeEvent(state, `${KIND_LABEL[t.kind] || 'Transaction'}: ${t.desc} ${formatPounds(t.amount)}`, [{ kind: 'txn', key: t.id, value: t }]);
}

export function editTxn(state, id, changes, today) {
  const old = state.txn[id];
  if (!old) throw new Error('That transaction no longer exists.');
  const t = { ...old, ...changes, id, edited: new Date().toISOString() };
  t.desc = String(t.desc || '').trim().slice(0, 120);
  validateTxn(state, t, today);
  return makeEvent(state, `Edited: ${t.desc}`, [{ kind: 'txn', key: id, value: t }]);
}

export function deleteTxn(state, id) {
  const old = state.txn[id];
  if (!old) throw new Error('That transaction no longer exists.');
  return makeEvent(state, `Deleted: ${old.desc} ${formatPounds(old.amount)}`, [{ op: 'remove', kind: 'txn', key: id }]);
}

// Put back any earlier version of a transaction (also brings back a deleted one).
export function restoreTxnVersion(state, id, version, today) {
  const t = { ...version, id, restored: new Date().toISOString() };
  validateTxn(state, t, today);
  if (t.occ && Object.values(state.txn).some(x => x.occ === t.occ && x.id !== id)) throw new Error('That planned payment has since been marked paid by another entry.');
  return makeEvent(state, `Restored: ${t.desc}`, [{ kind: 'txn', key: id, value: t }]);
}

export function markPaid(state, occKey, { date, amount, note = '' }, today) {
  const o = occurrenceByKey(state, occKey);
  if (!o) throw new Error('That planned payment no longer exists.');
  const kind = o.kind === 'income' ? 'income' : o.kind === 'transfer' ? 'transfer' : 'bill';
  return addTxn(state, { kind, amount: amount ?? o.amount, date: date || today, from: o.from || null, to: o.to || null, desc: o.name, note, occ: occKey }, today);
}

export function setOccurrence(state, occKey, patch, label) {
  const current = state.occ[occKey] || {};
  const value = { ...current, ...patch };
  for (const k of Object.keys(value)) if (value[k] === null || value[k] === undefined || value[k] === false) delete value[k];
  const change = Object.keys(value).length ? { kind: 'occ', key: occKey, value } : (state.occ[occKey] ? { op: 'remove', kind: 'occ', key: occKey } : null);
  if (!change) throw new Error('Nothing to change.');
  return makeEvent(state, label, [change]);
}

export function saveRule(state, rule) {
  if (!String(rule.name || '').trim()) throw new Error('Give the payment a name.');
  if (!Number.isInteger(rule.amount) || rule.amount <= 0) throw new Error('Enter the amount.');
  if (!rule.from && !rule.to) throw new Error('Choose which account it uses.');
  const id = rule.id || newId('r');
  const value = { versions: [], shift: true, ...rule, id, name: rule.name.trim() };
  return makeEvent(state, `${state.rule[id] ? 'Changed' : 'Added'} regular payment: ${value.name}`, [{ kind: 'rule', key: id, value }]);
}

// Change a regular payment from a date onward, keeping history before it.
export function changeRuleFrom(state, ruleId, from, set) {
  const r = state.rule[ruleId];
  if (!r) throw new Error('That regular payment no longer exists.');
  const versions = (r.versions || []).filter(v => v.from !== from).concat([{ from, set }]);
  return makeEvent(state, `Changed ${r.name} from ${from}`, [{ kind: 'rule', key: ruleId, value: { ...r, versions } }]);
}

export function endRule(state, ruleId, lastDate) {
  const r = state.rule[ruleId];
  if (!r) throw new Error('That regular payment no longer exists.');
  return makeEvent(state, `Stopped ${r.name} after ${lastDate}`, [{ kind: 'rule', key: ruleId, value: { ...r, end: lastDate } }]);
}

export function saveAccount(state, account) {
  if (!String(account.name || '').trim()) throw new Error('Give the account a name.');
  const id = account.id || newId(account.type === 'card' ? 'card' : account.type === 'pot' ? 'pot' : 'acc');
  return makeEvent(state, `${state.account[id] ? 'Updated' : 'Added'} ${account.name}`, [{ kind: 'account', key: id, value: { tracked: true, ...account, id } }]);
}

// Record what the bank shows. A difference can be recorded as a dated correction.
export function checkBalance(state, accountId, bankValue, date, { correct = false, reason = '' } = {}) {
  const a = state.account[accountId];
  if (!a) throw new Error('Unknown account.');
  const appValue = balances(state, date)[accountId];
  const diff = bankValue - appValue;
  const changes = [{ kind: 'check', key: newId('chk'), value: { account: accountId, date, bank: bankValue, app: appValue, at: new Date().toISOString() } }];
  if (correct && diff !== 0) {
    const t = { id: newId('tx'), created: new Date().toISOString(), kind: 'adjust', amount: Math.abs(diff), date,
      from: diff < 0 ? accountId : null, to: diff > 0 ? accountId : null, desc: reason ? `Bank correction: ${reason}` : `Bank correction: ${a.name}`, note: 'Difference found when checking against the bank', reason, occ: null };
    changes.push({ kind: 'txn', key: t.id, value: t });
  }
  return { event: makeEvent(state, `Checked ${a.name} against bank`, changes), diff };
}

export function setSetting(state, key, value, label) {
  return makeEvent(state, label || `Changed setting ${key}`, [{ kind: 'setting', key, value: { value } }]);
}

export function saveScenario(state, scenario) {
  const id = scenario.id || newId('sc');
  return makeEvent(state, `Saved plan idea: ${scenario.name}`, [{ kind: 'scenario', key: id, value: { ...scenario, id } }]);
}

// Turn a scenario into real planned payments.
export function adoptScenario(state, scenario) {
  const changes = [];
  const everyday = (scenario.items || []).filter(it => it.type === 'everyday');
  if (everyday.length) {
    const list = [...(state.setting.everydayChanges?.value || [])];
    for (const it of everyday) list.push({ id: it.id, from: it.start, to: it.end || null, delta: -it.amount, name: it.name });
    changes.push({ kind: 'setting', key: 'everydayChanges', value: { value: list } });
  }
  for (const it of scenario.items || []) {
    if (it.type === 'everyday') continue;
    const id = newId('r');
    const sched = it.type === 'once' ? { type: 'once', date: it.date } : it.type === 'payday' ? { type: 'payday' } : { type: 'monthly', day: Number(it.day || 1) };
    changes.push({ kind: 'rule', key: id, value: { id, name: it.name, kind: it.to && it.from ? 'transfer' : it.to ? 'income' : 'bill', amount: it.amount,
      from: it.from || null, to: it.to || null, sched, start: it.type === 'once' ? it.date : it.start, end: it.end || null, versions: [], shift: it.type !== 'payday' } });
  }
  for (const ch of scenario.changes || []) {
    const r = state.rule[ch.ruleId];
    if (!r) continue;
    const value = ch.stop ? { ...r, end: addDays(ch.from, -1) } : { ...r, versions: (r.versions || []).concat([{ from: ch.from, set: { amount: ch.amount } }]) };
    changes.push({ kind: 'rule', key: r.id, value });
  }
  if (!changes.length) throw new Error('This plan idea has nothing to add.');
  return makeEvent(state, `Added plan idea to the plan: ${scenario.name}`, changes);
}
