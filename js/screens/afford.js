// Afford: "Can I afford it?" and plan ideas you can try without changing anything.
import { esc, money, icon, sheet, lineChart, confirmSheet, toast } from '../ui.js';
import { parsePounds } from '../money.js';
import { longDate, shortDate, periodName, addDays, addMonths } from '../calendar.js';
import { canAfford, runScenario, mainAccountId } from '../forecast.js';
import { newId, makeEvent } from '../model.js';
import { saveScenario, adoptScenario, saveRule } from '../commands.js';
import { planPeriods } from '../plan.js';
import { monthLabel } from './plan.js';
import { accountOptions, field, errorBox, showError } from './forms.js';

let last = null; // last quick check, kept while you move around the app

export function renderAfford(ctx) {
  const s = ctx.state, today = ctx.today();
  const main = mainAccountId(s);
  const ideas = Object.values(s.scenario).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const defDate = addDays(today, 30);
  ctx.afterRender = el => {
    const f = el.querySelector('form[data-afford]');
    f.onsubmit = e => {
      e.preventDefault();
      try {
        const amount = parsePounds(f.amount.value);
        if (amount === null || amount <= 0) throw new Error('Enter what it costs, for example 1500.');
        if (!f.date.value || f.date.value < today) throw new Error('Choose a date from today onwards.');
        const what = f.what.value.trim() || 'This';
        last = { what, input: { amount, date: f.date.value, from: f.from.value }, result: canAfford(ctx.state, { today, amount, date: f.date.value, from: f.from.value }) };
        ctx.renderSameRoute();
        document.getElementById('verdict')?.scrollIntoView({ block: 'start' });
      } catch (err) { showError(el, err); }
    };
    el.querySelector('[data-try]')?.addEventListener('click', () => tryPlan(ctx));
    el.querySelector('[data-add-plan]')?.addEventListener('click', async () => {
      const { what, input } = last;
      await ctx.dispatch(saveRule(ctx.state, { name: what, kind: 'bill', amount: input.amount, from: input.from, to: null, sched: { type: 'once', date: input.date }, start: input.date, end: null, versions: [], shift: false }), { message: `${what} added to your plan` });
    });
    el.querySelector('[data-save-idea]')?.addEventListener('click', () => saveAsIdea(ctx));
    el.querySelectorAll('[data-idea]').forEach(b => b.onclick = () => openIdea(ctx, b.dataset.idea));
    el.querySelector('[data-new-idea]').onclick = () => editIdeaName(ctx, null);
  };
  return `
  <header class="topbar"><div><h1>Afford</h1><div class="sub">Try it here first. Nothing changes until you choose.</div></div></header>
  <section class="card"><h2>Can I afford it?</h2>
    <form novalidate data-afford>
      ${field('What is it?', `<input name="what" maxlength="60" placeholder="e.g. Holiday in Spain" value="${esc(last?.what || '')}">`)}
      <div class="grid2">${field('Cost (£)', `<input name="amount" inputmode="decimal" placeholder="0.00" value="${last ? (last.input.amount / 100).toFixed(2) : ''}">`)}
      ${field('When', `<input type="date" name="date" min="${today}" value="${esc(last?.input.date || defDate)}">`)}</div>
      ${field('Paid from', `<select name="from">${accountOptions(s, last?.input.from || main)}</select>`)}
      ${errorBox()}
      <button class="btn primary block" type="submit" style="margin-top:14px">Check</button>
    </form></section>
  ${last ? verdict(ctx) : ''}
  <section><h2>Plan ideas</h2>
    <p class="muted small">Build a "what if" (a holiday, saving each payday, a pay rise, cancelling a bill) and see the effect on every payday to 2031.</p>
    ${ideas.length ? `<div class="list">${ideas.map(i => `<button class="row" data-idea="${esc(i.id)}"><div class="tile">${icon('afford')}</div><div class="main"><div class="title">${esc(i.name)}</div><div class="meta">${(i.items || []).length + (i.changes || []).length} change${(i.items || []).length + (i.changes || []).length === 1 ? '' : 's'}</div></div></button>`).join('')}</div>` : ''}
    <button class="btn block" data-new-idea style="margin-top:10px">New plan idea</button></section>`;
}

function verdict(ctx) {
  const s = ctx.state, r = last.result, a = s.account[r.from];
  const what = esc(last.what);
  const thresholdText = r.threshold ? `your ${money(r.threshold)} cushion` : '£0';
  let cls, head, text;
  if (r.verdict === 'yes') {
    cls = 'yes'; head = 'Yes, it fits';
    text = `${what} for ${money(r.amount)} on ${esc(longDate(r.date))}. Afterwards, the lowest ${esc(a.name)} gets in the following 12 months is ${money(r.lowWith.value)} (${esc(shortDate(r.lowWith.date))}), which is ${money(r.margin)} above ${thresholdText}.`;
  } else if (r.verdict === 'no') {
    cls = 'no'; head = 'Not as things stand';
    text = `${esc(a.name)} would go ${money(r.short)} below ${thresholdText}, lowest on ${esc(longDate(r.lowWith.date))}.` +
      (r.perPayday ? ` Put aside <strong>${money(r.perPayday)}</strong> on each of the ${r.paydays} paydays before then and it fits.` : ' There is no payday before then to save from.');
  } else {
    cls = 'short'; head = 'Your plan is already short';
    text = `Even without ${what}, ${esc(a.name)} drops below ${thresholdText} on ${esc(longDate(r.lowBase.date))} (lowest ${money(r.lowBase.value)}). Sort that out first: see the Plan tab.`;
  }
  return `<section id="verdict"><div class="verdict ${cls}" role="status"><strong>${head}</strong><p>${text}</p></div>
    <div class="btnrow">${r.verdict === 'no' && r.perPayday ? '<button class="btn primary" data-try>Try the saving plan</button>' : ''}
    <button class="btn" data-save-idea>Save as a plan idea</button><button class="btn" data-add-plan>Add to my plan</button></div>
    <p class="muted small">Checked from ${esc(longDate(r.date))} to ${esc(longDate(r.windowEnd))} using your regular payments, expected salary${s.setting.everydaySpend?.value != null ? ` and ${money(s.setting.everydaySpend.value)} everyday spending each payday` : ''}.</p>
    ${s.setting.everydaySpend?.value == null ? '<div class="banner"><span class="dot">!</span><div><strong>Everyday spending is not set</strong><p class="small muted">Until it is, the forecast assumes you spend nothing day to day, so this answer is too optimistic.</p><a class="btn small" href="#/settings">Set it</a></div></div>' : ''}</section>`;
}

function ideaFromLast(ctx, withSaving) {
  const s = ctx.state, { what, input, result } = last, today = ctx.today();
  const main = mainAccountId(s);
  const items = [{ id: newId('it'), type: 'once', name: what, amount: input.amount, from: input.from, date: input.date }];
  if (withSaving && result.perPayday) {
    const firstPay = planPeriods(s).find(p => p.start > today);
    const lastPay = [...planPeriods(s)].reverse().find(p => p.start <= input.date);
    // Saving means spending less day to day; if it comes from a pot, move it there each payday.
    items.push({ id: newId('it'), type: 'everyday', name: `Spend less for ${what}`, amount: result.perPayday, start: firstPay.start, end: lastPay.start });
    if (input.from !== main) items.push({ id: newId('it'), type: 'payday', name: `Save for ${what}`, amount: result.perPayday, from: main, to: input.from, start: firstPay.start, end: lastPay.start });
  }
  return { id: newId('sc'), name: what, items, changes: [] };
}
async function tryPlan(ctx) {
  const idea = ideaFromLast(ctx, true);
  await ctx.dispatch(saveScenario(ctx.state, idea), { message: `Plan idea saved: ${idea.name}` });
  openIdea(ctx, idea.id);
}
async function saveAsIdea(ctx) {
  const idea = ideaFromLast(ctx, false);
  await ctx.dispatch(saveScenario(ctx.state, idea), { message: `Plan idea saved: ${idea.name}` });
  openIdea(ctx, idea.id);
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
