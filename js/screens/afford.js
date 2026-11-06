// Afford: "Can I afford it?", goals you are saving for, and plan ideas.
// Nothing here changes your real plan until you choose to add it.
import { esc, money, icon, sheet, lineChart, confirmSheet, toast, chip, signed } from '../ui.js';
import { parsePounds, penceToInput } from '../money.js';
import { longDate, shortDate, periodName, addDays, addMonths } from '../calendar.js';
import { runScenario, mainAccountId } from '../forecast.js';
import { newId, makeEvent, balances } from '../model.js';
import { saveScenario, adoptScenario, saveRule } from '../commands.js';
import { planPeriods } from '../plan.js';
import { assess, comfortOf } from '../afford-engine.js';
import { goalStatus, saveGoal, deleteGoal, addGoalSaving, paydaysBefore } from '../goals.js';
import { roleOf } from '../roles.js';
import { monthLabel } from './plan.js';
import { accountOptions, accountsList, field, errorBox, showError, openOccurrenceSheet } from './forms.js';

let last = null; // last check, kept while you move around the app
let mode = 'once';

export function renderAfford(ctx) {
  const s = ctx.state, today = ctx.today();
  const main = mainAccountId(s);
  const ideas = Object.values(s.scenario).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const goals = Object.values(s.goal || {}).map(g => goalStatus(s, g.id, today)).filter(Boolean);
  const defDate = addDays(today, 30);
  ctx.afterRender = el => {
    el.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { mode = b.dataset.mode; last = null; ctx.renderSameRoute(); });
    const f = el.querySelector('form[data-afford]');
    f.onsubmit = e => {
      e.preventDefault();
      try {
        const amount = parsePounds(f.amount.value);
        if (amount === null || amount <= 0) throw new Error(mode === 'monthly' ? 'Enter the monthly cost, for example 35.00.' : 'Enter what it costs, for example 1500.');
        if (!f.date.value || f.date.value < today) throw new Error('Choose a date from today onwards.');
        const what = f.what.value.trim() || 'This';
        const input = { what, amount, date: f.date.value, from: f.from.value, monthly: mode === 'monthly' };
        last = { what, input, result: assess(ctx.state, input, today) };
        ctx.renderSameRoute();
        document.getElementById('verdict')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } catch (err) { showError(el, err); }
    };
    el.querySelector('[data-add-plan]')?.addEventListener('click', async () => {
      const { what, input } = last;
      const rule = input.monthly
        ? { name: what, kind: 'bill', amount: input.amount, from: input.from, to: null, sched: { type: 'monthly', day: Number(input.date.slice(8)) }, start: input.date, end: null, versions: [], shift: true }
        : { name: what, kind: 'bill', amount: input.amount, from: input.from, to: null, sched: { type: 'once', date: input.date }, start: input.date, end: null, versions: [], shift: false };
      await ctx.dispatch(saveRule(ctx.state, rule), { message: `${what} added to your plan` });
      last = null;
    });
    el.querySelector('[data-make-goal]')?.addEventListener('click', () => openGoalSheet(ctx, null, { name: last.what, instalments: [{ label: 'Payment', amount: last.input.amount, date: last.input.date }], pot: roleOf(ctx.state, ctx.state.account[last.input.from]) === 'savings' ? last.input.from : '' }));
    el.querySelector('[data-save-idea]')?.addEventListener('click', () => saveAsIdea(ctx));
    el.querySelectorAll('[data-try-date]').forEach(b => b.onclick = () => { last.input.date = b.dataset.tryDate; last.result = assess(ctx.state, last.input, today); ctx.renderSameRoute(); });
    el.querySelectorAll('[data-try-amount]').forEach(b => b.onclick = () => { last.input.amount = Number(b.dataset.tryAmount); last.result = assess(ctx.state, last.input, today); ctx.renderSameRoute(); });
    el.querySelectorAll('[data-idea]').forEach(b => b.onclick = () => openIdea(ctx, b.dataset.idea));
    el.querySelector('[data-new-idea]').onclick = () => editIdeaName(ctx, null);
    el.querySelector('[data-new-goal]').onclick = () => openGoalSheet(ctx, null);
  };
  return `
  <header class="topbar"><div><h1>Afford</h1><div class="sub">Try it first. Nothing changes until you choose.</div></div></header>
  <section class="card"><h2>Can I afford it?</h2>
    <div class="seg" role="group" aria-label="Kind of cost"><button type="button" data-mode="once" aria-pressed="${mode === 'once'}">One-off</button><button type="button" data-mode="monthly" aria-pressed="${mode === 'monthly'}">Monthly cost</button></div>
    <form novalidate data-afford>
      ${field('What is it?', `<input name="what" maxlength="60" placeholder="${mode === 'monthly' ? 'e.g. Gym membership' : 'e.g. New laptop'}" value="${esc(last?.what || '')}">`)}
      <div class="grid2">${field(mode === 'monthly' ? 'Each month (£)' : 'Cost (£)', `<input name="amount" inputmode="decimal" placeholder="0.00" value="${last ? (last.input.amount / 100).toFixed(2) : ''}">`)}
      ${field(mode === 'monthly' ? 'First payment' : 'When', `<input type="date" name="date" min="${today}" value="${esc(last?.input.date || defDate)}">`)}</div>
      ${field('Paid from', `<select name="from">${accountOptions(s, last?.input.from || main, { types: ['bank', 'pot'] })}</select>`)}
      ${errorBox()}
      <button class="btn primary block" type="submit" style="margin-top:14px">Check</button>
    </form></section>
  ${last ? verdict(ctx) : ''}
  <section><h2>Goals</h2>
    <p class="muted small">Something you are saving for, paid in one or more instalments. Payday checks every payment date, not just the total.</p>
    ${goals.length ? `<div class="list">${goals.map(g => goalRow(ctx, g)).join('')}</div>` : ''}
    <button class="btn block" data-new-goal style="margin-top:10px">New goal</button></section>
  <section><h2>Plan ideas</h2>
    <p class="muted small">Build a "what if" (a pay rise, cancelling a bill, saving each payday) and see the effect on every payday.</p>
    ${ideas.length ? `<div class="list">${ideas.map(i => `<button class="row" data-idea="${esc(i.id)}"><div class="tile">${icon('afford')}</div><div class="main"><div class="title">${esc(i.name)}</div><div class="meta">${(i.items || []).length + (i.changes || []).length} change${(i.items || []).length + (i.changes || []).length === 1 ? '' : 's'}</div></div></button>`).join('')}</div>` : ''}
    <button class="btn block" data-new-idea style="margin-top:10px">New plan idea</button></section>`;
}

function goalRow(ctx, g) {
  const saved = Math.max(0, g.paid + Math.max(0, g.potNow));
  const pct = g.total ? Math.min(100, Math.round((saved / g.total) * 100)) : 0;
  const status = !g.open.length ? chip('paid', 'Paid') : g.onTrack ? chip('paid', 'On track') : chip('overdue', 'Short');
  return `<a class="row" href="#/goal/${encodeURIComponent(g.goal.id)}" style="flex-wrap:wrap"><div class="main"><div class="title">${esc(g.goal.name)} ${status}</div>
    <div class="meta">${money(g.total)} · ${g.open.length ? `next ${money(g.open[0].remaining || g.open[0].amount)} on ${esc(shortDate(g.open[0].date))}` : 'all paid'}${g.perPayday ? ` · needs ${money(g.perPayday)} more each payday` : ''}</div>
    <div class="goalbar" aria-hidden="true"><i style="width:${pct}%"></i></div></div></a>`;
}

const HEAD = { yes: 'Yes, it fits', tight: 'It fits, but it’s tight', no: 'Not as things stand', 'plan-short': 'Your plan is already short', unknown: 'Can’t tell yet' };
function verdict(ctx) {
  const s = ctx.state, r = last.result, a = s.account[r.input.from];
  const what = esc(last.what);
  const when = r.input.monthly ? `${money(r.input.amount)} a month from ${esc(longDate(r.input.date))}` : `${money(r.input.amount)} on ${esc(longDate(r.input.date))}`;
  const thr = r.threshold ? `your ${money(r.threshold)} ${a.id === mainAccountId(s) ? 'cushion' : 'minimum'}` : '£0';
  let body = '';
  if (r.verdict === 'yes' || r.verdict === 'tight' || r.verdict === 'unknown') {
    body = `<p class="headline">${what}: ${when}.</p>${r.payerLow ? `<div class="figure">${money(r.payerLow.value)}</div>
      <p>The lowest ${esc(a.name)} gets in the following 12 months (${esc(shortDate(r.payerLow.date))}). That is ${money(r.margin)} above ${thr}.</p>` : ''}
      ${r.verdict === 'tight' ? `<p>Less than ${money(comfortOf(s))} to spare. One unexpected bill could tip it.</p>` : ''}
      ${r.verdict === 'unknown' ? `<p><strong>${esc(r.unknown)}</strong></p>` : ''}`;
  } else {
    const ps = r.problems.filter(p => r.verdict === 'plan-short' ? p.already : !p.already);
    body = `<p class="headline">${what}: ${when}.</p>${ps.map(p => `<p>${esc(p.name)} would be <strong>${money(p.short)} short</strong> on ${esc(longDate(p.date))}${p.threshold ? ` (below ${money(p.threshold)})` : ''}.</p>`).join('')}
      ${r.verdict === 'plan-short' ? '<p>That is before this purchase. Look at the Plan tab first.</p>' : ''}`;
  }
  const fx = r.fixes;
  const fixes = fx ? `<div class="card" style="margin-top:10px"><h3>What would make it fit</h3>
    ${fx.save ? `<div class="fix"><span class="n">1</span><div>${fx.save.into ? `Save <strong>${money(fx.save.perPayday)}</strong> more into ${esc(fx.save.into)} on each of the next ${fx.save.paydays} paydays. ${fx.save.ok ? 'Your current account can carry that.' : 'Your current account couldn’t carry that on its own, so something else would need to give.'}` : `Find <strong>${money(fx.save.perPayday)}</strong> each payday for the next ${fx.save.paydays} paydays, for example by reducing a savings transfer for a while.`}</div></div>` : ''}
    ${fx.later ? `<div class="fix"><span class="n">${fx.save ? 2 : 1}</span><div>Wait until <strong>${esc(longDate(fx.later.date))}</strong> (${fx.later.months} month${fx.later.months === 1 ? '' : 's'} later). <button class="btn small" data-try-date="${fx.later.date}">Check that date</button></div></div>` : ''}
    ${fx.maxAmount > 0 ? `<div class="fix"><span class="n">${(fx.save ? 1 : 0) + (fx.later ? 1 : 0) + 1}</span><div>Spend up to <strong>${money(fx.maxAmount)}</strong> on the date you chose. <button class="btn small" data-try-amount="${fx.maxAmount}">Check that amount</button></div></div>` : ''}
  </div>` : '';
  return `<section id="verdict"><div class="verdict ${r.verdict === 'plan-short' ? 'short' : r.verdict}" role="status"><strong>${HEAD[r.verdict]}</strong>${body}</div>
    ${fixes}
    ${r.caveats.length ? `<div class="card" style="margin-top:10px"><h3>This answer assumes</h3><ul class="caveats">${r.caveats.map(c => `<li>${esc(c)}</li>`).join('')}
      <li>Your regular payments and expected salary happen as planned. Overtime is never counted until it arrives.</li></ul></div>` : ''}
    <div class="btnrow">${r.input.monthly ? '' : '<button class="btn" data-make-goal>Make it a goal</button>'}<button class="btn" data-add-plan>Add to plan</button><button class="btn" data-save-idea>Save idea</button></div></section>`;
}

function ideaFromLast(ctx) {
  const { what, input } = last;
  const item = input.monthly ? { id: newId('it'), type: 'monthly', name: what, amount: input.amount, from: input.from, day: Number(input.date.slice(8)), start: input.date }
    : { id: newId('it'), type: 'once', name: what, amount: input.amount, from: input.from, date: input.date };
  return { id: newId('sc'), name: what, items: [item], changes: [] };
}
async function saveAsIdea(ctx) {
  const idea = ideaFromLast(ctx);
  await ctx.dispatch(saveScenario(ctx.state, idea), { message: `Plan idea saved: ${idea.name}` });
  openIdea(ctx, idea.id);
}

// ---- Goals ----------------------------------------------------------------------
export function renderGoal(ctx, id) {
  const s = ctx.state, today = ctx.today();
  const g = goalStatus(s, id, today);
  if (!g) return `<a class="back" href="#/afford">${icon('back')} Afford</a><div class="empty">That goal no longer exists.</div>`;
  const pot = s.account[g.goal.pot];
  const into = Object.values(s.rule).filter(r => !r.deleted && r.to === pot?.id && r.kind === 'transfer' && (!r.end || r.end >= today));
  const lastPay = g.paydays ? paydaysBefore(s, today, g.last) : [];
  ctx.afterRender = el => {
    el.querySelectorAll('[data-occ]').forEach(b => b.onclick = () => openOccurrenceSheet(ctx, b.dataset.occ));
    el.querySelector('[data-edit]').onclick = () => openGoalSheet(ctx, id);
    el.querySelector('[data-del]').onclick = async () => {
      if (!(await confirmSheet('Delete this goal?', 'Its planned payments are removed from your plan. You can undo this.', 'Delete', true))) return;
      await ctx.dispatch(deleteGoal(ctx.state, id)); ctx.go('#/afford');
    };
    el.querySelector('[data-add-saving]')?.addEventListener('click', async () => {
      await ctx.dispatch(addGoalSaving(ctx.state, id, g.perPayday, lastPay[0].start, lastPay[lastPay.length - 1].start), { message: `Added ${money(g.perPayday)} each payday for ${g.goal.name}` });
    });
  };
  const saved = Math.max(0, g.paid + Math.max(0, g.potNow));
  const pct = g.total ? Math.min(100, Math.round((saved / g.total) * 100)) : 0;
  return `<a class="back" href="#/afford">${icon('back')} Afford</a>
  <header class="topbar"><div><h1>${esc(g.goal.name)}</h1><div class="sub">Saved in ${esc(pot?.name || 'a pot')}</div></div><button class="btn small" data-edit>Edit</button></header>
  <div class="card"><div class="kpi"><div class="stat"><span>Total</span><strong class="amount">${money(g.total)}</strong></div><div class="stat"><span>In ${esc(pot?.name || 'pot')} now</span><strong class="amount">${money(g.potNow)}</strong></div></div>
    <div class="goalbar"><i style="width:${pct}%"></i></div><p class="muted small">${money(g.paid)} paid so far${g.open.length ? ` · ${money(g.total - g.paid)} still to pay` : ''}.</p></div>
  ${g.open.length ? `<div class="verdict ${g.onTrack ? 'yes' : 'no'}" style="margin-top:10px"><strong>${g.onTrack ? 'On track' : 'Not on track yet'}</strong>
    ${g.onTrack ? `<p>With the money already going into ${esc(pot?.name || 'the pot')}, every payment is covered on its date.</p>`
      : g.impossible ? `<p>${esc(pot?.name)} will be ${money(g.impossible.short)} short on ${esc(longDate(g.impossible.date))}, and there is no payday before then to save from. Move money in now, or change the date.</p>`
      : `<div class="figure">${money(g.perPayday)}</div><p>more each payday, for ${g.paydays} payday${g.paydays === 1 ? '' : 's'}, covers every payment on its date (biggest gap: ${money(g.worst.short)} on ${esc(longDate(g.worst.date))}).</p>
        <p>${g.carry?.ok ? `Your current account can carry that: its lowest would be ${money(g.carry.low.value)}.` : `Your current account can’t carry that on its own: it would drop to ${money(g.carry?.low?.value)} on ${esc(longDate(g.carry?.low?.date))}. Look at reducing another saving for a while, a later date, or a smaller budget.`}</p>`}</div>
    ${!g.onTrack && !g.impossible && lastPay.length ? `<div class="btnrow"><button class="btn primary" data-add-saving>Add ${money(g.perPayday)} each payday to my plan</button></div>` : ''}` : ''}
  <section><h2>Payments</h2><div class="list">${g.instalments.map(o => {
    const pi = (g.perInstalment || []).find(x => x.key === o.key);
    return `<button class="row" data-occ="${esc(o.key)}"><div class="main"><div class="title">${esc(o.label || o.name.replace(g.goal.name + ': ', ''))}</div>
      <div class="meta">${chip(o.status)} ${esc(longDate(o.date))}${pi && !pi.covered ? ` · pot short by ${money(-pi.potAfter)} that day` : pi ? ' · covered' : ''}</div></div>
      <div class="amount">${money(o.amount)}${o.part ? `<small>${money(o.remaining)} left</small>` : ''}</div></button>`;
  }).join('')}</div><p class="muted small">Tap a payment to mark it paid, in full or in part, or to move its date.</p></section>
  <section><h2>Going into ${esc(pot?.name || 'the pot')}</h2>${into.length ? `<div class="list">${into.map(r => `<div class="row static"><div class="main"><div class="title">${esc(r.name)}</div><div class="meta">${r.sched.type === 'payday' ? 'Each payday' : 'Regular'}${r.end ? ` until ${esc(shortDate(r.end))}` : ''}</div></div>${signed(r.amount, 'in')}</div>`).join('')}</div>` : '<div class="card muted">Nothing goes in regularly.</div>'}</section>
  <div class="btnrow"><button class="btn danger" data-del>Delete goal</button></div>`;
}

export function openGoalSheet(ctx, id, preset = null) {
  const s = ctx.state, today = ctx.today();
  const g = id ? s.goal[id] : null;
  const current = g ? Object.values(s.rule).filter(r => r.goal === id && !r.deleted && r.kind !== 'transfer').sort((a, b) => a.sched.date.localeCompare(b.sched.date))
    .map(r => ({ ruleId: r.id, label: r.label || r.name, amount: r.amount, date: r.sched.date })) : (preset?.instalments || [{ label: 'Deposit', amount: null, date: addDays(today, 30) }]);
  let rows = current.map(r => ({ ...r, key: newId('row') }));
  const oneOffs = Object.values(s.rule).filter(r => !r.deleted && !r.goal && r.sched?.type === 'once' && r.sched.date >= today && r.kind === 'bill');
  const adopt = new Set();
  const pots = accountsList(s, { types: ['pot', 'bank'] }).filter(a => a.tracked !== false);
  const draw = () => `<form novalidate>
    ${field('Goal', `<input name="name" maxlength="60" value="${esc(g?.name || preset?.name || '')}" placeholder="e.g. Lakes holiday">`)}
    ${field('Saved in', `<select name="pot"><option value="">Choose…</option>${pots.map(a => `<option value="${esc(a.id)}" ${(g?.pot || preset?.pot) === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>`)}
    <h3 style="margin-top:18px">Payments</h3><p class="muted small">Each deposit or instalment, with the date it is due.</p>
    <div data-rows>${rows.map(r => `<div class="card" style="padding:10px 12px;margin-top:8px" data-row="${r.key}"><div class="grid2">${field('What', `<input name="label" maxlength="40" value="${esc(r.label || '')}">`)}${field('Amount (£)', `<input name="amount" inputmode="decimal" value="${r.amount ? esc(penceToInput(r.amount)) : ''}">`)}</div>
      <div class="grid2">${field('Due', `<input type="date" name="date" value="${esc(r.date || '')}">`)}<button type="button" class="btn small" data-remove="${r.key}" style="align-self:end">Remove</button></div></div>`).join('')}</div>
    <button type="button" class="btn small" data-addrow style="margin-top:10px">Add a payment</button>
    ${oneOffs.length ? `<h3 style="margin-top:18px">Already in your plan?</h3><p class="muted small">If one of these is part of this goal, mark it so it isn’t counted twice.</p>
      ${oneOffs.map(r => `<div class="toggle"><span>${esc(r.name)} · ${money(r.amount)} · ${esc(shortDate(r.sched.date))}</span><button type="button" data-adopt="${esc(r.id)}" aria-pressed="false">Part of it</button></div>`).join('')}` : ''}
    ${errorBox()}<div class="btnrow"><button class="btn primary block" type="submit">${g ? 'Save goal' : 'Add goal'}</button></div></form>`;
  const read = el => rows.map(r => {
    const box = el.querySelector(`[data-row="${r.key}"]`);
    return { ...r, label: box.querySelector('[name=label]').value.trim(), amount: parsePounds(box.querySelector('[name=amount]').value), date: box.querySelector('[name=date]').value };
  });
  const mount = el => {
    const f = el.querySelector('form');
    el.querySelector('[data-addrow]').onclick = () => { rows = read(el); rows.push({ key: newId('row'), label: rows.length ? 'Balance' : 'Payment', amount: null, date: '' }); keep(el); };
    el.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => { rows = read(el).filter(r => r.key !== b.dataset.remove); keep(el); });
    el.querySelectorAll('[data-adopt]').forEach(b => b.onclick = () => {
      const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on));
      if (on) adopt.add(b.dataset.adopt); else adopt.delete(b.dataset.adopt);
    });
    f.onsubmit = async e => {
      e.preventDefault();
      try {
        const inst = read(el);
        if (inst.some(r => r.amount === null || r.amount <= 0)) throw new Error('Every payment needs an amount.');
        const ev = saveGoal(ctx.state, { id, name: f.name.value, pot: f.pot.value, instalments: inst.map(r => ({ ruleId: r.ruleId, label: r.label, amount: r.amount, date: r.date })), adopt: [...adopt] });
        await ctx.dispatch(ev, { message: `${f.name.value.trim()} saved` });
        ctx.go(`#/goal/${encodeURIComponent(ev.ops.find(o => o.kind === 'goal').key)}`);
      } catch (err) { showError(el, err); }
    };
  };
  const keep = el => {
    const f = el.querySelector('form');
    const name = f.name.value, pot = f.pot.value;
    el.querySelector('.sheet-body').innerHTML = draw();
    const f2 = el.querySelector('form'); f2.name.value = name; f2.pot.value = pot;
    mount(el);
  };
  sheet(g ? 'Edit goal' : 'New goal', draw(), el => mount(el));
}

function editIdeaName(ctx, id) {
  const idea = id ? ctx.state.scenario[id] : null;
  sheet(idea ? 'Rename plan idea' : 'New plan idea', `<form novalidate>${field('Name', `<input name="name" maxlength="60" value="${esc(idea?.name || '')}" placeholder="e.g. Summer holiday 2027">`)}${errorBox()}
    <div class="btnrow"><button class="btn primary" type="submit">${idea ? 'Save' : 'Create'}</button></div></form>`, el => {
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      const name = e.target.name.value.trim();
      if (!name) { showError(el, new Error('Give it a name.')); return; }
      const value = idea ? { ...idea, name } : { id: newId('sc'), name, items: [], changes: [] };
      await ctx.dispatch(saveScenario(ctx.state, value));
      openIdea(ctx, value.id);
    };
  });
}

export function openIdea(ctx, id) {
  const s = ctx.state, idea = s.scenario[id];
  if (!idea) return;
  const today = ctx.today();
  const res = runScenario(s, idea, today);
  const main = res.main;
  const rows = res.rows.filter(r => r.end >= today);
  const chart = lineChart({ labels: rows.map(r => monthLabel(r.start)),
    series: [{ values: rows.map(r => r.base?.low ?? null), cls: 'base' }, { values: rows.map(r => r.alt?.low ?? null), cls: 'alt' }],
    guide: res.cushion, title: 'Lowest current-account balance per payday: plan now versus with this idea' });
  const pots = new Set([...(idea.items || []).flatMap(i => [i.from, i.to])].filter(x => x && x !== main && s.account[x]));
  const potRows = [...pots].map(pid => {
    const neg = res.alt.firstNegative[pid];
    return `<div class="line"><span>${esc(s.account[pid].name)}${neg ? ` <span class="tag bad">below £0 ${esc(shortDate(neg))}</span>` : ''}</span><strong class="amount">${money(res.alt.lowest[pid]?.value)} lowest</strong></div>`;
  }).join('');
  const short = (p) => p ? `${esc(periodName(p))} (${money(p.acc[main].low)})` : 'never';
  const itemText = it => it.type === 'everyday' ? `${esc(it.name)} · ${money(it.amount)} less each payday ${esc(shortDate(it.start))}–${esc(it.end ? shortDate(it.end) : 'on')}` : `${esc(it.name)} · ${money(it.amount)} · ${it.type === 'once' ? esc(longDate(it.date)) : it.type === 'payday' ? `each payday ${esc(shortDate(it.start))}–${esc(it.end ? shortDate(it.end) : 'on')}` : `monthly from ${esc(shortDate(it.start))}`}`;
  const changeText = ch => `${esc(s.rule[ch.ruleId]?.name || 'Payment')}: ${ch.stop ? 'stop' : money(ch.amount)} from ${esc(shortDate(ch.from))}`;
  const body = `
    <div class="chart">${chart}<div class="legend"><span><i class="key"></i>Plan now</span><span><i class="key alt"></i>With this idea</span><span><i class="key line"></i>Cushion</span></div></div>
    <div class="card lines" style="margin-top:12px">
      <div class="line"><span>First dip below your cushion, plan now</span><strong>${short(res.baseShort)}</strong></div>
      <div class="line"><span>With this idea</span><strong>${short(res.altShort)}</strong></div>
      <div class="line"><span>Current account in ${esc(periodName(rows[rows.length - 1]))}</span><strong class="amount">${money(rows[rows.length - 1].alt?.close)} vs ${money(rows[rows.length - 1].base?.close)}</strong></div>
      ${potRows}</div>
    <section><h2>What this idea changes</h2><div class="list">
      ${(idea.items || []).map(it => `<div class="row" style="cursor:default"><div class="main"><div class="title">${itemText(it)}</div></div><button class="btn small" data-del-item="${esc(it.id)}">Remove</button></div>`).join('')}
      ${(idea.changes || []).map(ch => `<div class="row" style="cursor:default"><div class="main"><div class="title">${changeText(ch)}</div></div><button class="btn small" data-del-change="${esc(ch.id)}">Remove</button></div>`).join('')}
      ${!(idea.items || []).length && !(idea.changes || []).length ? '<div class="row muted">Nothing yet. Add something below.</div>' : ''}</div>
      <div class="btnrow"><button class="btn small" data-add="once">One-off cost</button><button class="btn small" data-add="payday">Save each payday</button>
      <button class="btn small" data-add="everyday">Spend less each payday</button><button class="btn small" data-add="monthly">Monthly cost</button><button class="btn small" data-add="change">Change a regular payment</button></div></section>
    <div class="btnrow"><button class="btn primary" data-adopt>Add to my plan</button><button class="btn" data-rename>Rename</button><button class="btn danger" data-delete>Delete idea</button></div>`;
  sheet(idea.name, body, (el, close) => {
    const save = async (next, msg) => { await ctx.dispatch(saveScenario(ctx.state, next), { message: msg }); openIdea(ctx, id); };
    el.querySelectorAll('[data-del-item]').forEach(b => b.onclick = () => save({ ...idea, items: idea.items.filter(i => i.id !== b.dataset.delItem) }, 'Removed from the idea'));
    el.querySelectorAll('[data-del-change]').forEach(b => b.onclick = () => save({ ...idea, changes: idea.changes.filter(i => i.id !== b.dataset.delChange) }, 'Removed from the idea'));
    el.querySelectorAll('[data-add]').forEach(b => b.onclick = () => addToIdea(ctx, idea, b.dataset.add));
    el.querySelector('[data-rename]').onclick = () => editIdeaName(ctx, id);
    el.querySelector('[data-delete]').onclick = async () => {
      if (!(await confirmSheet('Delete this idea?', 'Your real plan is not affected. You can undo this.', 'Delete', true))) return;
      await ctx.dispatch(makeEvent(ctx.state, `Deleted plan idea: ${idea.name}`, [{ op: 'remove', kind: 'scenario', key: id }]));
    };
    el.querySelector('[data-adopt]').onclick = async () => {
      if (!(await confirmSheet('Add this to your plan?', 'The items become real planned payments. You can undo this straight after, or change them in Regular payments.', 'Add to my plan'))) return;
      try { await ctx.dispatch(adoptScenario(ctx.state, idea), { message: `Added to your plan: ${idea.name}` }); } catch (err) { toast(err.message, { warn: true }); }
    };
  });
}

function addToIdea(ctx, idea, type) {
  const s = ctx.state, today = ctx.today(), main = mainAccountId(s);
  const firstPay = planPeriods(s).find(p => p.start > today)?.start || today;
  const forms = {
    once: `${field('What', '<input name="name" maxlength="60">')}<div class="grid2">${field('Cost (£)', '<input name="amount" inputmode="decimal">')}${field('Date', `<input type="date" name="date" value="${addDays(today, 30)}">`)}</div>${field('Paid from', `<select name="from">${accountOptions(s, main)}</select>`)}`,
    payday: `${field('What for', '<input name="name" maxlength="60" placeholder="e.g. Save for holiday">')}${field('Amount each payday (£)', '<input name="amount" inputmode="decimal">')}${field('From', `<select name="from">${accountOptions(s, main)}</select>`)}${field('Into', `<select name="to">${accountOptions(s, '', { none: 'Spent (not saved)' })}</select>`)}<div class="grid2">${field('First payday', `<input type="date" name="start" value="${firstPay}">`)}${field('Last payday (optional)', '<input type="date" name="end">')}</div>`,
    everyday: `${field('Why', '<input name="name" maxlength="60" placeholder="e.g. Saving for holiday">')}${field('Spend this much less each payday (£)', '<input name="amount" inputmode="decimal">')}<div class="grid2">${field('First payday', `<input type="date" name="start" value="${firstPay}">`)}${field('Last payday (optional)', '<input type="date" name="end">')}</div>`,
    monthly: `${field('What', '<input name="name" maxlength="60">')}<div class="grid2">${field('Amount (£)', '<input name="amount" inputmode="decimal">')}${field('Day of month', '<input name="day" inputmode="numeric" value="1">')}</div>${field('Paid from', `<select name="from">${accountOptions(s, main)}</select>`)}<div class="grid2">${field('Starts', `<input type="date" name="start" value="${addMonths(today.slice(0, 7), 1)}-01">`)}${field('Ends (optional)', '<input type="date" name="end">')}</div>`,
    change: `${field('Regular payment', `<select name="rule">${Object.values(s.rule).filter(r => !r.scenario && (!r.end || r.end >= today)).sort((a, b) => a.name.localeCompare(b.name)).map(r => `<option value="${esc(r.id)}">${esc(r.name)} (${money(r.amount)})</option>`).join('')}</select>`)}${field('New amount (£), or leave empty to stop it', '<input name="amount" inputmode="decimal">')}${field('From', `<input type="date" name="from_date" value="${firstPay}">`)}`,
  };
  sheet('Add to the idea', `<form novalidate>${forms[type]}${errorBox()}<div class="btnrow"><button class="btn primary" type="submit">Add</button></div></form>`, el => {
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      const f = e.target;
      try {
        const next = { ...idea, items: [...(idea.items || [])], changes: [...(idea.changes || [])] };
        if (type === 'change') {
          const amount = f.amount.value.trim() ? parsePounds(f.amount.value) : null;
          if (f.amount.value.trim() && (amount === null || amount <= 0)) throw new Error('Enter a valid amount, or leave it empty to stop the payment.');
          next.changes.push({ id: newId('ch'), ruleId: f.rule.value, from: f.from_date.value, ...(amount ? { amount } : { stop: true }) });
        } else {
          const amount = parsePounds(f.amount.value);
          if (amount === null || amount <= 0) throw new Error('Enter the amount.');
          const name = f.name.value.trim();
          if (!name) throw new Error('Give it a name.');
          const it = { id: newId('it'), type, name, amount, ...(f.from ? { from: f.from.value } : {}) };
          if (type === 'everyday') { it.start = f.start.value; it.end = f.end.value || null; }
          if (type === 'once') it.date = f.date.value;
          if (type === 'payday') { it.to = f.to.value || null; it.start = f.start.value; it.end = f.end.value || null; }
          if (type === 'monthly') { it.day = Number(f.day.value) || 1; it.start = f.start.value; it.end = f.end.value || null; }
          next.items.push(it);
        }
        await ctx.dispatch(saveScenario(ctx.state, next), { message: 'Added to the idea' });
        openIdea(ctx, idea.id);
      } catch (err) { showError(el, err); }
    };
  });
}
