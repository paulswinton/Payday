// What each account is for, and what each regular payment is. These decide how
// money is planned on payday. Every default can be changed in the app; nothing
// here is a fixed budget.
import { setting } from './model.js';

export const ROLES = {
  main: { label: 'Main account', help: 'Salary arrives here and most payments leave from here.' },
  bills: { label: 'Bills account', help: 'Holds money for direct debits. Payday works out what to move in each payday.' },
  allowance: { label: 'Spending allowance', help: 'Money for day-to-day spending. Counts as spent only when you spend it.' },
  holding: { label: 'Set aside for a known payment', help: 'Money waiting for a payment, such as accommodation. Not spare money.' },
  savings: { label: 'Savings', help: 'Money you have chosen to save.' },
  card: { label: 'Credit card', help: 'Money owed.' },
  other: { label: 'Other', help: '' },
};

export const CATEGORIES = {
  must: { label: 'Must pay', help: 'Bills and commitments you cannot skip.' },
  allowance: { label: 'Spending allowance', help: 'Moved to spend later. Not spent until you spend it.' },
  saving: { label: 'Committed savings', help: 'Savings you have chosen. Can be changed if you decide to.' },
  income: { label: 'Money in', help: '' },
};

const mainId = state => setting(state, 'mainAccount', 'acc-current');

export function roleOf(state, account) {
  if (!account) return 'other';
  if (account.role) return account.role;
  if (account.id === mainId(state)) return 'main';
  if (account.type === 'card') return 'card';
  const n = (account.name || '').toLowerCase();
  if (/\bexp\b|expenses|bills|direct debit/.test(n)) return 'bills';
  if (/pocket|allowance|spending/.test(n)) return 'allowance';
  if (/accommodation|universit|\buni\b|card payments|set aside/.test(n)) return 'holding';
  if (account.type === 'pot') return 'savings';
  return 'other';
}

export const accountsWithRole = (state, role) =>
  Object.values(state.account).filter(a => !a.archived && a.tracked !== false && roleOf(state, a) === role);

// Bills accounts are topped up to what they need each payday unless turned off.
export const fundsToNeed = (state, a) => roleOf(state, a) === 'bills' && a.fundToNeed !== false && a.tracked !== false && !a.archived;

export function categoryOf(state, rule) {
  if (rule.category) return rule.category;
  if (rule.kind === 'income') return 'income';
  if (rule.kind === 'transfer') {
    const to = state.account[rule.to];
    const role = roleOf(state, to);
    if (role === 'allowance') return 'allowance';
    if (role === 'savings') return 'saving';
    return 'must';
  }
  return 'must';
}

// The lowest a tracked account may go before Payday warns you.
export function floorOf(state, a) {
  if (!a) return 0;
  if (a.id === mainId(state)) return setting(state, 'cushion', 0);
  return a.floor ?? 0;
}
