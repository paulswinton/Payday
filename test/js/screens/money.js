// Money: accounts, pots and cards; every transaction with search; deleted items.
import { esc, money, icon, signed, chip } from '../ui.js';
import { longDate, shortDate } from '../calendar.js';
import { balances, displayBalance } from '../model.js';
import { accountsList, openCheckSheet, openTxnSheet, txnLine, txnAmount, txnTitle, txnKindIcon, openAddSheet, openAccountSettings, confirmedBadge, confirmBalance, openOccurrenceSheet, openCardSheet, PRIORITIES } from './forms.js';
import { allOccurrences, planPeriods } from '../plan.js';
import { periodFor, addDays } from '../calendar.js';
import { markPaid } from '../commands.js';
import { toast } from '../ui.js';
import { roleOf, ROLES } from '../roles.js';
import { forecastAll } from './plan.js';

function lastCheck(s, id) {
  return Object.values(s.check).filter(c => c.account === id).sort((a, b) => (b.at || b.date).localeCompare(a.at || a.date))[0] || null;
}
function checkTag(s, id, today) {
  const c = lastCheck(s, id);
  if (!c) return '<span class="tag warn">Not updated</span>';
  const days = Math.round((Date.parse(today) - Date.parse(c.date)) / 86400000);
  return days > 14 ? `<span class="tag warn">Updated ${days} days ago</span>` : `<span class="tag">Updated ${esc(shortDate(c.date))}</span>`;
}

export function renderMoney(ctx) {
  const s = ctx.state, today = ctx.today();
  const bal = balances(s, today);
  const groups = [['Bank accounts', 'bank'], ['Savings pots', 'pot'], ['Credit cards', 'card']];
  const cash = accountsList(s, { types: ['bank', 'pot'] }).reduce((t, a) => t + (bal[a.id] ?? 0), 0);
  const debt = accountsList(s, { types: ['card'] }).reduce((t, a) => t + (-(bal[a.id] ?? 0)), 0);
  const unconfirmed = accountsList(s, { types: ['card'] }).filter(a => a.unconfirmed).length;
  return `
  <header class="topbar"><div><h1>Money</h1><div class="sub">Balances from what you have recorded</div></div>
    <a class="btn small" href="#/history">${icon('history')} History</a></header>
  <section class="grid2"><div class="stat"><span>In accounts and pots</span><strong class="amount">${money(cash)}</strong></div>
    <div class="stat"><span>Owed on cards</span><strong class="amount">${money(debt)}</strong>${unconfirmed ? `<span>${unconfirmed} not confirmed</span>` : ''}</div></section>
  ${groups.map(([title, type]) => {
    const list = accountsList(s, { types: [type] });
    if (!list.length) return '';
    return `<section><h2>${title}</h2><div class="list">${list.map(a => {
      const v = displayBalance(a, bal[a.id]);
      return `<a class="row" href="#/account/${encodeURIComponent(a.id)}"><div class="tile">${icon(type === 'card' ? 'card' : type === 'pot' ? 'pot' : 'bank')}</div>
        <div class="main"><div class="title">${esc(a.name)}</div><div class="meta">${a.tracked === false ? '<span class="tag">Not tracked</span>' : a.unconfirmed ? '<span class="tag warn">Balance not confirmed</span>' : checkTag(s, a.id, today)} ${esc(ROLES[roleOf(s, a)]?.label || '')}</div></div>
        <div class="amount ${v < 0 && type !== 'card' ? 'neg' : ''}">${a.tracked === false ? '—' : money(v)}${type === 'card' ? '<small>owed</small>' : ''}</div></a>`;
    }).join('')}</div></section>`;
  }).join('')}`;
}

export function renderAccount(ctx, id) {
  const s = ctx.state, a = s.account[id], today = ctx.today();
  if (!a) return '<p>Account not found.</p>';
  const raw = balances(s, today)[id];
  const bal = displayBalance(a, raw);
  const txns = Object.values(s.txn).filter(t => t.from === id || t.to === id).sort((x, y) => y.date.localeCompare(x.date) || (y.created || '').localeCompare(x.created || ''));
  const proj = forecastAll(ctx);
  // The period we are in now: its close is the balance the day before next payday.
  const cur = proj.periods.find(p => p.start <= today && today <= p.end);
  const nextVal = cur?.acc[id] ? displayBalance(a, cur.acc[id].close) : null;
  const c = lastCheck(s, id);
  // How the balance is made up, so any figure can be traced.
  const real = txns.filter(t => t.kind !== 'adjust');
  const inSum = real.filter(t => t.to === id).reduce((x, t) => x + t.amount, 0);
  const outSum = real.filter(t => t.from === id).reduce((x, t) => x + t.amount, 0);
  const corr = txns.filter(t => t.kind === 'adjust').reduce((x, t) => x + (t.to === id ? t.amount : -t.amount), 0);
  const since = a.openingDate || s.setting.startDate?.value;
  // What is reserved in this account: payments still to leave it before next payday.
  const per = periodFor(today, planPeriods(s));
  const reserved = per ? allOccurrences(s, s.setting.startDate?.value || per.start, per.end, today)
    .filter(o => (o.from === id || o.to === id) && ['overdue', 'planned', 'part'].includes(o.status)) : [];
  const resOut = reserved.filter(o => o.from === id).reduce((t, o) => t + (o.remaining || o.amount), 0);
  const need = a.target != null && a.tracked !== false ? Math.max(0, a.target - bal) : null;
  const isCard = a.type === 'card';
  // Goal: what is still needed and, with a deadline, how much per payday gets there.
  const paydaysLeft = a.deadline ? planPeriods(s).filter(p => p.start > today && p.start <= a.deadline).length : null;
  const perPayday = need && paydaysLeft ? Math.ceil(need / paydaysLeft) : null;
  ctx.afterRender = el => {
    el.querySelector('[data-check]')?.addEventListener('click', () => openCheckSheet(ctx, id));
    el.querySelector('[data-confirm]')?.addEventListener('click', () => confirmBalance(ctx, id));
    el.querySelector('[data-move]')?.addEventListener('click', () => openAddSheet(ctx, { kind: 'transfer', from: id }));
    el.querySelector('[data-add]')?.addEventListener('click', () => (isCard ? openCardSheet(ctx, id, 'spend') : openAddSheet(ctx, { kind: 'spend', from: id })));
    el.querySelector('[data-repay]')?.addEventListener('click', () => openCardSheet(ctx, id, 'repayment'));
    el.querySelector('[data-cardother]')?.addEventListener('click', () => openCardSheet(ctx, id, 'interest'));
    el.querySelector('[data-track]')?.addEventListener('click', () => openAccountSettings(ctx, id));
    el.querySelectorAll('[data-occ]').forEach(b => b.onclick = () => openOccurrenceSheet(ctx, b.dataset.occ));
    el.querySelectorAll('[data-paid]').forEach(b => b.onclick = async e => {
      e.stopPropagation();
      const o = reserved.find(x => x.key === b.dataset.paid);
      try { await ctx.dispatch(markPaid(ctx.state, o.key, { date: o.date <= today ? o.date : today, amount: o.remaining || o.amount }, today), { message: `${o.name}: ${money(o.remaining || o.amount)} recorded` }); } catch (err) { toast(err.message, { warn: true }); }
    });
    el.querySelector('[data-settings]')?.addEventListener('click', () => openAccountSettings(ctx, id));
    el.querySelectorAll('[data-txn]').forEach(b => b.onclick = () => openTxnSheet(ctx, b.dataset.txn));
  };
  return `<a class="back" href="#/money">${icon('back')} Money</a>
  <header class="topbar"><div><h1>${esc(a.name)}</h1><div class="sub">${esc(ROLES[roleOf(s, a)]?.label || '')}</div></div><button class="btn small" data-settings>Settings</button></header>
  <div class="feature"><div class="feature-head"><span class="muted small">${a.type === 'card' ? 'Owed now' : 'Balance now'}</span>${a.tracked === false ? '' : confirmedBadge(s, id, today)}</div>
    <div class="feature-big amount">${a.tracked === false ? 'Not tracked' : money(bal)}</div>
    <div class="muted small">Recorded balance · not a forecast${nextVal != null && nextVal !== bal ? `. Expected the day before next payday: <strong>${money(nextVal)}</strong>` : ''}</div>
    ${need != null ? `<p class="small" style="margin-top:8px">${need ? `<strong>${money(need)}</strong> still needed to reach ${money(a.target)}${a.deadline ? ` by ${esc(longDate(a.deadline))}` : ''}.${perPayday ? ` That is <strong>${money(perPayday)}</strong> on each of the ${paydaysLeft} payday${paydaysLeft === 1 ? '' : 's'} left.` : a.deadline && !paydaysLeft ? ' No payday left before then.' : ''}` : `Target of ${money(a.target)} reached.`}${a.priority ? ` Priority: ${PRIORITIES[a.priority]}.` : ''}</p>` : ''}
    ${a.notes ? `<p class="muted small">${esc(a.notes)}</p>` : ''}
    ${isCard && (a.apr != null || a.minimum != null || a.dueDay) ? `<p class="muted small">${[a.apr != null ? `APR ${a.apr}%` : '', a.minimum != null ? `minimum ${money(a.minimum)}` : '', a.dueDay ? `due on the ${a.dueDay}${['th', 'st', 'nd', 'rd'][(a.dueDay % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][a.dueDay % 100] || 'th'}` : ''].filter(Boolean).join(' · ')}</p>` : ''}
    ${a.tracked === false ? (isCard ? `<p class="small">Payday doesn’t know what you owe on this card yet, so repayments can’t reduce the debt.</p><div class="btnrow"><button class="btn primary" data-track>Enter what I owe</button></div>` : '')
      : isCard ? `<div class="btngrid"><button class="btn" data-confirm>✓ Confirm</button><button class="btn" data-check>Correct</button>
      <button class="btn primary" data-repay>Repayment</button><button class="btn" data-add>Card spend</button></div>
      <button class="linkrow" data-cardother style="border:0;background:none;padding:0">Interest, fee or refund ›</button>`
      : `<div class="btngrid"><button class="btn" data-confirm>✓ Confirm</button><button class="btn" data-check>Correct</button>
      <button class="btn" data-move>Move money</button><button class="btn" data-add>Record spend</button></div>
      <p class="muted small" style="margin-top:8px">Confirm when the bank shows the same figure. Correct when it doesn’t.</p>`}
  </div>
  ${reserved.length ? `<section><h2>${isCard ? 'Repayments due before payday' : 'Reserved before payday'} ${resOut ? `<span class="muted small">${money(resOut)}</span>` : ''}</h2><div class="list">${reserved.map(o => `<div class="row static"><div class="main" data-occ="${esc(o.key)}" role="button" tabindex="0" style="cursor:pointer"><div class="title">${esc(o.name)}</div>
      <div class="meta">${o.status === 'overdue' ? chip('overdue') + ' ' : ''}${esc(shortDate(o.date))}${o.variable ? ' · varies' : ''}</div></div>${isCard ? `<span class="amount">${money(o.remaining || o.amount)}</span>` : signed(o.remaining || o.amount, o.to === id ? 'in' : 'out')}
      <button class="donebtn" data-paid="${esc(o.key)}">${o.kind === 'income' ? 'Arrived' : o.to === id && !isCard ? 'In' : 'Paid'}</button></div>`).join('')}</div>
      <p class="muted small">Paid records it from this account and updates every account it touches.</p></section>` : ''}
  ${a.tracked === false ? '' : `<details class="card fold" style="margin-top:10px"><summary>How this balance is made</summary><div class="lines">
    <div class="line"><span>Starting balance${since ? `<small>${esc(longDate(since))}</small>` : ''}</span><strong class="amount">${money(displayBalance(a, a.opening))}</strong></div>
    <div class="line"><span>Money in<small>${real.filter(t => t.to === id).length} entries</small></span>${signed(inSum, 'in')}</div>
    <div class="line"><span>Money out<small>${real.filter(t => t.from === id).length} entries</small></span>${signed(outSum, 'out')}</div>
    ${corr ? `<div class="line"><span>Bank corrections<small>${txns.filter(t => t.kind === 'adjust').length} entries</small></span>${signed(corr, corr > 0 ? 'in' : 'out')}</div>` : ''}
    <div class="line total"><span>Balance now</span><strong class="amount">${money(bal)}</strong></div></div>
    <p class="muted small">If the starting balance or a big entry looks wrong, tap the entry below to change or delete it.</p></details>`}
  <section><h2>Transactions <span class="tag">${txns.length}</span></h2>${txns.length ? `<div class="list">${txns.slice(0, 200).map(t => txnRow(s, t, false, id)).join('')}</div>` : '<div class="card muted">No transactions yet.</div>'}</section>`;
}

export function txnRow(s, t, deleted = false, accountId = null) {
  const title = txnTitle(s, t, accountId);
  const sub = accountId ? (title !== t.desc && t.kind !== 'adjust' ? '' : txnLine(s, t) === s.account[accountId]?.name ? '' : txnLine(s, t)) : txnLine(s, t);
  return `<button class="row" data-txn="${esc(t.id)}"${deleted ? ' data-deleted="1"' : ''}><div class="tile">${icon(txnKindIcon(t))}</div>
    <div class="main"><div class="title">${esc(title)}</div><div class="meta">${deleted ? '<span class="tag bad">Deleted</span> ' : ''}${esc(shortDate(t.date))}${sub ? ' · ' + esc(sub) : ''}${t.kind === 'adjust' && t.reason ? ' · ' + esc(t.reason) : ''}</div></div>
    ${txnAmount(s, t, accountId)}</button>`;
}

let filter = { text: '', kind: 'all' };
export function renderHistory(ctx) {
  const s = ctx.state;
  const deleted = [];
  if (filter.kind === 'deleted') {
    const seen = new Set();
    for (const ev of [...s.events].reverse()) for (const o of ev.ops) {
      if (o.kind === 'txn' && o.op === 'remove' && !s.txn[o.key] && !seen.has(o.key)) { seen.add(o.key); deleted.push(o.prev); }
    }
  }
  const all = filter.kind === 'deleted' ? deleted : Object.values(s.txn).filter(t =>
    filter.kind === 'all' || (filter.kind === 'spend' ? ['spend', 'bill'].includes(t.kind) : t.kind === filter.kind));
  const q = filter.text.trim().toLowerCase();
  const list = all.filter(t => !q || t.desc.toLowerCase().includes(q) || (t.note || '').toLowerCase().includes(q) || String(t.amount / 100).includes(q))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.created || '').localeCompare(a.created || ''));
  const byDate = {};
  for (const t of list.slice(0, 300)) (byDate[t.date] ??= []).push(t);
  const kinds = [['all', 'All'], ['spend', 'Spending'], ['transfer', 'Moves'], ['income', 'Money in'], ['adjust', 'Corrections'], ['deleted', 'Deleted']];
  ctx.afterRender = el => {
    const input = el.querySelector('input[type=search]');
    input.oninput = () => { filter.text = input.value; ctx.renderSameRoute(); const i = document.querySelector('input[type=search]'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); };
    el.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { filter.kind = b.dataset.filter; ctx.renderSameRoute(); });
    el.querySelectorAll('[data-txn]').forEach(b => b.onclick = () => {
      const t = b.dataset.deleted ? deleted.find(x => x.id === b.dataset.txn) : null;
      openTxnSheet(ctx, b.dataset.txn, { deletedVersion: t });
    });
  };
  return `<a class="back" href="#/money">${icon('back')} Money</a>
  <header class="topbar"><div><h1>History</h1><div class="sub">Tap any entry to change it, delete it or go back to an earlier version</div></div></header>
  <label class="field"><span class="sr-only">Search</span><input type="search" placeholder="Search description, note or amount" value="${esc(filter.text)}"></label>
  <div class="seg" role="group" aria-label="Show" style="margin-top:10px">${kinds.map(([k, l]) => `<button type="button" data-filter="${k}" aria-pressed="${filter.kind === k}">${l}</button>`).join('')}</div>
  <section>${Object.keys(byDate).length ? Object.entries(byDate).map(([d, ts]) => `<h3 class="muted" style="margin:16px 4px 6px">${esc(longDate(d))}</h3><div class="list">${ts.map(t => txnRow(s, t, filter.kind === 'deleted')).join('')}</div>`).join('') : '<div class="empty">Nothing to show.</div>'}
  ${list.length > 300 ? '<p class="muted small">Showing the latest 300. Search to find older entries.</p>' : ''}</section>`;
}
