// Today: what is safe to spend until payday, what needs doing, what just changed.
import { esc, money, icon, sheet, relTime, signed, chip, toast } from '../ui.js';
import { longDate, shortDate, addDays, daysBetween } from '../calendar.js';
import { safeToSpend } from '../forecast.js';
import { allOccurrences } from '../plan.js';
import { canUndo, selfCheck, balances } from '../model.js';
import { openOccurrenceSheet, field, errorBox, showError } from './forms.js';
import { markPaid, setOccurrence } from '../commands.js';
import { payRun } from '../payrun.js';
import { currentRunKey } from './payday.js';

export function renderToday(ctx) {
  const s = ctx.state, today = ctx.today();
  const start = s.setting.startDate?.value || today;
  const safe = safeToSpend(s, today);
  const nextPay = safe?.nextPayday;
  const days = nextPay ? daysBetween(today, nextPay) : null;
  const cls = !safe ? 'zero' : safe.raw >= 0 ? '' : safe.lowest - safe.topupTotal < 0 ? 'short' : 'zero';
  const heroText = !safe ? 'Outside your plan' : money(safe.safe);
  const heroFoot = !safe ? '' : safe.raw >= 0
    ? `Until payday, ${esc(longDate(nextPay))} · ${days} day${days === 1 ? '' : 's'}`
    : safe.lowest - safe.topupTotal < 0
      ? `Your current account would be ${money(-(safe.lowest - safe.topupTotal))} short before payday`
      : `Your ${money(safe.cushion)} cushion is ${money(-safe.raw)} short before payday`;

  const occ = allOccurrences(s, start, addDays(today, 7), today);
  const overdue = occ.filter(o => o.status === 'overdue');
  const soon = occ.filter(o => o.status === 'planned' && o.date <= addDays(today, 7));
  const problems = selfCheck(s);
  const attention = [];
  if (problems.length) attention.push(banner('bad', 'Payday found a problem in its records', problems.slice(0, 3).join('. '), '#/settings', 'Details'));
  if (!ctx.meta.backupCfg && !window.PAYDAY_TEST) attention.push(banner('bad', 'Automatic backup is not set up', 'If this phone’s storage is cleared, your records would be lost. Set up the backup now; it takes about five minutes.', '#/settings', 'Set up'));
  else if (['error', 'conflict', 'locked'].includes(ctx.backup.status)) attention.push(banner('bad', 'Backup needs attention', ctx.backup.message, '#/settings', 'Open'));
  if (s.setting.startCheckDone?.value === false) attention.push(banner('', 'Finish your 29 October start-up check', 'Confirm what went out between payday and 4 November.', '#/settings', 'Check'));
  for (const t of safe?.topups || []) attention.push(banner('', `${t.name} will be ${money(t.amount)} short`, `On ${longDate(t.date)}. Move money in before then. This is already held back from your safe-to-spend figure.`, null));

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
  <div class="hero ${cls}">
    <div class="label">Safe to spend</div>
    <div class="big amount" aria-live="polite">${heroText}</div>
    <div class="foot">${heroFoot}</div>
    ${safe ? '<button type="button" data-explain>How this is worked out</button>' : ''}
  </div>
  ${payCard}
  ${backupLine(ctx)}
  ${overdue.length ? `<section><h2>Overdue ${chip('overdue', String(overdue.length))}</h2>
    <p class="muted small">Past their date and not marked. Each is still held back from safe-to-spend until you say what happened.</p>
    ${overdueGroups(ctx, overdue)}</section>` : ''}
  ${attention.length ? `<section><h2>Needs attention</h2>${attention.join('')}</section>` : ''}
  <section><h2>Next 7 days</h2>${soon.length ? `<div class="list">${soon.map(o => occRow(ctx, o)).join('')}</div>` : '<div class="card muted">Nothing planned in the next 7 days.</div>'}</section>
  <section><h2>Recent changes</h2>${recent.length ? `<div class="list">${recent.map(e => {
    const ok = canUndo(s, e).ok && !e.undoes;
    return `<div class="row" style="cursor:default"><div class="main"><div class="title">${esc(e.label)}</div><div class="meta">${esc(relTime(e.at))}</div></div>
      ${ok ? `<button class="btn small" data-undo="${esc(e.id)}" aria-label="Undo ${esc(e.label)}">Undo</button>` : ''}</div>`;
  }).join('')}</div><a href="#/history" class="linkrow">See every transaction and change ›</a>` : '<div class="card muted">Nothing changed yet.</div>'}</section>`;
}

function banner(kind, title, text, href, action) {
  return `<div class="banner ${kind}"><span class="dot" aria-hidden="true">!</span><div class="main"><strong>${esc(title)}</strong><p class="small muted">${esc(text)}</p>
    ${href ? `<a class="btn small" href="${href}">${esc(action)}</a>` : ''}</div></div>`;
}

export function occDir(s, o) {
  if (o.kind === 'income') return 'in';
  const own = id => id && s.account[id] && s.account[id].tracked !== false;
  return o.kind === 'transfer' && own(o.from) && own(o.to) ? 'move' : 'out';
}
export function occRow(ctx, o) {
  const s = ctx.state;
  const dir = occDir(s, o);
  const acct = dir === 'move' ? `${s.account[o.from]?.name} → ${s.account[o.to]?.name}` : dir === 'in' ? `into ${s.account[o.to]?.name || ''}` : `from ${s.account[o.from]?.name || ''}`;
  const status = o.status === 'planned' ? '' : chip(o.status) + ' ';
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
      <div class="btnrow"><button class="btn small primary" data-allgone="${esc(acc)}">All gone</button><a class="btn small" href="#/account/${encodeURIComponent(acc)}">Check bank</a></div>
      <details class="fold"><summary style="font-size:15px">One at a time</summary><div class="list">${list.map(o => overdueRow(ctx, o)).join('')}</div></details></div>`).join('');
}
function overdueRow(ctx, o) {
  return `<div class="row static" style="flex-wrap:wrap"><div class="main" data-occ="${esc(o.key)}" role="button" tabindex="0" style="cursor:pointer"><div class="title">${esc(o.name)}</div>
    <div class="meta">Was due ${esc(longDate(o.date))}</div></div><div class="amount">${signed(o.remaining || o.amount, occDir(ctx.state, o))}</div>
    <div class="btnrow" style="width:100%;margin-top:4px"><button class="btn small primary" data-paid="${esc(o.key)}">${o.kind === 'income' ? 'Arrived' : 'Gone'}</button><button class="btn small" data-nope="${esc(o.key)}">Didn’t happen</button><button class="btn small" data-moved="${esc(o.key)}">New date</button></div></div>`;
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
  const s = ctx.state;
  const main = s.setting.mainAccount?.value || 'acc-current';
  const name = s.account[main]?.name || 'Current account';
  const out = safe.outgoing.reduce((t, f) => t + f.amount, 0);
  const inc = safe.incoming.reduce((t, f) => t + f.amount, 0);
  const body = `<div class="card lines">
    <div class="line"><span>${esc(name)} now</span><strong class="amount">${money(safe.balance)}</strong></div>
    <div class="line"><span>Still to go out before payday (${safe.outgoing.length})</span><strong class="amount">${money(-out)}</strong></div>
    ${inc ? `<div class="line"><span>Still to come in before payday</span><strong class="amount in">${money(inc, { sign: true })}</strong></div>` : ''}
    <div class="line"><span>Lowest point${safe.lowDate ? `, ${esc(shortDate(safe.lowDate))}` : ''}</span><strong class="amount">${money(safe.lowest)}</strong></div>
    ${safe.topupTotal ? `<div class="line"><span>Top-ups for other accounts</span><strong class="amount">${money(-safe.topupTotal)}</strong></div>` : ''}
    <div class="line"><span>Cushion you keep</span><strong class="amount">${money(-safe.cushion)}</strong></div>
    <div class="line total"><span>Safe to spend</span><strong class="amount">${money(safe.safe)}</strong></div></div>
    <p class="muted small">${lastCheck ? `Last checked against your bank ${esc(longDate(lastCheck.date))}.` : 'Not yet checked against your bank.'} Expected salary is never counted until you confirm it has arrived.</p>
    <section><h2>Going out before payday</h2><div class="list">${safe.outgoing.map(f => `<div class="row" style="cursor:default"><div class="main"><div class="title">${esc(f.label)}</div><div class="meta">${f.overdue ? '<span class="tag overdue">Overdue</span> ' : ''}${esc(shortDate(f.date))}${f.estimate ? ' · estimate' : ''}</div></div><div class="amount">${money(-f.amount)}</div></div>`).join('') || '<div class="row muted">Nothing</div>'}</div></section>
    ${safe.topups.length ? `<section><h2>Accounts that need topping up</h2><div class="list">${safe.topups.map(t => `<div class="row" style="cursor:default"><div class="main"><div class="title">${esc(t.name)}</div><div class="meta">Short on ${esc(shortDate(t.date))}</div></div><div class="amount">${money(t.amount)}</div></div>`).join('')}</div></section>` : ''}`;
  sheet('How safe-to-spend is worked out', body);
}
export { balances };
