// Payday: one screen that tells you what to do with your salary, in order.
// Each line has a Done button; "Record all as shown" does everything left in one tap.
import { esc, money, icon, sheet, toast, signed, chip } from '../ui.js';
import { longDate, shortDate, periodName } from '../calendar.js';
import { parsePounds, penceToInput } from '../money.js';
import { planPeriods } from '../plan.js';
import { markPaid } from '../commands.js';
import { payRun, recordAll, recordFund } from '../payrun.js';
import { CATEGORIES } from '../roles.js';
import { openOccurrenceSheet, field, errorBox, showError } from './forms.js';

export function currentRunKey(state, today) {
  const list = planPeriods(state);
  const cur = list.find(p => p.start <= today && today <= p.end);
  const next = list.find(p => p.start > today);
  // From three days before payday, the next payday's checklist is the useful one.
  if (next && (Date.parse(next.start) - Date.parse(today)) / 86400000 <= 3) return next.key;
  return cur?.key || next?.key || null;
}

export function renderPayday(ctx, key) {
  const s = ctx.state, today = ctx.today();
  key = key || currentRunKey(s, today);
  const run = key ? payRun(s, key, today) : null;
  if (!run) return `<a class="back" href="#/today">${icon('back')} Today</a><div class="empty">No payday found.</div>`;
  const list = planPeriods(s);
  const idx = list.findIndex(p => p.key === key);
  const pct = run.total ? Math.round(((run.total - run.todo) / run.total) * 100) : 100;
  const dis = run.ready ? '' : 'disabled';
  const doneBtn = (attr, label = 'Done') => `<button class="donebtn" ${attr} ${dis}>${label}</button>`;
  const doneMark = '<span class="donemark">✓ Done</span>';

  ctx.afterRender = el => {
    el.querySelector('[data-salary-ok]')?.addEventListener('click', () => paySalary(ctx, run, run.salary.expected));
    el.querySelector('[data-salary-other]')?.addEventListener('click', () => salaryOther(ctx, run));
    el.querySelectorAll('[data-occ]').forEach(b => b.onclick = () => openOccurrenceSheet(ctx, b.dataset.occ));
    el.querySelectorAll('[data-done]').forEach(b => b.onclick = async e => {
      e.stopPropagation();
      const o = run.payday.find(x => x.key === b.dataset.done);
      try {
        await ctx.dispatch(markPaid(ctx.state, o.key, { date: o.date <= today ? o.date : today, amount: o.amount }, today), { message: `${o.name}: ${money(o.amount)} done` });
      } catch (err) { toast(err.message, { warn: true }); }
    });
    el.querySelectorAll('[data-fund]').forEach(b => b.onclick = async () => {
      const f = run.fund.find(x => x.account.id === b.dataset.fund);
      try { await ctx.dispatch(recordFund(ctx.state, run, f, today, f.amount)); } catch (err) { toast(err.message, { warn: true }); }
    });
    el.querySelectorAll('[data-fund-other]').forEach(b => b.onclick = () => fundOther(ctx, run, run.fund.find(x => x.account.id === b.dataset.fundOther)));
    el.querySelector('[data-all]')?.addEventListener('click', async () => {
      try { await ctx.dispatch(recordAll(ctx.state, run, today), { message: 'Payday recorded' }); } catch (err) { toast(err.message, { warn: true }); }
    });
  };

  const sal = run.salary;
  let n = 0; const num = () => `${++n}. `;
  const salaryStep = sal ? `<div class="step"><h3><span>${num()}Salary</span>${sal.done ? signed(sal.received, 'in') : `<span class="amount">${money(sal.expected)}</span>`}</h3>
    ${sal.done ? `<p>${chip('paid', 'Arrived')} ${sal.received !== sal.expected ? `${sal.received > sal.expected ? `${money(sal.received - sal.expected)} more` : `${money(sal.expected - sal.received)} less`} than your usual ${money(sal.expected)}. Future paydays still assume ${money(sal.expected)}.` : 'As expected.'}</p>
      <div class="btnrow"><button class="btn small" data-occ="${esc(sal.key)}">Change</button></div>`
    : `<p>Expected on ${esc(longDate(sal.date))}. Nothing below counts it until you confirm it.</p>
      <div class="btnrow"><button class="btn primary" data-salary-ok ${dis}>${money(sal.expected)} arrived</button><button class="btn" data-salary-other ${dis}>Different amount</button></div>`}</div>` : '';

  const keepItems = [...run.overdue, ...run.keep];
  const keepStep = `<div class="step"><h3><span>${num()}Keep in ${esc(s.account[run.main]?.name || 'Current')}</span><span class="amount">${money(run.keepTotal)}</span></h3>
    <p>Direct debits and card payments that leave by themselves before next payday. Leave this much in.</p>
    ${keepItems.map(o => `<div class="item" data-occ="${esc(o.key)}" role="button" tabindex="0"><div class="main"><div class="title">${esc(o.name)}</div>
      <div class="meta">${o.status === 'overdue' ? chip('overdue') + ' ' : o.done ? chip('paid') + ' ' : ''}${esc(shortDate(o.date))}${o.undated ? ' · date not confirmed' : ''}${o.variable ? ' · ' + chip('est', 'Varies') : ''}</div></div>
      ${signed(o.remaining || o.amount, o.done ? 'move' : 'out')}</div>`).join('') || '<p>Nothing due.</p>'}</div>`;

  const fundSteps = run.fund.map(f => `<div class="step"><h3><span>${num()}Move to ${esc(f.account.name)}</span>${f.done ? signed(f.txn.amount, 'move') : `<span class="amount">${money(f.amount)}</span>`}</h3>
    <div class="lines">
      <div class="line"><span>Needed before next payday<small>${f.payments.length} payment${f.payments.length === 1 ? '' : 's'}${f.buffer ? ` + ${money(f.buffer)} buffer` : ''}</small></span><strong class="amount">${money(f.need + f.buffer)}</strong></div>
      <div class="line"><span>Already there${f.owedEarlier ? `<small>after ${money(f.owedEarlier)} still to go out</small>` : ''}</span><strong class="amount">${money(f.available)}</strong></div>
      <div class="line total"><span>${f.amount === 0 ? 'Nothing to move' : 'Move'}</span><strong class="amount">${money(f.amount)}</strong></div></div>
    ${f.done ? `<div class="btnrow">${doneMark}</div>` : f.amount > 0 ? `<div class="btnrow"><button class="btn primary" data-fund="${esc(f.account.id)}" ${dis}>Done: moved ${money(f.amount)}</button><button class="btn" data-fund-other="${esc(f.account.id)}" ${dis}>Different amount</button></div>` : ''}</div>`).join('');

  const groupSteps = `<div class="step"><h3><span>${num()}Standing orders</span><span class="amount">${money(run.paydayTotal)}</span></h3>
    <p>Money that leaves on payday. Grouped by what it is for.</p>
    ${run.groups.filter(g => g.items.length).map(g => `<h4 style="margin:14px 0 2px">${esc(CATEGORIES[g.category].label)} <span class="muted small">${money(g.items.reduce((t, o) => t + o.amount, 0))}</span></h4>
      ${g.items.map(o => `<div class="item ${o.done ? 'done' : ''}"><div class="main" data-occ="${esc(o.key)}" role="button" tabindex="0"><div class="title">${esc(o.name)}</div>
        <div class="meta">${o.note ? esc(o.note) : o.to && s.account[o.to] ? `to ${esc(s.account[o.to].name)}` : ''}</div></div>
        <span class="amount">${money(o.done ? o.txn.amount : o.amount)}</span>${o.done ? doneMark : o.amount > 0 ? doneBtn(`data-done="${esc(o.key)}"`) : '<span class="donemark muted">Nothing</span>'}</div>`).join('')}`).join('')}</div>`;

  const holdStep = run.holding.length ? `<div class="step"><h3><span>${num()}Set aside for known payments</span></h3>
    ${run.holding.map(h => `<div class="item"><div class="main"><div class="title">${esc(h.account.name)}</div>
      <div class="meta">${h.firstShort ? `${chip('overdue', 'Will run short')} Covered until ${esc(longDate(h.coveredUntil))}. Short by ${money(h.short)} on ${esc(longDate(h.firstShort))}.` : `${chip('paid', 'Covered')} Every planned payment is covered${h.coveredUntil ? `, up to ${esc(longDate(h.coveredUntil))}` : ''}.`}</div></div></div>`).join('')}
    ${run.holding.some(h => h.firstShort) ? '<p>If the payments stop over summer or end sooner, change the regular payment and this updates.</p>' : ''}</div>` : '';

  const summary = `<div class="step"><h3><span>What's left</span></h3><div class="lines flow">
    <div class="line"><span>Brought forward<small>${run.ready ? 'in your account before payday' : 'forecast'}</small></span><strong class="amount">${money(run.broughtForward)}</strong></div>
    ${sal ? `<div class="line"><span>Salary<small>${sal.done ? 'arrived' : 'expected'}</small></span>${signed(sal.received ?? sal.expected, 'in')}</div>` : ''}
    <div class="line"><span>Direct debits and cards</span>${signed(run.keepTotal + run.keep.filter(o => o.done).reduce((t, o) => t + o.txn.amount, 0), 'out')}</div>
    ${run.fund.map(f => `<div class="line"><span>To ${esc(f.account.name)}</span>${signed(f.done ? f.txn.amount : f.amount, 'out')}</div>`).join('')}
    <div class="line"><span>Standing orders</span>${signed(run.payday.reduce((t, o) => t + (o.done ? o.txn.amount : o.amount), 0), 'out')}</div>
    </div><div class="sumline"><span>Left after commitments</span><span class="amount ${run.left < 0 ? 'out' : ''}">${money(run.left)}</span></div>
    <p class="small">After your ${money(run.cushion)} cushion: <strong class="amount">${money(run.spare)}</strong> you could use before ${esc(longDate(run.next?.start || run.period.end))}. Annual and irregular costs not in your plan come out of this.</p></div>`;

  const allLabel = run.complete ? 'All done' : !run.ready ? `Available on ${shortDate(run.period.start)}` : sal && !sal.done ? 'Confirm salary first' : `Record all ${run.todo} as shown`;

  return `<header class="topbar"><div><h1>Payday</h1><div class="sub">${esc(longDate(run.period.start))}</div></div>
    <div class="btnrow" style="margin:0;flex-wrap:nowrap">${idx > 0 ? `<a class="iconbtn" href="#/payday/${list[idx - 1].key}" aria-label="Previous payday">${icon('back')}</a>` : ''}${idx < list.length - 1 ? `<a class="iconbtn" href="#/payday/${list[idx + 1].key}" aria-label="Next payday">${icon('back').replace('<svg', '<svg style="transform:rotate(180deg)"')}</a>` : ''}</div></header>
  <div class="paycard"><div class="muted small">${run.complete ? 'Everything is done for this payday.' : `${run.total - run.todo} of ${run.total} done`}</div><div class="progress"><i style="width:${pct}%"></i></div>
    ${!run.ready ? `<p class="small">Preview. You can record things from ${esc(longDate(run.period.start))}.</p>` : ''}</div>
  <section>${salaryStep}${keepStep}${fundSteps}${groupSteps}${holdStep}</section>
  <section>${summary}</section>
  <button class="btn primary block" data-all ${run.complete || !run.ready || (sal && !sal.done) ? 'disabled style="opacity:.5"' : ''}>${esc(allLabel)}</button>
  <p class="muted small" style="margin-top:10px">Each Done records the money as moved on payday. You can undo straight after, or change it later.</p>`;
}

async function paySalary(ctx, run, amount) {
  const today = ctx.today();
  const sal = run.salary;
  let n = 0; const num = () => `${++n}. `;
  try {
    await ctx.dispatch(markPaid(ctx.state, sal.key, { date: sal.date <= today ? sal.date : today, amount }, today), { message: `Salary ${money(amount)} arrived` });
  } catch (err) { toast(err.message, { warn: true }); }
}

function salaryOther(ctx, run) {
  sheet('How much arrived?', `<form novalidate>${field('Salary received (£)', `<input class="big" name="amount" inputmode="decimal" placeholder="0.00" autocomplete="off">`)}
    <p class="muted small">Extra this month (overtime, back pay) counts for this month only. Future paydays still assume ${money(run.salary.expected)}.</p>${errorBox()}
    <div class="btnrow"><button class="btn primary block" type="submit">Save</button></div></form>`, el => {
    const f = el.querySelector('form');
    setTimeout(() => f.amount.focus(), 60);
    f.onsubmit = async e => {
      e.preventDefault();
      const v = parsePounds(f.amount.value);
      if (v === null || v <= 0) { showError(el, new Error('Enter the amount that arrived, for example 3955.00')); return; }
      await paySalary(ctx, run, v);
    };
  });
}

function fundOther(ctx, run, f) {
  sheet(`Moved to ${f.account.name}`, `<form novalidate>${field('Amount moved (£)', `<input class="big" name="amount" inputmode="decimal" value="${esc(penceToInput(f.amount))}">`)}${errorBox()}
    <div class="btnrow"><button class="btn primary block" type="submit">Save</button></div></form>`, el => {
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      const v = parsePounds(e.target.amount.value);
      if (v === null || v <= 0) { showError(el, new Error('Enter the amount you moved.')); return; }
      try { await ctx.dispatch(recordFund(ctx.state, run, f, ctx.today(), v)); } catch (err) { showError(el, err); }
    };
  });
}

export { periodName };
