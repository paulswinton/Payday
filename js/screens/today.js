// Today: what is in the current account, what is due this week, what is free to spend, and what needs you.
import { esc, money, icon, sheet, relTime, signed, chip, toast } from '../ui.js';
import { longDate, shortDate, addDays, daysBetween } from '../calendar.js';
import { safeToSpend } from '../forecast.js';
import { setSetting } from '../commands.js';
import { roleOf, ROLES } from '../roles.js';
import { accountsList } from './forms.js';
import { displayBalance } from '../model.js';
import { allOccurrences } from '../plan.js';
import { canUndo, selfCheck, balances } from '../model.js';
import { openOccurrenceSheet, field, errorBox, showError, confirmedBadge, confirmBalance, openCheckSheet, lastCheckOf } from './forms.js';
import { parsePounds, penceToInput } from '../money.js';
import { markPaid, setOccurrence } from '../commands.js';
import { payRun } from '../payrun.js';
import { currentRunKey } from './payday.js';

export function renderToday(ctx) {
  const s = ctx.state, today = ctx.today();
  const start = s.setting.startDate?.value || today;
  const main = s.setting.mainAccount?.value || 'acc-current';
  const acc = s.account[main];
  const safe = safeToSpend(s, today);
  const week = weekAhead(ctx);
  const tiles = homeTiles(ctx, safe);

  const occ = allOccurrences(s, start, addDays(today, 7), today);
  const overdue = occ.filter(o => o.status === 'overdue');
  const problems = selfCheck(s);
  // Everything that needs you, in one list: overdue payments, then warnings, then things to check.
  const needs = [];
  // Overdue current-account payments already show in the summary above.
  for (const o of overdue.filter(x => x.from !== main)) needs.push({ html: `<div class="nrow"><div class="main" data-occ="${esc(o.key)}" role="button" tabindex="0"><div class="title">${esc(o.name)}</div><div class="meta">${chip('overdue')} was due ${esc(shortDate(o.date))} · ${esc(s.account[o.from]?.name || s.account[o.to]?.name || '')}</div></div>${signed(o.remaining || o.amount, occDir(s, o))}<button class="donebtn" data-paid="${esc(o.key)}">${o.kind === 'income' ? 'Arrived' : 'Gone'}</button></div>` });
  if (problems.length) needs.push(linkRow('Payday found a problem in its records', problems[0], '#/settings', true));
  if (!ctx.meta.backupCfg && !window.PAYDAY_TEST) needs.push(linkRow('Set up automatic backup', 'Your records are only on this phone.', '#/settings', true));
  else if (['error', 'conflict', 'locked'].includes(ctx.backup.status)) needs.push(linkRow('Backup needs attention', ctx.backup.message, '#/settings', true));
  for (const t of safe?.topups || []) needs.push(linkRow(`${t.name} will be ${money(t.amount)} short`, `On ${shortDate(t.date)}. Move money in before then.`, `#/account/${encodeURIComponent(t.account)}`, true));
  for (const c of toCheck(ctx, today)) needs.push(c.href ? linkRow(c.title, c.text, c.href) : { html: `<button class="nrow" data-occ="${esc(c.occ)}"><div class="main"><div class="title">${esc(c.title)}</div><div class="meta">${esc(c.text)}</div></div><span class="chev">›</span></button>` });

  const runKey = currentRunKey(s, today);
  const run = runKey ? payRun(s, runKey, today) : null;
  const payCard = run && (!run.complete || run.period.start === today) ? `<a class="paystrip" href="#/payday/${run.period.key}">
    <div><div class="eyebrow">${run.ready ? 'Payday today' : `Payday ${daysBetween(today, run.period.start) === 1 ? 'tomorrow' : `in ${daysBetween(today, run.period.start)} days`}`}</div>
    <div class="title">${run.complete ? 'Everything is done' : run.ready ? `${run.total - run.todo} of ${run.total} done` : 'See what to move where'}</div></div>
    <div class="ring" style="--p:${run.total ? Math.round(((run.total - run.todo) / run.total) * 100) : 100}"></div></a>` : '';

  ctx.afterRender = el => {
    el.querySelector('[data-choose]')?.addEventListener('click', () => chooseTiles(ctx));
    el.querySelector('[data-confirm-main]')?.addEventListener('click', () => confirmBalance(ctx, main));
    el.querySelector('[data-correct-main]')?.addEventListener('click', () => openCheckSheet(ctx, main));
    el.querySelector('[data-cushion]')?.addEventListener('click', () => cushionSheet(ctx));
    el.querySelectorAll('[data-paid]').forEach(b => b.onclick = async e => {
      e.stopPropagation();
      const o = [...overdue, ...week.items].find(x => x.key === b.dataset.paid);
      try { await ctx.dispatch(markPaid(ctx.state, o.key, { date: o.date <= today ? o.date : today, amount: o.remaining || o.amount }, today), { message: `${o.name}: ${money(o.remaining || o.amount)} recorded` }); } catch (err) { toast(err.message, { warn: true }); }
    });
    el.querySelectorAll('[data-occ]').forEach(b => b.onclick = () => openOccurrenceSheet(ctx, b.dataset.occ));
  };

  if (!acc) return '<div class="empty">No main account set.</div>';
  const bal = balances(s, today)[main];
  const avail = bal - week.total - (s.setting.cushion?.value || 0);
  const next = week.items[0];
  const firstGap = (() => { let left = bal; for (const o of week.items) { left -= (o.remaining || o.amount); if (left < 0) return o; } return null; })();
  const shown = needs.slice(0, 4), more = needs.slice(4);

  return `
  <header class="topbar"><div><div class="eyebrow">Today</div><h1>${esc(dayTitle(today))}</h1></div>
    <a class="iconbtn" href="#/settings" aria-label="Settings">${icon('gear')}</a></header>

  <section class="summary">
    <div class="sum-top"><a class="sum-acc" href="#/account/${encodeURIComponent(main)}">${esc(acc.name)} <span class="chev">›</span></a>${confirmedBadge(s, main, today)}</div>
    <div class="sum-bal amount">${money(bal)}</div>
    <div class="sum-note">In your account now</div>
    ${next ? `<button class="sum-next" data-occ="${esc(next.key)}"><span><span class="eyebrow">Next payment</span><span class="nm">${esc(next.name)} · ${esc(shortDate(next.date))}${next.status === 'overdue' ? ' ' + chip('overdue') : ''}</span></span>${signed(next.remaining || next.amount, 'out')}</button>` : ''}
    <div class="sum-actions"><button class="pill" data-confirm-main>${icon('check')} Matches bank</button><button class="pill" data-correct-main>${icon('adjust')} Correct</button></div>

    <div class="sum-split"></div>
    <div class="eyebrow">Available to spend</div>
    <div class="sum-avail amount ${avail < 0 ? 'neg' : ''}">${avail < 0 ? '−' : ''}${money(Math.abs(avail))}</div>
    <div class="sum-note">Balance less ${week.items.length ? `${money(week.total)} due in the next 7 days` : 'nothing due in the next 7 days'} and your ${money(s.setting.cushion?.value || 0)} cushion <button class="chipbtn" data-cushion>Edit</button></div>
    ${firstGap ? `<div class="sum-warn">${icon('bank')}<span>Not enough for <strong>${esc(firstGap.name)}</strong> on ${esc(shortDate(firstGap.date))}. Move at least ${money(-(bal - week.items.slice(0, week.items.indexOf(firstGap) + 1).reduce((t, o) => t + (o.remaining || o.amount), 0)))} into ${esc(acc.name)}.</span></div>` : ''}
    ${week.items.length ? `<details class="sum-list" ${week.items.some(o => o.status === 'overdue') ? 'open' : ''}><summary><span>Due in the next 7 days (${week.items.length})</span>${signed(week.total, 'out')}</summary>${week.items.map(o => `<div class="srow"><button class="main" data-occ="${esc(o.key)}"><span class="nm">${esc(o.name)}</span><span class="dt">${o.status === 'overdue' ? 'Overdue' : esc(shortDate(o.date))}${o.variable ? ' · varies' : ''}</span></button>${signed(o.remaining || o.amount, 'out')}<button class="donebtn sm" data-paid="${esc(o.key)}">Paid</button></div>`).join('')}</details>` : ''}
    ${week.later ? `<div class="sum-note" style="margin-top:10px">A further ${money(week.later)} is due from ${esc(acc.name)} before payday on ${esc(shortDate(safe.nextPayday))}.</div>` : ''}
  </section>

  ${payCard}

  <section><div class="sec-head"><span class="eyebrow">Your accounts</span><button class="linkbtn" data-choose>Customise</button></div>${tiles}</section>

  ${needs.length ? `<section><div class="sec-head"><span class="eyebrow">Needs you · ${needs.length}</span></div>
    <div class="list">${shown.map(n => n.html).join('')}</div>
    ${more.length ? `<details class="fold"><summary style="font-size:15px">${more.length} more</summary><div class="list">${more.map(n => n.html).join('')}</div></details>` : ''}</section>` : ''}

  <a href="#/history" class="linkrow">All transactions and changes ›</a>`;
}

// Payments still to leave the main account in the next 7 days (overdue ones included).
function weekAhead(ctx) {
  const s = ctx.state, today = ctx.today();
  const main = s.setting.mainAccount?.value || 'acc-current';
  const start = s.setting.startDate?.value || today;
  const live = o => o.from === main && o.kind !== 'income' && ['overdue', 'planned', 'part'].includes(o.status);
  const items = allOccurrences(s, start, addDays(today, 7), today).filter(o => live(o) && !o.undated).sort((a, b) => a.date.localeCompare(b.date));
  const total = items.reduce((t, o) => t + (o.remaining || o.amount), 0);
  const safe = safeToSpend(s, today);
  const later = safe ? allOccurrences(s, addDays(today, 8), addDays(safe.nextPayday, -1), today).filter(live).reduce((t, o) => t + (o.remaining || o.amount), 0) : 0;
  return { items, total, later };
}
function dayTitle(d) {
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}
function linkRow(title, text, href, warn = false) {
  return { html: `<a class="nrow" href="${href}"><div class="main"><div class="title">${warn ? '<span class="dotw"></span>' : ''}${esc(title)}</div><div class="meta">${esc(text)}</div></div><span class="chev">›</span></a>` };
}

// Spare = what is in the current account now, less everything still due before
// payday, plus anything still to arrive, less top-ups and the cushion. Shown even
// when negative, so every payment you record moves it.
export function spareParts(safe) {
  const out = safe.outgoing.reduce((t, f) => t + f.amount, 0);
  const inc = safe.incoming.reduce((t, f) => t + f.amount, 0);
  const close = safe.balance - out + inc;
  const timing = Math.max(0, close - safe.lowest);
  const spare = close - timing - safe.topupTotal - safe.cushion;
  return { now: safe.balance, out, in: inc, topups: safe.topupTotal, timing, cushion: safe.cushion, spare };
}

// The main account, as recorded, beside what is free to spend before payday.
function featuredCards(ctx, safe, sp) {
  const s = ctx.state, today = ctx.today();
  const main = s.setting.mainAccount?.value || 'acc-current';
  const a = s.account[main];
  if (!a) return '';
  const now = balances(s, today)[main];
  const next = safe ? [...safe.outgoing].sort((x, y) => x.date.localeCompare(y.date))[0] : null;
  const days = safe ? daysBetween(today, safe.nextPayday) : null;
  const unalloc = sp ? sp.spare + sp.cushion : null;
  return `<div class="feature">
    <div class="feature-head"><a href="#/account/${encodeURIComponent(main)}" class="feature-name">${esc(a.name)} ›</a>${confirmedBadge(s, main, today)}</div>
    <div class="feature-big amount">${money(now)}</div>
    <div class="muted small">Recorded balance · not a forecast</div>
    ${next ? `<div class="feature-next"><div><div class="eyebrow">Next reserved payment</div><div class="small"><strong>${esc(next.label)}</strong> · ${next.overdue && next.occ ? `was due ${esc(shortDate(s.occ[next.occ]?.date || next.occ.split('|')[1]))} ${chip('overdue')}` : esc(shortDate(next.date))}</div></div>${signed(next.amount, 'out')}</div>` : ''}
    <div class="btnrow"><button class="btn" data-confirm-main>✓ Confirm</button><button class="btn" data-correct-main>Correct</button></div>
  </div>
  ${sp ? `<div class="feature">
    <div class="eyebrow">${esc(a.name)} · today’s position</div>
    <div class="small" style="font-weight:650;margin-top:6px">${sp.spare < 0 ? 'Short before payday' : 'Available to spend'}</div>
    <div class="feature-big amount ${sp.spare < 0 ? 'out' : 'avail'}">${sp.spare < 0 ? '−' : ''}${money(Math.abs(sp.spare))}</div>
    <div class="muted small">After your scheduled payments and safety cushion, until payday on ${esc(longDate(safe.nextPayday))} (${days} day${days === 1 ? '' : 's'}).</div>
    ${sp.spare < 0 ? (() => { const fs = firstShort(safe); return `<div class="banner bad" style="margin-top:10px"><span class="dot">!</span><div><strong>${fs ? `Not enough for ${esc(fs.name)} on ${esc(shortDate(fs.date))}` : 'Below your safety cushion'}</strong><p class="small muted">Move ${money(-sp.spare)} into ${esc(a.name)} to cover everything before payday${fs ? '' : ' and keep your cushion'}.</p></div></div>`; })() : ''}
    <div class="lines" style="margin-top:8px">
      <button class="line linebtn" data-explain><span><strong>Reserved for ${safe.outgoing.length} payment${safe.outgoing.length === 1 ? '' : 's'}</strong> <span class="muted small">not yet paid ›</span></span>${signed(sp.out, 'out')}</button>
      ${sp.in ? `<div class="line"><span>Still to come in</span>${signed(sp.in, 'in')}</div>` : ''}
      ${sp.topups ? `<div class="line"><span>Top-ups other accounts need</span>${signed(sp.topups, 'out')}</div>` : ''}
      ${sp.timing ? `<div class="line"><span>Money arrives after it’s needed</span>${signed(sp.timing, 'out')}</div>` : ''}
      <div class="line"><span>Unallocated before cushion</span><strong class="amount ${unalloc < 0 ? 'out' : 'in'}">${unalloc < 0 ? '−' : ''}${money(Math.abs(unalloc))}</strong></div>
      <div class="line"><span>Safety cushion <button class="chipbtn" data-cushion>Edit</button></span><strong class="amount">${money(sp.cushion)}</strong></div>
    </div></div>` : ''}`;
}

// Things whose figures are not yet certain: the V18 "review" list, worked out live.
function toCheck(ctx, today) {
  const s = ctx.state, out = [];
  const bal = balances(s, today);
  for (const a of Object.values(s.account)) {
    if (a.archived) continue;
    if (a.type === 'card' && a.tracked === false && Object.values(s.rule).some(r => !r.deleted && r.to === a.id)) {
      out.push({ title: `What do you owe on ${a.name}?`, text: 'Enter it from your statement so repayments reduce the debt.', href: `#/account/${encodeURIComponent(a.id)}` });
      continue;
    }
    if (a.tracked === false) continue;
    const c = lastCheckOf(s, a.id);
    const days = c ? Math.round((Date.parse(today) - Date.parse(c.date)) / 86400000) : null;
    if (!c || days > 14) out.push({ title: `Confirm ${a.name}`, text: c ? `Last confirmed ${days} days ago (${money(displayBalance(a, bal[a.id]))} recorded).` : `Never confirmed against your bank (${money(displayBalance(a, bal[a.id]))} recorded).`, href: `#/account/${encodeURIComponent(a.id)}` });
  }
  for (const o of allOccurrences(s, s.setting.startDate?.value || today, addDays(today, 14), today)) {
    if (!['planned', 'overdue'].includes(o.status)) continue;
    if (o.variable && !s.occ[o.key]?.amount) out.push({ title: `${o.name}: check the amount`, text: `Varies. ${money(o.amount)} assumed for ${shortDate(o.date)}; enter the statement figure.`, occ: o.key });
    else if (o.undated) out.push({ title: `${o.name}: which day?`, text: 'The collection day isn’t known, so it is held back from payday.', occ: o.key });
  }
  return out;
}

// The first payment the current account can no longer cover, if it is short.
export function firstShort(safe) {
  let left = safe.balance;
  const ev = [...safe.outgoing.map(f => ({ ...f, d: -f.amount })), ...safe.incoming.map(f => ({ ...f, d: f.amount }))].sort((a, b) => a.date.localeCompare(b.date) || a.d - b.d);
  for (const f of ev) { left += f.d; if (left < 0 && f.d < 0) return { name: f.label, date: f.date, short: -left }; }
  return null;
}

function cushionSheet(ctx) {
  const cur = ctx.state.setting.cushion?.value || 0;
  sheet('Safety cushion', `<form novalidate><p class="muted small">Money you always keep in your current account and never count as available.</p>
    ${field('Cushion (£)', `<input class="big" name="amount" inputmode="decimal" value="${esc(penceToInput(cur))}">`)}${errorBox()}
    <div class="btnrow"><button class="btn primary block" type="submit">Save</button></div></form>`, el => {
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      const v = parsePounds(e.target.amount.value);
      if (v === null || v < 0) { showError(el, new Error('Enter an amount like 20.00')); return; }
      await ctx.dispatch(setSetting(ctx.state, 'cushion', v, `Safety cushion set to ${money(v)}`));
    };
  });
}

function defaultTiles(s) {
  const main = s.setting.mainAccount?.value || 'acc-current';
  const list = accountsList(s, { types: ['bank', 'pot'] }).filter(a => a.tracked !== false && a.id !== main);
  const order = ['bills', 'allowance', 'savings', 'holding', 'other'];
  return [...list].sort((a, b) => order.indexOf(roleOf(s, a)) - order.indexOf(roleOf(s, b))).slice(0, 4).map(a => a.id);
}
export function tileIds(s) {
  const main = s.setting.mainAccount?.value || 'acc-current';
  const chosen = (s.setting.homeAccounts?.value || []).filter(id => s.account[id] && !s.account[id].archived && id !== main);
  return chosen.length ? chosen : defaultTiles(s);
}
function homeTiles(ctx, safe) {
  const s = ctx.state, today = ctx.today();
  const bal = balances(s, today);
  const lows = {};
  for (const t of safe?.topups || []) lows[t.account] = t;
  return `<div class="tiles">${tileIds(s).map(id => {
    const a = s.account[id], v = a.tracked === false ? null : displayBalance(a, bal[id]);
    const c = lastCheckOf(s, id);
    const need = a.target != null && v != null ? Math.max(0, a.target - v) : null;
    const note = lows[id] ? `${money(lows[id].amount)} short ${shortDate(lows[id].date)}` : a.type === 'card' ? 'owed' : need ? `${money(need)} to target` : '';
    const fresh = c && Math.round((Date.parse(today) - Date.parse(c.date)) / 86400000) <= 14;
    return `<a class="tile-acc ${lows[id] ? 'warn' : ''}" href="#/account/${encodeURIComponent(id)}">
      <span class="nm">${esc(a.name)}</span><strong class="amount">${v == null ? '—' : money(v)}</strong>
      <span class="nt">${note ? esc(note) + ' · ' : ''}<span class="${fresh ? 'okc' : 'oldc'}">${c ? `${fresh ? '✓ ' : ''}${esc(shortDate(c.date))}` : 'not confirmed'}</span></span></a>`;
  }).join('')}</div>`;
}
function chooseTiles(ctx) {
  const s = ctx.state;
  const picked = new Set(tileIds(s));
  const main = s.setting.mainAccount?.value || 'acc-current';
  const list = accountsList(s, { types: ['bank', 'pot', 'card'] }).filter(a => a.tracked !== false && a.id !== main);
  sheet('Your other accounts', `<p class="muted small">Choose up to four to show on Today. Tap one there to go straight to it.</p>
    ${list.map(a => `<div class="toggle"><span>${esc(a.name)}</span><button type="button" data-pick="${esc(a.id)}" aria-pressed="${picked.has(a.id)}">${picked.has(a.id) ? 'Shown' : 'Show'}</button></div>`).join('')}
    <div class="error" role="alert" hidden></div><div class="btnrow"><button class="btn primary block" data-save>Save</button></div>`, el => {
    el.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => {
      const id = b.dataset.pick;
      if (picked.has(id)) picked.delete(id);
      else if (picked.size >= 4) { const e = el.querySelector('.error'); e.textContent = 'Four is the most. Remove one first.'; e.hidden = false; return; }
      else picked.add(id);
      b.setAttribute('aria-pressed', String(picked.has(id))); b.textContent = picked.has(id) ? 'Shown' : 'Show';
    });
    el.querySelector('[data-save]').onclick = async () => {
      const ids = list.map(a => a.id).filter(id => picked.has(id));
      await ctx.dispatch(setSetting(ctx.state, 'homeAccounts', ids, 'Changed accounts on Today'), { message: 'Today updated' });
    };
  });
}

function banner(kind, title, text, href, action) {
  return `<div class="banner ${kind}"><span class="dot" aria-hidden="true">!</span><div class="main"><strong>${esc(title)}</strong><p class="small muted">${esc(text)}</p>
    ${href ? `<a class="btn small" href="${href}">${esc(action)}</a>` : ''}</div></div>`;
}

export function occDir(s, o) {
  if (o.kind === 'income') return 'in';
  // Paying a card is cash leaving, even though it lands on an account you track.
  const own = id => id && s.account[id] && s.account[id].tracked !== false && s.account[id].type !== 'card';
  return o.kind === 'transfer' && own(o.from) && own(o.to) ? 'move' : 'out';
}
export function occRow(ctx, o) {
  const s = ctx.state;
  const dir = occDir(s, o);
  const acct = dir === 'move' ? `${s.account[o.from]?.name} → ${s.account[o.to]?.name}` : dir === 'in' ? `into ${s.account[o.to]?.name || ''}` : `from ${s.account[o.from]?.name || ''}`;
  const soon = o.status === 'planned' && o.date <= addDays(ctx.today(), 3);
  const status = soon ? chip('soon') + ' ' : o.status === 'planned' ? '' : chip(o.status) + ' ';
  return `<button class="row ${o.status === 'paid' ? 'done' : ''}" data-occ="${esc(o.key)}"><div class="tile">${icon(o.kind === 'income' ? 'income' : o.kind === 'transfer' ? 'transfer' : 'bill')}</div>
    <div class="main"><div class="title">${esc(o.name)}</div><div class="meta">${status}${esc(shortDate(o.date))}${o.undated ? ' · date not confirmed' : ''} · ${esc(acct)}</div></div>
    <div class="amount">${signed(o.part ? o.remaining : o.amount, occDir(s, o))}${o.variable ? '<small>varies</small>' : o.part ? '<small>still to pay</small>' : ''}</div></button>`;
}
// Overdue items grouped by the account they leave, so seven direct debits are one decision.
function overdueGroups(ctx, overdue) {
  const s = ctx.state, groups = {};
  for (const o of overdue) (groups[o.from || o.to] ??= []).push(o);
  return Object.entries(groups).map(([acc, list]) => list.length === 1 ? `<div class="list" style="margin-top:10px">${overdueRow(ctx, list[0])}</div>`
    : `<div class="card" style="margin-top:10px"><div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline"><strong>${list.length} from ${esc(s.account[acc]?.name || 'an account')}</strong>${signed(list.reduce((t, o) => t + (o.remaining || o.amount), 0), 'out')}</div>
      <p class="muted small">${esc(list.map(o => o.name).join(', '))}</p>
      <div class="btnrow"><button class="btn small primary" data-allgone="${esc(acc)}">All gone</button><a class="btn small" href="#/account/${encodeURIComponent(acc)}">Correct balance</a></div>
      <details class="fold"><summary style="font-size:15px">One at a time</summary><div class="list">${list.map(o => overdueRow(ctx, o)).join('')}</div></details></div>`).join('');
}
function overdueRow(ctx, o) {
  return `<div class="row static"><div class="main" data-occ="${esc(o.key)}" role="button" tabindex="0" style="cursor:pointer"><div class="title">${esc(o.name)}</div>
    <div class="meta">Due ${esc(shortDate(o.date))} · tap for more</div></div>${signed(o.remaining || o.amount, occDir(ctx.state, o))}
    <button class="donebtn" data-paid="${esc(o.key)}">${o.kind === 'income' ? 'Arrived' : 'Gone'}</button></div>`;
}
function movedSheet(ctx, o) {
  sheet(`${o.name}: new date`, `<form novalidate>${field('It will happen on', `<input type="date" name="date" value="${esc(ctx.today())}">`)}${errorBox()}
    <div class="btnrow"><button class="btn primary block" type="submit">Save</button></div></form>`, el => {
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      try { await ctx.dispatch(setOccurrence(ctx.state, o.key, { date: e.target.date.value }, `${o.name} moved to ${e.target.date.value}`)); } catch (err) { showError(el, err); }
    };
  });
}

function backupLine(ctx) {
  const b = ctx.backup;
  if (!ctx.meta.backupCfg) return '';
  const text = b.status === 'ok' ? `Backed up ${relTime(b.at)}` : b.status === 'saving' ? 'Backing up…' : b.status === 'waiting' ? 'Backup waiting for internet' : 'Backup needs attention';
  return `<p class="muted small" style="margin:10px 4px 0">${icon('cloud')} ${esc(text)}</p>`;
}

function explain(ctx, safe, lastCheck) {
  return explainList(ctx, safe, lastCheck);
}
function explainList(ctx, safe, lastCheck) {
  const s = ctx.state;
  const main = s.setting.mainAccount?.value || 'acc-current';
  const name = s.account[main]?.name || 'Current account';
  const sp = spareParts(safe);
  const body = `<div class="card lines">
    <div class="line"><span>${esc(name)} now</span><strong class="amount">${money(sp.now)}</strong></div>
    <div class="line"><span>Still to go out before payday (${safe.outgoing.length})</span>${signed(sp.out, 'out')}</div>
    ${sp.in ? `<div class="line"><span>Still to come in before payday</span>${signed(sp.in, 'in')}</div>` : ''}
    ${sp.timing ? `<div class="line"><span>Money arrives after it’s needed<small>lowest point ${esc(shortDate(safe.lowDate))}</small></span>${signed(sp.timing, 'out')}</div>` : ''}
    ${sp.topups ? `<div class="line"><span>Top-ups other accounts need</span>${signed(sp.topups, 'out')}</div>` : ''}
    <div class="line"><span>Cushion you keep</span>${signed(sp.cushion, 'out')}</div>
    <div class="line total"><span>${sp.spare < 0 ? 'Short by' : 'Spare to spend'}</span><strong class="amount ${sp.spare < 0 ? 'out' : ''}">${money(Math.abs(sp.spare))}</strong></div></div>
    <p class="muted small">${lastCheck ? `${esc(name)} last updated from your bank ${esc(longDate(lastCheck.date))}.` : `${esc(name)} has not been updated from your bank yet.`} Expected salary is never counted until you confirm it has arrived. Tap a payment to mark it paid, skip it or change it.</p>
    <section><h2>Going out before payday</h2><div class="list">${safe.outgoing.map(f => `<button class="row" ${f.occ ? `data-occ="${esc(f.occ)}"` : 'disabled'}><div class="main"><div class="title">${esc(f.label)}</div><div class="meta">${f.overdue ? chip('overdue') + ' ' : ''}${esc(shortDate(f.date))}${f.estimate ? ' · estimate' : ''}</div></div>${signed(f.amount, 'out')}</button>`).join('') || '<div class="row muted">Nothing</div>'}</div></section>
    ${safe.topups.length ? `<section><h2>Accounts that need topping up</h2><div class="list">${safe.topups.map(t => `<a class="row" href="#/account/${encodeURIComponent(t.account)}"><div class="main"><div class="title">${esc(t.name)}</div><div class="meta">Short on ${esc(shortDate(t.date))}</div></div><div class="amount">${money(t.amount)}</div></a>`).join('')}</div></section>` : ''}`;
  sheet('Before payday', body, (el, close) => {
    el.querySelectorAll('[data-occ]').forEach(b => b.onclick = () => { close(); openOccurrenceSheet(ctx, b.dataset.occ); });
    el.querySelectorAll('a.row').forEach(a => a.onclick = () => close());
  });
}
export { balances };
