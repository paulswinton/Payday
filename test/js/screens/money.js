// Money: accounts, pots and cards; every transaction with search; deleted items.
import { esc, money, icon, signed, chip } from '../ui.js';
import { longDate, shortDate } from '../calendar.js';
import { balances, displayBalance } from '../model.js';
import { accountsList, openCheckSheet, openTxnSheet, txnLine, txnAmount, txnTitle, txnKindIcon, openAddSheet, openAccountSettings } from './forms.js';
import { roleOf, ROLES } from '../roles.js';
import { forecastAll } from './plan.js';

function lastCheck(s, id) {
  return Object.values(s.check).filter(c => c.account === id).sort((a, b) => (b.at || b.date).localeCompare(a.at || a.date))[0] || null;
}
function checkTag(s, id, today) {
  const c = lastCheck(s, id);
  if (!c) return '<span class="tag warn">Not checked</span>';
  const days = Math.round((Date.parse(today) - Date.parse(c.date)) / 86400000);
  return days > 14 ? `<span class="tag warn">Checked ${days} days ago</span>` : `<span class="tag">Checked ${esc(shortDate(c.date))}</span>`;
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
  const next = proj.periods.find(p => p.start > today);
  const nextVal = next?.acc[id] ? displayBalance(a, next.acc[id].close) : null;
  const c = lastCheck(s, id);
  // How the balance is made up, so any figure can be traced.
  const real = txns.filter(t => t.kind !== 'adjust');
  const inSum = real.filter(t => t.to === id).reduce((x, t) => x + t.amount, 0);
  const outSum = real.filter(t => t.from === id).reduce((x, t) => x + t.amount, 0);
  const corr = txns.filter(t => t.kind === 'adjust').reduce((x, t) => x + (t.to === id ? t.amount : -t.amount), 0);
  const since = a.openingDate || s.setting.startDate?.value;
  ctx.afterRender = el => {
    el.querySelector('[data-check]')?.addEventListener('click', () => openCheckSheet(ctx, id));
    el.querySelector('[data-add]')?.addEventListener('click', () => openAddSheet(ctx, { from: id }));
    el.querySelector('[data-settings]')?.addEventListener('click', () => openAccountSettings(ctx, id));
    el.querySelectorAll('[data-txn]').forEach(b => b.onclick = () => openTxnSheet(ctx, b.dataset.txn));
  };
  return `<a class="back" href="#/money">${icon('back')} Money</a>
  <header class="topbar"><div><h1>${esc(a.name)}</h1><div class="sub">${esc(ROLES[roleOf(s, a)]?.label || '')}</div></div><button class="btn small" data-settings>Settings</button></header>
  <div class="card"><div class="muted small">${a.type === 'card' ? 'Owed now' : 'Balance now'}</div>
    <div class="amount" style="font-size:40px;font-weight:750">${a.tracked === false ? 'Not tracked' : money(bal)}</div>
    <p class="muted small">${c ? `Checked against your bank ${esc(longDate(c.date))}${c.app != null && c.bank !== c.app ? `: ${money(Math.abs(c.bank - c.app))} difference found` : ''}.` : chip('overdue', 'Not checked') + ' Never checked against your bank.'}
    ${nextVal != null ? `<br>Expected just before next payday: <strong>${money(nextVal)}</strong>.` : ''}</p>
    ${a.tracked === false ? '' : `<div class="btnrow"><button class="btn primary" data-check>Check bank</button><button class="btn" data-add>Record</button></div>`}
  </div>
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
