// Today: what is safe to spend until payday, what needs doing, what just changed.
import { esc, money, icon, sheet, relTime } from '../ui.js';
import { longDate, shortDate, addDays, daysBetween } from '../calendar.js';
import { safeToSpend } from '../forecast.js';
import { allOccurrences } from '../plan.js';
import { canUndo, selfCheck, balances } from '../model.js';
import { openOccurrenceSheet } from './forms.js';

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
  if (!ctx.meta.backupCfg) attention.push(banner('bad', 'Automatic backup is not set up', 'If this phone’s storage is cleared, your records would be lost. Set up the backup now; it takes about five minutes.', '#/settings', 'Set up'));
  else if (['error', 'conflict', 'locked'].includes(ctx.backup.status)) attention.push(banner('bad', 'Backup needs attention', ctx.backup.message, '#/settings', 'Open'));
  if (s.setting.startCheckDone?.value === false) attention.push(banner('', 'Finish your 29 October start-up check', 'Confirm what went out between payday and 4 November.', '#/settings', 'Check'));
  for (const t of safe?.topups || []) attention.push(banner('', `${t.name} will be ${money(t.amount)} short`, `On ${longDate(t.date)}. Move money in before then. This is already held back from your safe-to-spend figure.`, null));

  const recent = [...s.events].reverse().filter(e => !e.label.startsWith('Brought in')).slice(0, 4);
  const main = s.setting.mainAccount?.value || 'acc-current';
  const lastCheck = Object.values(s.check).filter(c => c.account === main).sort((a, b) => (b.at || b.date).localeCompare(a.at || a.date))[0];

  ctx.afterRender = el => {
    el.querySelector('[data-explain]')?.addEventListener('click', () => explain(ctx, safe, lastCheck));
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
  ${backupLine(ctx)}
  ${attention.length ? `<section><h2>Needs attention</h2>${attention.join('')}</section>` : ''}
  ${overdue.length ? `<section><h2>Overdue <span class="tag overdue">${overdue.length}</span></h2><div class="list">${overdue.map(o => occRow(ctx, o)).join('')}</div>
    <p class="muted small">Still held back from safe-to-spend until you mark each one paid or skip it.</p></section>` : ''}
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

export function occRow(ctx, o) {
  const s = ctx.state;
  const acct = [s.account[o.from]?.name, s.account[o.to]?.name].filter(Boolean).join(' → ');
  const sign = o.kind === 'income' ? money(o.amount, { sign: true }) : money(-o.amount);
  return `<button class="row" data-occ="${esc(o.key)}"><div class="tile">${icon(o.kind === 'income' ? 'income' : o.kind === 'transfer' ? 'transfer' : 'bill')}</div>
    <div class="main"><div class="title">${esc(o.name)}</div><div class="meta">${o.status === 'overdue' ? '<span class="tag overdue">Overdue</span> ' : ''}${esc(shortDate(o.date))}${o.undated ? ' (date to confirm)' : ''} · ${esc(acct)}</div></div>
    <div class="amount ${o.kind === 'income' ? 'in' : ''}">${sign}${o.variable ? '<small>varies</small>' : ''}</div></button>`;
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
