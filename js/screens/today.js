// Today: what is safe to spend until payday, what needs doing, what just changed.
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
  const safe = safeToSpend(s, today);
  const nextPay = safe?.nextPayday;
  const days = nextPay ? daysBetween(today, nextPay) : null;
  const sp = safe ? spareParts(safe) : null;
  const cls = !sp ? 'zero' : sp.spare >= 0 ? '' : 'short';
  const heroText = !sp ? 'Outside your plan' : sp.spare >= 0 ? money(sp.spare) : `−${money(-sp.spare)}`;
  const heroFoot = !sp ? '' : sp.spare >= 0 ? `Spare in your current account until payday, ${esc(longDate(nextPay))} (${days} day${days === 1 ? '' : 's'})`
    : `Your current account is ${money(-sp.spare)} short of what it needs before payday, ${esc(longDate(nextPay))}`;
  const tiles = homeTiles(ctx, safe, sp);
  const featured = featuredCards(ctx, safe, sp);

  const occ = allOccurrences(s, start, addDays(today, 7), today);
  const overdue = occ.filter(o => o.status === 'overdue');
  const soon = occ.filter(o => o.status === 'planned' && o.date <= addDays(today, 7));
  const problems = selfCheck(s);
  const attention = [];
  if (problems.length) attention.push(banner('bad', 'Payday found a problem in its records', problems.slice(0, 3).join('. '), '#/settings', 'Details'));
  if (!ctx.meta.backupCfg && !window.PAYDAY_TEST) attention.push(banner('bad', 'Automatic backup is not set up', 'If this phone’s storage is cleared, your records would be lost. Set up the backup now; it takes about five minutes.', '#/settings', 'Set up'));
  else if (['error', 'conflict', 'locked'].includes(ctx.backup.status)) attention.push(banner('bad', 'Backup needs attention', ctx.backup.message, '#/settings', 'Open'));
  if (s.setting.startCheckDone?.value === false) attention.push(banner('', 'Finish your 29 October start-up check', 'Confirm what went out between payday and 4 November.', '#/settings', 'Check'));
  for (const t of safe?.topups || []) attention.push(banner('', `${t.name} will be ${money(t.amount)} short`, `On ${longDate(t.date)}. Move money in before then. This is already taken off your spare figure.`, `#/account/${encodeURIComponent(t.account)}`, 'Open'));

  const checks = toCheck(ctx, today);
  const recent = [...s.events].reverse().filter(e => !e.label.startsWith('Brought in')).slice(0, 4);
  const main = s.setting.mainAccount?.value || 'acc-current';
  const lastCheck = Object.values(s.check).filter(c => c.account === main).sort((a, b) => (b.at || b.date).localeCompare(a.at || a.date))[0];

  const runKey = currentRunKey(s, today);
  const run = runKey ? payRun(s, runKey, today) : null;
  const payCard = run && (!run.complete || run.period.start === today) ? `<a class="paycard" href="#/payday/${run.period.key}" style="display:block;text-decoration:none;color:inherit;margin-top:12px">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px"><h2>${run.ready ? 'Payday' : `Payday ${daysBetween(today, run.period.start) === 1 ? 'tomorrow' : `in ${daysBetween(today, run.period.start)} days`}`}</h2><span class="muted small">${esc(longDate(run.period.start))}</span></div>
    <div class="muted small">${run.complete ? 'Everything is done.' : run.ready ? `${run.total - run.todo} of ${run.total} done. Tap to see what to move where.` : `See what will need moving where, and what will be left.`}</div>
    <div class="progress"><i style="width:${run.total ? Math.round(((run.total - run.todo) / run.total) * 100) : 100}%"></i></div></a>` : '';

  ctx.afterRender = el => {
    el.querySelector('[data-explain]')?.addEventListener('click', () => explain(ctx, safe, lastCheck));
    el.querySelector('[data-choose]')?.addEventListener('click', () => chooseTiles(ctx));
    el.querySelector('[data-confirm-main]')?.addEventListener('click', () => confirmBalance(ctx, main));
    el.querySelector('[data-correct-main]')?.addEventListener('click', () => openCheckSheet(ctx, main));
    el.querySelector('[data-cushion]')?.addEventListener('click', () => cushionSheet(ctx));
    el.querySelectorAll('[data-paid]').forEach(b => b.onclick = async () => {
      const o = overdue.find(x => x.key === b.dataset.paid);
      try { await ctx.dispatch(markPaid(ctx.state, o.key, { date: o.date, amount: o.remaining || o.amount }, today), { message: `${o.name}: marked as gone` }); } catch (err) { toast(err.message, { warn: true }); }
    });
    el.querySelectorAll('[data-nope]').forEach(b => b.onclick = async () => {
      const o = overdue.find(x => x.key === b.dataset.nope);
      try { await ctx.dispatch(setOccurrence(ctx.state, o.key, { skip: true }, `${o.name} on ${o.date} didn't happen`), { message: `${o.name}: marked as didn't happen` }); } catch (err) { toast(err.message, { warn: true }); }
    });
    el.querySelectorAll('[data-moved]').forEach(b => b.onclick = () => movedSheet(ctx, overdue.find(x => x.key === b.dataset.moved)));
    el.querySelectorAll('[data-allgone]').forEach(b => b.onclick = async () => {
      const list = overdue.filter(o => (o.from || o.to) === b.dataset.allgone);
      try {
        const evs = list.map(o => markPaid(ctx.state, o.key, { date: o.date, amount: o.remaining || o.amount }, today));
        const ev = { ...evs[0], label: `${list.length} payments from ${s.account[b.dataset.allgone]?.name} marked as gone`, ops: evs.flatMap(e => e.ops) };
        await ctx.dispatch(ev, { message: ev.label });
      } catch (err) { toast(err.message, { warn: true }); }
    });
    el.querySelectorAll('[data-occ]').forEach(b => b.onclick = () => openOccurrenceSheet(ctx, b.dataset.occ));
    el.querySelectorAll('[data-undo]').forEach(b => b.onclick = () => ctx.undo(s.events.find(e => e.id === b.dataset.undo)));
  };

  return `
  <header class="topbar"><div><h1>Today</h1><div class="sub">${esc(longDate(today))}</div></div>
    <a class="iconbtn" href="#/settings" aria-label="Settings">${icon('gear')}</a></header>
  ${featured}
  ${tiles}
  ${payCard}
  ${backupLine(ctx)}
  ${overdue.length ? `<section><h2>Overdue ${chip('overdue', String(overdue.length))}</h2>
    <p class="muted small">Past their date and not marked. Tap Gone if your bank shows it, or tap the payment to skip it or change its date.</p>
    ${overdueGroups(ctx, overdue)}</section>` : ''}
  ${attention.length ? `<section><h2>Needs attention</h2>${attention.join('')}</section>` : ''}
  ${checks.length ? `<section><details class="fold card"><summary>To check (${checks.length})</summary>
    <p class="muted small">Figures Payday can’t be sure of until you check them against your bank, statements or letters.</p>
    <div class="list">${checks.map(c => `<${c.href ? `a href="${c.href}"` : `button data-occ="${esc(c.occ)}"`} class="row"><div class="main"><div class="title">${esc(c.title)}</div><div class="meta">${esc(c.text)}</div></div>›</${c.href ? 'a' : 'button'}>`).join('')}</div></details></section>` : ''}
  <section><h2>Next 7 days</h2>${soon.length ? `<div class="list">${soon.map(o => occRow(ctx, o)).join('')}</div>` : '<div class="card muted">Nothing planned in the next 7 days.</div>'}</section>
  <section><h2>Recent changes</h2>${recent.length ? `<div class="list">${recent.map(e => {
    const ok = canUndo(s, e).ok && !e.undoes;
    return `<div class="row" style="cursor:default"><div class="main"><div class="title">${esc(e.label)}</div><div class="meta">${esc(relTime(e.at))}</div></div>
      ${ok ? `<button class="btn small" data-undo="${esc(e.id)}" aria-label="Undo ${esc(e.label)}">Undo</button>` : ''}</div>`;
  }).join('')}</div><a href="#/history" class="linkrow">See every transaction and change ›</a>` : '<div class="card muted">Nothing changed yet.</div>'}</section>`;
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
  const ids = tileIds(s);
  const lows = {};
  for (const t of safe?.topups || []) lows[t.account] = t;
  return `<section style="margin-top:18px"><div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0">Your other accounts</h2><button class="btn small" data-choose>Customise</button></div>
    <div class="tiles">${ids.map(id => {
      const a = s.account[id], role = roleOf(s, a), v = a.tracked === false ? null : displayBalance(a, bal[id]);
      const need = a.target != null && v != null ? Math.max(0, a.target - v) : null;
      const note = lows[id] ? `${money(lows[id].amount)} short by ${shortDate(lows[id].date)}`
        : a.type === 'card' ? 'owed'
        : need ? `${money(need)} to reach ${money(a.target)}` : need === 0 ? `Target ${money(a.target)} reached` : '';
      return `<a class="tile-acc ${lows[id] ? 'warn' : ''}" href="#/account/${encodeURIComponent(id)}">
        <span class="nm">${esc(a.name)}</span><strong class="amount ${v < 0 && a.type !== 'card' ? 'out' : ''}">${v == null ? '—' : money(v)}</strong>
        ${note ? `<span class="nt">${esc(note)}</span>` : ''}<span class="nt">${confirmedBadge(s, id, today)}</span></a>`;
    }).join('')}</div></section>`;
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
