// Plan: every payday period to April 2031, with the forecast for each.
import { esc, money, icon, lineChart } from '../ui.js';
import { longDate, shortDate, periodName, addDays } from '../calendar.js';
import { project, mainAccountId, cushionOf } from '../forecast.js';
import { allOccurrences, planPeriods, describeSchedule } from '../plan.js';
import { occRow } from './today.js';
import { openOccurrenceSheet, openRuleSheet, openTxnSheet, txnLine, txnAmountText, txnAmountClass, txnKindIcon, accountsList } from './forms.js';

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

  ctx.afterRender = el => {
    el.querySelector('[data-rules]').onclick = () => ctx.go('#/rules');
  };
  return `
  <header class="topbar"><div><h1>Plan</h1><div class="sub">${list.length} paydays · ${esc(periodName(list[0]))} to ${esc(periodName(list[list.length - 1]))}</div></div>
    <button class="btn small" data-rules>Regular payments</button></header>
  ${s.setting.everydaySpend?.value == null ? '<div class="banner"><span class="dot">!</span><div><strong>Add your everyday spending</strong><p class="small muted">Until you do, the forecast assumes you spend nothing day to day, so your balance looks as if it keeps growing.</p><a class="btn small" href="#/settings">Set it</a></div></div>' : ''}
  <section class="card chart"><h3>Lowest point in your current account, each payday period</h3>${chart}
    <div class="legend"><span><i class="key"></i>Forecast</span><span><i class="key line"></i>Your ${money(cushion)} cushion</span></div>
    <p class="small ${firstShort ? '' : 'muted'}">${firstShort ? `First dip below your cushion: the <strong>${esc(periodName(firstShort))}</strong> period, lowest ${money(byKey[firstShort.key].acc[main].low)} on ${esc(shortDate(byKey[firstShort.key].acc[main].lowDate))}.` : 'Your plan stays above your cushion all the way.'}</p>
    ${pots.map(a => `<p class="small"><span class="tag warn">Heads up</span> ${esc(a.name)} goes below £0 on ${esc(longDate(proj.firstNegative[a.id]))}.</p>`).join('')}
    <p class="muted small">Forecasts assume regular payments, standing orders and expected salary happen as planned. Day-to-day spending is not predicted: it comes out of safe-to-spend.</p>
  </section>
  <section><h2>Payday periods</h2><div class="list">${list.map(p => {
    const st = byKey[p.key]?.acc[main];
    const items = byPeriod[p.key] || [];
    const now = p.start <= today && today <= p.end;
    const past = p.end < today;
    const salary = items.find(o => o.ruleId === 'r-salary');
    const open = items.filter(o => o.status === 'overdue').length;
    const flag = st && st.low < 0 ? '<span class="tag bad">Below £0</span>' : st && st.low < cushion ? '<span class="tag warn">Below cushion</span>' : '';
    return `<a class="row" href="#/period/${p.key}"><div class="main"><div class="title">${esc(periodName(p))} ${now ? '<span class="tag ok">Now</span>' : ''} ${flag}</div>
      <div class="meta">${esc(shortDate(p.start))} – ${esc(shortDate(p.end))} · ${salary ? `Salary ${money(salary.amount)}${salary.status === 'paid' ? ' received' : ''}` : 'No salary planned'}${open ? ` · ${open} overdue` : ''}</div></div>
      <div class="amount">${past ? '<small>Ended</small>' : st ? `${money(st.close)}<small>low ${money(st.low)}</small>` : ''}</div></a>`;
  }).join('')}</div></section>`;
}

export function renderPeriod(ctx, key) {
  const s = ctx.state, today = ctx.today();
  const list = planPeriods(s);
  const p = list.find(x => x.key === key);
  if (!p) return '<p>Unknown payday period.</p>';
  const i = list.indexOf(p);
  const occ = allOccurrences(s, addDays(p.start, -10), p.end, today).filter(o => o.period === key);
  const groups = [['Overdue', occ.filter(o => o.status === 'overdue')], ['Still to come', occ.filter(o => o.status === 'planned')],
    ['Done', occ.filter(o => o.status === 'paid')], ['Skipped', occ.filter(o => o.status === 'skipped')]];
  const linked = new Set(occ.map(o => o.txn?.id).filter(Boolean));
  const other = Object.values(s.txn).filter(t => t.date >= p.start && t.date <= p.end && !linked.has(t.id)).sort((a, b) => b.date.localeCompare(a.date));
  const proj = forecastAll(ctx);
  const st = proj.periods.find(x => x.key === key);
  const main = mainAccountId(s);
  ctx.afterRender = el => {
    el.querySelectorAll('[data-occ]').forEach(b => b.onclick = () => openOccurrenceSheet(ctx, b.dataset.occ));
    el.querySelectorAll('[data-txn]').forEach(b => b.onclick = () => openTxnSheet(ctx, b.dataset.txn));
  };
  return `
  <a class="back" href="#/plan">${icon('back')} Plan</a>
  <header class="topbar"><div><h1>${esc(periodName(p))}</h1><div class="sub">${esc(longDate(p.start))} to ${esc(longDate(p.end))}</div></div></header>
  <div class="btnrow">${i > 0 ? `<a class="btn small" href="#/period/${list[i - 1].key}">‹ Previous</a>` : ''}${i < list.length - 1 ? `<a class="btn small" href="#/period/${list[i + 1].key}">Next ›</a>` : ''}</div>
  ${st?.acc[main] ? `<section class="grid2"><div class="stat"><span>Lowest point</span><strong class="amount">${money(st.acc[main].low)}</strong><span>${esc(shortDate(st.acc[main].lowDate))}</span></div>
    <div class="stat"><span>Day before next payday</span><strong class="amount">${money(st.acc[main].close)}</strong><span>forecast</span></div></section>` : ''}
  ${groups.map(([title, items]) => items.length ? `<section><h2>${title} <span class="tag">${items.length}</span></h2><div class="list">${items.map(o => occRow(ctx, o)).join('')}</div></section>` : '').join('')}
  ${other.length ? `<section><h2>Other money recorded</h2><div class="list">${other.map(t => `<button class="row" data-txn="${esc(t.id)}"><div class="tile">${icon(txnKindIcon(t))}</div><div class="main"><div class="title">${esc(t.desc)}</div><div class="meta">${esc(shortDate(t.date))} · ${esc(txnLine(s, t))}</div></div><div class="amount ${txnAmountClass(s, t)}">${txnAmountText(t)}</div></button>`).join('')}</div></section>` : ''}`;
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
