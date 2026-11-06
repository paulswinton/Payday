// Plan: every payday period to April 2031, with the forecast for each.
import { esc, money, icon, lineChart } from '../ui.js';
import { longDate, shortDate, periodName, addDays } from '../calendar.js';
import { project, mainAccountId, cushionOf } from '../forecast.js';
import { allOccurrences, planPeriods, describeSchedule } from '../plan.js';
import { occRow } from './today.js';
import { openOccurrenceSheet, openRuleSheet, openTxnSheet, txnLine, txnAmount, txnKindIcon, accountsList } from './forms.js';
import { signed, chip } from '../ui.js';
import { everydayCover } from '../forecast.js';
import { balances } from '../model.js';

let cache = { key: null, value: null };
export function forecastAll(ctx) {
  const s = ctx.state, today = ctx.today();
  const key = `${s.seq}|${today}`;
  if (cache.key !== key) {
    const list = planPeriods(s);
    cache = { key, value: project(s, { today, until: list[list.length - 1].end }) };
  }
  return cache.value;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = d => `${MONTHS[Number(d.slice(5, 7)) - 1]} ’${d.slice(2, 4)}`;

// Money flow for one payday period on the main account: real figures for what has
// happened, forecast for what hasn't.
export function periodFlow(ctx, p, st) {
  const s = ctx.state, today = ctx.today(), main = mainAccountId(s);
  const actual = Object.values(s.txn).filter(t => t.date >= p.start && t.date <= (p.end < today ? p.end : today) && (t.from === main || t.to === main));
  const aIn = actual.filter(t => t.to === main).reduce((x, t) => x + t.amount, 0);
  const aOut = actual.filter(t => t.from === main).reduce((x, t) => x + t.amount, 0);
  if (p.end < today) {
    const bf = balances(s, addDays(p.start, -1))[main];
    return { bf, in: aIn, out: aOut, left: balances(s, p.end)[main], when: 'past' };
  }
  if (p.start <= today) {
    const bf = balances(s, addDays(p.start, -1))[main];
    return { bf, in: aIn + (st?.in || 0), out: aOut + (st?.out || 0), left: st?.close ?? balances(s, today)[main], when: 'now' };
  }
  return { bf: st?.before ?? 0, in: st?.in || 0, out: st?.out || 0, left: st?.close ?? 0, when: 'future' };
}

let showAll = false;
export function renderPlan(ctx) {
  const s = ctx.state, today = ctx.today();
  const list = planPeriods(s);
  const proj = forecastAll(ctx);
  const main = mainAccountId(s), cushion = cushionOf(s);
  const byKey = Object.fromEntries(proj.periods.map(p => [p.key, p]));
  const future = list.filter(p => p.end >= today);
  const chart = lineChart({
    labels: future.map(p => monthLabel(p.start)),
    series: [{ values: future.map(p => byKey[p.key]?.acc[main]?.low ?? null), cls: 'base' }],
    guide: cushion, title: 'Lowest current-account balance in each payday period',
  });
  const firstShort = future.find(p => (byKey[p.key]?.acc[main]?.low ?? 0) < cushion);
  const pots = accountsList(s, { types: ['pot', 'bank'] }).filter(a => a.id !== main && a.tracked !== false && proj.firstNegative[a.id]);
  const occ = allOccurrences(s, s.setting.startDate?.value || list[0].start, list[list.length - 1].end, today);
  const byPeriod = {};
  for (const o of occ) (byPeriod[o.period] ??= []).push(o);
  const cover = everydayCover(s);
  const recent = list.filter(p => p.end >= addDays(today, -40));
  const shown = showAll ? recent : recent.slice(0, 13);

  ctx.afterRender = el => {
    el.querySelector('[data-rules]').onclick = () => ctx.go('#/rules');
    el.querySelector('[data-all]')?.addEventListener('click', () => { showAll = !showAll; ctx.renderSameRoute(); });
  };
  return `
  <header class="topbar"><div><h1>Plan</h1><div class="sub">Each payday to ${esc(periodName(list[list.length - 1]))}</div></div>
    <button class="btn small" data-rules>Regular payments</button></header>
  ${!cover ? '<div class="banner"><span class="dot">!</span><div><strong>How is day-to-day spending paid?</strong><p class="small muted">Until Payday knows, the forecast assumes you spend nothing day to day, so your balance looks as if it keeps growing. Either set up a spending allowance account (e.g. Pocket money) in Money, or set an amount per payday.</p><a class="btn small" href="#/settings">Set it</a></div></div>'
    : `<p class="muted small" style="margin:0 4px 10px">Day-to-day spending comes from ${cover.source === 'allowance' ? `${esc(cover.account.name)} (${money(cover.amount)} each payday)` : `an allowance of ${money(cover.amount)} each payday`}.</p>`}
  ${pots.map(a => `<div class="banner"><span class="dot">!</span><div><strong>${esc(a.name)} runs short</strong><p class="small muted">It goes below £0 on ${esc(longDate(proj.firstNegative[a.id]))} unless something changes.</p><a class="btn small" href="#/account/${encodeURIComponent(a.id)}">Open</a></div></div>`).join('')}
  <section class="card chart"><h3>Lowest point in your current account, each payday period</h3>${chart}
    <div class="legend"><span><i class="key"></i>Forecast</span><span><i class="key line"></i>Your ${money(cushion)} cushion</span></div>
    <p class="small ${firstShort ? '' : 'muted'}">${firstShort ? `First dip below your cushion: the <strong>${esc(periodName(firstShort))}</strong> period, lowest ${money(byKey[firstShort.key].acc[main].low)} on ${esc(shortDate(byKey[firstShort.key].acc[main].lowDate))}.` : 'Your plan stays above your cushion all the way.'}</p>
  </section>
  <section><h2>Payday periods</h2><div class="list">${shown.map(p => {
    const st = byKey[p.key]?.acc[main];
    const items = byPeriod[p.key] || [];
    const now = p.start <= today && today <= p.end;
    const past = p.end < today;
    const salary = items.find(o => o.ruleId === 'r-salary');
    const open = items.filter(o => o.status === 'overdue').length;
    const f = periodFlow(ctx, p, st);
    const flag = st && st.low < 0 ? chip('overdue', 'Below £0') : st && st.low < cushion ? chip('part', 'Below cushion') : '';
    return `<a class="row" href="#/period/${p.key}"><div class="main"><div class="title">${esc(shortDate(p.start))} – ${esc(shortDate(p.end))} ${now ? chip('now') : ''} ${flag}</div>
      <div class="meta">Brought forward ${money(f.bf)} · ${salary ? `salary ${money(salary.status === 'paid' ? salary.txn.amount : salary.amount)} ${salary.status === 'paid' ? 'arrived' : 'expected'}` : 'no salary'}${open ? ` · ${open} overdue` : ''}</div></div>
      <div class="amount">${money(f.left)}<small>${past ? 'at the end' : 'left before payday'}</small></div></a>`;
  }).join('')}</div>${recent.length > 13 ? `<button class="btn block" data-all style="margin-top:10px">${showAll ? 'Show the next year only' : `Show all ${recent.length} paydays`}</button>` : ''}</section>`;
}

export function renderPeriod(ctx, key) {
  const s = ctx.state, today = ctx.today();
  const list = planPeriods(s);
  const p = list.find(x => x.key === key);
  if (!p) return '<p>Unknown payday period.</p>';
  const i = list.indexOf(p);
  const occ = allOccurrences(s, addDays(p.start, -10), p.end, today).filter(o => o.period === key);
  const overdue = occ.filter(o => o.status === 'overdue');
  const toCome = occ.filter(o => o.status === 'planned' || o.status === 'part');
  const done = occ.filter(o => o.status === 'paid');
  const skipped = occ.filter(o => o.status === 'skipped');
  const linked = new Set(occ.map(o => o.txn?.id).filter(Boolean));
  const other = Object.values(s.txn).filter(t => t.date >= p.start && t.date <= p.end && !linked.has(t.id)).sort((a, b) => b.date.localeCompare(a.date));
  const proj = forecastAll(ctx);
  const st = proj.periods.find(x => x.key === key);
  const main = mainAccountId(s);
  const f = periodFlow(ctx, p, st?.acc[main]);
  const salary = occ.find(o => o.ruleId === 'r-salary');
  const total = arr => arr.reduce((t, o) => t + (o.status === 'paid' ? o.txn.amount : o.part ? o.remaining : o.amount), 0);
  ctx.afterRender = el => {
    el.querySelectorAll('[data-occ]').forEach(b => b.onclick = () => openOccurrenceSheet(ctx, b.dataset.occ));
    el.querySelectorAll('[data-txn]').forEach(b => b.onclick = () => openTxnSheet(ctx, b.dataset.txn));
  };
  return `
  <a class="back" href="#/plan">${icon('back')} Plan</a>
  <header class="topbar"><div><h1>${esc(shortDate(p.start))} – ${esc(shortDate(p.end))}</h1><div class="sub">Payday ${esc(longDate(p.start))}</div></div>
    <div class="btnrow" style="margin:0;flex-wrap:nowrap">${i > 0 ? `<a class="iconbtn" href="#/period/${list[i - 1].key}" aria-label="Previous period">${icon('back')}</a>` : ''}${i < list.length - 1 ? `<a class="iconbtn" href="#/period/${list[i + 1].key}" aria-label="Next period">${icon('back').replace('<svg', '<svg style="transform:rotate(180deg)"')}</a>` : ''}</div></header>
  <div class="card lines flow">
    <div class="line"><span>Brought forward<small>${f.when === 'future' ? 'forecast' : 'in your account the day before payday'}</small></span><strong class="amount">${money(f.bf)}</strong></div>
    ${salary ? `<div class="line"><span>Salary<small>${salary.status === 'paid' ? 'arrived' : 'expected'}</small></span>${signed(salary.status === 'paid' ? salary.txn.amount : salary.amount, 'in')}</div>` : ''}
    ${f.in - (salary ? (salary.status === 'paid' ? salary.txn.amount : salary.amount) : 0) > 0 ? `<div class="line"><span>Other money in</span>${signed(f.in - (salary ? (salary.status === 'paid' ? salary.txn.amount : salary.amount) : 0), 'in')}</div>` : ''}
    <div class="line"><span>Going out<small>bills, standing orders and moves to your pots</small></span>${signed(f.out, 'out')}</div>
    <div class="line total"><span>${f.when === 'past' ? 'Left at the end' : 'Left before next payday'}</span><strong class="amount ${f.left < 0 ? 'out' : ''}">${money(f.left)}</strong></div></div>
  <div class="btnrow"><a class="btn" href="#/payday/${p.key}">Payday checklist</a></div>
  ${overdue.length ? `<section><h2>Overdue ${chip('overdue', String(overdue.length))}</h2><div class="list">${overdue.map(o => occRow(ctx, o)).join('')}</div></section>` : ''}
  ${toCome.length ? `<section><h2>Still to come <span class="muted small">${money(total(toCome))}</span></h2><div class="list">${toCome.map(o => occRow(ctx, o)).join('')}</div></section>` : ''}
  ${done.length ? `<section><details class="fold"><summary>Done (${done.length}) · ${money(total(done))}</summary><div class="list">${done.map(o => occRow(ctx, o)).join('')}</div></details></section>` : ''}
  ${skipped.length ? `<section><details class="fold"><summary>Skipped (${skipped.length})</summary><div class="list">${skipped.map(o => occRow(ctx, o)).join('')}</div></details></section>` : ''}
  ${other.length ? `<section><h2>Other money recorded</h2><div class="list">${other.map(t => `<button class="row" data-txn="${esc(t.id)}"><div class="tile">${icon(txnKindIcon(t))}</div><div class="main"><div class="title">${esc(t.desc)}</div><div class="meta">${esc(shortDate(t.date))} · ${esc(txnLine(s, t))}</div></div>${txnAmount(s, t)}</button>`).join('')}</div></section>` : ''}`;
}

export function renderRules(ctx) {
  const s = ctx.state, today = ctx.today();
  const rules = Object.values(s.rule).filter(r => !r.deleted);
  const active = rules.filter(r => !r.end || r.end >= today);
  const ended = rules.filter(r => r.end && r.end < today);
  const groups = {};
  for (const r of active) {
    const acc = r.kind === 'income' ? 'Money in' : s.account[r.from]?.name || 'Other';
    (groups[acc] ??= []).push(r);
  }
  const row = r => `<button class="row" data-rule="${esc(r.id)}"><div class="tile">${icon(r.kind === 'income' ? 'income' : r.kind === 'transfer' ? 'transfer' : 'bill')}</div>
    <div class="main"><div class="title">${esc(r.name)}</div><div class="meta">${esc(describeSchedule(r))}${r.to && r.kind !== 'income' ? ` · to ${esc(s.account[r.to]?.name || '')}` : ''}${r.variable ? ' · varies' : ''}</div></div>
    <div class="amount">${money(currentAmount(r, today))}</div></button>`;
  ctx.afterRender = el => {
    el.querySelectorAll('[data-rule]').forEach(b => b.onclick = () => openRuleSheet(ctx, b.dataset.rule));
    el.querySelector('[data-new]').onclick = () => openRuleSheet(ctx);
  };
  return `<a class="back" href="#/plan">${icon('back')} Plan</a>
  <header class="topbar"><div><h1>Regular payments</h1><div class="sub">${active.length} active</div></div><button class="btn small primary" data-new>Add</button></header>
  ${Object.entries(groups).map(([g, list]) => `<section><h2>${esc(g)}</h2><div class="list">${list.sort((a, b) => a.name.localeCompare(b.name)).map(row).join('')}</div></section>`).join('')}
  ${ended.length ? `<section><h2>Ended</h2><div class="list">${ended.map(row).join('')}</div></section>` : ''}`;
}
function currentAmount(r, today) {
  let amount = r.amount;
  for (const v of [...(r.versions || [])].sort((a, b) => a.from.localeCompare(b.from))) if (v.from <= today && v.set.amount != null) amount = v.set.amount;
  return amount;
}
