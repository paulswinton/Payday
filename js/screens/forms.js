// Sheets for adding and changing things. Every save is undoable.
import { esc, money, sheet, icon, confirmSheet, toast, signed, chip } from '../ui.js';
import { parsePounds, penceToInput } from '../money.js';
import { longDate, shortDate, addDays } from '../calendar.js';
import { history, balances, displayBalance, makeEvent, newId } from '../model.js';
import { addTxn, editTxn, deleteTxn, restoreTxnVersion, markPaid, setOccurrence, saveRule, changeRuleFrom, endRule, checkBalance } from '../commands.js';
import { occurrenceByKey, describeSchedule, settledIndex, allOccurrences } from '../plan.js';
import { ROLES, CATEGORIES, roleOf, categoryOf } from '../roles.js';
import { saveAccount, validateTxn } from '../commands.js';

const TYPE_ORDER = { bank: 0, pot: 1, card: 2 };
export function accountsList(state, { types = ['bank', 'pot', 'card'], includeArchived = false } = {}) {
  return Object.values(state.account)
    .filter(a => types.includes(a.type) && (includeArchived || !a.archived))
    .sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
}
export function accountOptions(state, selected, opts = {}) {
  const none = opts.none ? `<option value="">${esc(opts.none)}</option>` : '';
  const groups = { bank: 'Bank accounts', pot: 'Savings pots', card: 'Credit cards' };
  let html = none;
  for (const type of opts.types || ['bank', 'pot', 'card']) {
    const list = accountsList(state, { types: [type] });
    if (!list.length) continue;
    html += `<optgroup label="${groups[type]}">${list.map(a => `<option value="${esc(a.id)}" ${a.id === selected ? 'selected' : ''}>${esc(a.name)}${a.tracked === false ? ' (not tracked)' : ''}</option>`).join('')}</optgroup>`;
  }
  return html;
}
export const accName = (state, id) => (id ? state.account[id]?.name || 'Unknown account' : '');

export function txnKindIcon(t) {
  return t.kind === 'income' ? 'income' : t.kind === 'transfer' ? 'transfer' : t.kind === 'adjust' ? 'adjust' : t.kind === 'bill' ? 'bill' : 'spend';
}
export function txnLine(state, t) {
  if (t.from && t.to) return `${accName(state, t.from)} → ${accName(state, t.to)}`;
  return accName(state, t.from || t.to);
}
export function txnAmountClass(state, t) {
  if (t.from && t.to) return 'move';
  return t.to ? 'in' : 'out';
}
export function txnAmountText(t) {
  if (t.from && t.to) return money(t.amount);
  return t.to ? money(t.amount, { sign: true }) : money(-t.amount);
}
// Direction from one account's point of view: into it is money in, out of it is money out.
export function txnDir(state, t, accountId = null) {
  if (accountId) return t.to === accountId ? 'in' : 'out';
  if (t.from && t.to) {
    const own = id => state.account[id] && state.account[id].tracked !== false;
    return own(t.from) && own(t.to) ? 'move' : 'out';
  }
  return t.to ? 'in' : 'out';
}
export function txnAmount(state, t, accountId = null) {
  const acc = accountId ? state.account[accountId] : null;
  if (acc?.type === 'card') return t.to === accountId ? `<span class="amount in">${money(t.amount)}<small>repaid</small></span>` : `<span class="amount out">+${money(t.amount)}<small>owed</small></span>`;
  return signed(t.amount, txnDir(state, t, accountId));
}
export function txnTitle(state, t, accountId = null) {
  if (t.kind === 'adjust') return t.desc.startsWith('Bank correction') ? 'Bank correction' : `Correction: ${t.desc}`;
  const toCard = t.to && state.account[t.to]?.type === 'card';
  if (toCard && t.from) return accountId === t.to ? 'Repayment' : `${accName(state, t.to)} repayment`;
  if (accountId && t.from && t.to && /^transfer\b/i.test(t.desc || 'transfer')) return t.to === accountId ? `From ${accName(state, t.from)}` : `To ${accName(state, t.to)}`;
  return t.desc;
}

function field(label, inner) { return `<label class="field"><span>${esc(label)}</span>${inner}</label>`; }
function errorBox() { return '<div class="error" role="alert" hidden></div>'; }
function showError(el, e) { const box = el.querySelector('.error'); box.textContent = e.message || String(e); box.hidden = false; }

// ---- Add a transaction ---------------------------------------------------------
export function openAddSheet(ctx, preset = {}) {
  if (ctx.meta.role === 'viewer') { toast('This device is view only. Change it in Settings.', { warn: true }); return; }
  const s = ctx.state, today = ctx.today();
  let kind = preset.kind || 'spend';
  const main = s.setting.mainAccount?.value || 'acc-current';
  const recent = [...new Set(Object.values(s.txn).filter(t => t.kind === 'spend').sort((a, b) => (b.created || '').localeCompare(a.created || '')).map(t => t.desc))].slice(0, 20);
  const body = `
    <form novalidate>
      <div class="seg" role="group" aria-label="Type">
        <button type="button" data-kind="spend">Spend</button><button type="button" data-kind="transfer">Move money</button><button type="button" data-kind="income">Money in</button>
      </div>
      ${field('Amount (£)', `<input class="big" name="amount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(preset.amount ? penceToInput(preset.amount) : '')}">`)}
      ${field('What was it?', `<input name="desc" list="recent-desc" maxlength="120" autocomplete="off" value="${esc(preset.desc || '')}"><datalist id="recent-desc">${recent.map(d => `<option value="${esc(d)}">`).join('')}</datalist>`)}
      <div data-from>${field('From', `<select name="from">${accountOptions(s, preset.from || main)}</select>`)}</div>
      <div data-to>${field('To', `<select name="to">${accountOptions(s, preset.to || '', { none: 'Choose…' })}</select>`)}</div>
      ${field('Date', `<input type="date" name="date" value="${esc(preset.date || today)}" max="${today}">`)}
      ${field('Note (optional)', `<input name="note" maxlength="300" autocomplete="off">`)}
      ${errorBox()}
      <div class="btnrow"><button class="btn primary block" type="submit">Save</button></div>
    </form>`;
  sheet('Record money', body, (el) => {
    const form = el.querySelector('form');
    const setKind = k => {
      kind = k;
      el.querySelectorAll('[data-kind]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.kind === k)));
      el.querySelector('[data-from]').hidden = k === 'income';
      el.querySelector('[data-to]').hidden = k === 'spend';
      if (k === 'income' && !form.to.value) form.to.value = main;
    };
    el.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => setKind(b.dataset.kind));
    setKind(kind);
    form.onsubmit = async e => {
      e.preventDefault();
      try {
        const amount = parsePounds(form.amount.value);
        if (amount === null || amount <= 0) throw new Error('Enter the amount, for example 12.50.');
        const t = { kind, amount, desc: form.desc.value, date: form.date.value, note: form.note.value.trim(),
          from: kind === 'income' ? null : form.from.value || null, to: kind === 'spend' ? null : form.to.value || null };
        if (kind === 'transfer' && !t.to) throw new Error('Choose where the money went.');
        const twin = Object.values(ctx.state.txn).find(x => x.desc.toLowerCase() === t.desc.trim().toLowerCase() && x.amount === amount && x.date === t.date &&
          Date.now() - new Date(x.created || 0).getTime() < 10 * 60000);
        if (twin && !(await confirmSheet('Save it twice?', `You recorded ${t.desc} for ${money(amount)} on this date a few minutes ago. Is this a second, separate payment?`, 'Yes, save it again'))) return;
        await ctx.dispatch(addTxn(ctx.state, t, ctx.today()), { message: `Saved: ${t.desc.trim()} ${money(amount)}` });
      } catch (err) { showError(el, err); }
    };
  });
}

// ---- A recorded transaction: details, edit, delete, every earlier version -------
export function openTxnSheet(ctx, id, { deletedVersion = null } = {}) {
  const s = ctx.state, t = s.txn[id] || deletedVersion;
  if (!t) return;
  const versions = history(s, 'txn', id);
  const live = !!s.txn[id];
  const body = `
    <div class="card">
      <div class="row" style="padding:0;min-height:0;cursor:default"><div class="tile">${icon(txnKindIcon(t))}</div>
        <div class="main"><div class="title">${esc(t.desc)}</div><div class="meta">${esc(longDate(t.date))} · ${esc(txnLine(s, t))}</div></div>
        ${txnAmount(s, t)}</div>
      ${t.note ? `<p class="muted small">${esc(t.note)}</p>` : ''}
      ${t.occ ? '<p class="muted small">Paid against a planned payment.</p>' : ''}
      ${live ? '' : '<p class="tag bad">Deleted</p>'}
    </div>
    ${live ? `<form novalidate>
      ${field('Amount (£)', `<input name="amount" inputmode="decimal" value="${esc(penceToInput(t.amount))}">`)}
      ${field('Description', `<input name="desc" maxlength="120" value="${esc(t.desc)}">`)}
      ${field('Date', `<input type="date" name="date" value="${esc(t.date)}" max="${ctx.today()}">`)}
      ${t.from ? field('From', `<select name="from">${accountOptions(s, t.from)}</select>`) : ''}
      ${t.to ? field('To', `<select name="to">${accountOptions(s, t.to)}</select>`) : ''}
      ${field('Note', `<input name="note" maxlength="300" value="${esc(t.note || '')}">`)}
      ${errorBox()}
      <div class="btnrow"><button class="btn primary" type="submit">Save changes</button><button class="btn danger" type="button" data-delete>Delete</button></div>
    </form>` : `${errorBox()}<div class="btnrow"><button class="btn primary block" data-restore-last>Bring it back</button></div>`}
    <section><h2>History of this entry</h2><div class="list">${versions.map((v, i) => `
      <div class="row" style="cursor:default"><div class="main"><div class="title">${esc(v.label)}</div>
      <div class="meta">${esc(new Date(v.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}${v.value ? ` · ${money(v.value.amount)} · ${esc(longDate(v.value.date))}` : ''}</div></div>
      ${v.value && i > 0 ? `<button class="btn small" data-version="${i}">Use this</button>` : ''}</div>`).join('')}</div></section>`;
  sheet(live ? 'Transaction' : 'Deleted transaction', body, (el) => {
    const form = el.querySelector('form');
    if (form) form.onsubmit = async e => {
      e.preventDefault();
      try {
        const amount = parsePounds(form.amount.value);
        if (amount === null || amount <= 0) throw new Error('Enter a valid amount.');
        const changes = { amount, desc: form.desc.value, date: form.date.value, note: form.note.value.trim() };
        if (form.from) changes.from = form.from.value;
        if (form.to) changes.to = form.to.value;
        await ctx.dispatch(editTxn(ctx.state, id, changes, ctx.today()), { message: 'Changes saved' });
      } catch (err) { showError(el, err); }
    };
    el.querySelector('[data-delete]')?.addEventListener('click', async () => {
      if (!(await confirmSheet('Delete this transaction?', 'Its effect on your balances is reversed. You can undo this, or bring it back later from History.', 'Delete', true))) return;
      try { await ctx.dispatch(deleteTxn(ctx.state, id), { message: `Deleted: ${t.desc}` }); } catch (err) { toast(err.message, { warn: true }); }
    });
    const restore = async version => {
      try { await ctx.dispatch(restoreTxnVersion(ctx.state, id, version, ctx.today()), { message: `Restored: ${version.desc}` }); } catch (err) { showError(el, err); }
    };
    el.querySelector('[data-restore-last]')?.addEventListener('click', () => restore(versions.find(v => v.value)?.value || versions.find(v => v.prev)?.prev));
    el.querySelectorAll('[data-version]').forEach(b => b.onclick = () => restore(versions[Number(b.dataset.version)].value));
  });
}

// ---- A planned payment: mark paid, skip, change this one, or the rule ----------
export function openOccurrenceSheet(ctx, key) {
  const s = ctx.state, o = occurrenceByKey(s, key);
  if (!o) { toast('That planned payment no longer exists.', { warn: true }); return; }
  const paid = settledIndex(s)[key];
  const today = ctx.today();
  const from = accName(s, o.from), to = accName(s, o.to);
  const body = `
    <div class="card"><div class="title" style="font-weight:700">${esc(o.name)}</div>
      <p class="muted">${esc(longDate(o.date))}${o.undated ? ' · date to confirm' : ''} · ${esc([from, to].filter(Boolean).join(' → '))}</p>
      <p class="amount" style="font-size:28px;font-weight:750;margin:4px 0">${money(o.amount)}</p>
      ${o.variable ? '<p class="tag warn">Amount varies: check your statement</p>' : ''}
      ${o.skipped ? '<p class="tag">Skipped</p>' : ''}${paid ? `<p class="tag ok">Paid ${esc(longDate(paid.date))}</p>` : ''}
    </div>
    ${paid ? `<div class="btnrow"><button class="btn" data-open-paid>Open the payment</button><button class="btn danger" data-unpay>Mark as not paid</button></div>` : `
    <form novalidate data-pay>
      <h2 style="margin-top:18px">${o.kind === 'income' ? 'Has it arrived?' : 'Has it gone out?'}</h2>
      <div class="grid2">${field('Actual amount (£)', `<input name="amount" inputmode="decimal" value="${esc(penceToInput(o.amount))}">`)}
      ${field('Date', `<input type="date" name="date" value="${esc(o.date <= today ? o.date : today)}" max="${today}">`)}</div>
      ${errorBox()}
      <button class="btn primary block" type="submit" style="margin-top:12px">${o.kind === 'income' ? 'Yes, it has arrived' : o.kind === 'transfer' ? 'Yes, it has moved' : 'Yes, it has been paid'}</button>
    </form>
    <div class="btnrow"><button class="btn" data-skip>${o.skipped ? 'Don’t skip' : 'Skip this one'}</button><button class="btn" data-change>Change this one</button></div>`}
    <div class="btnrow"><button class="btn" data-rule>Edit the regular payment</button></div>`;
  sheet(o.kind === 'income' ? 'Expected money in' : 'Planned payment', body, (el, close) => {
    el.querySelector('[data-pay]')?.addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      try {
        const amount = parsePounds(f.amount.value);
        if (amount === null || amount <= 0) throw new Error('Enter the actual amount.');
        await ctx.dispatch(markPaid(ctx.state, key, { date: f.date.value, amount }, today), { message: `${o.name}: ${o.kind === 'income' ? 'received' : 'paid'} ${money(amount)}` });
      } catch (err) { showError(el, err); }
    });
    el.querySelector('[data-skip]')?.addEventListener('click', async () => {
      try { await ctx.dispatch(setOccurrence(ctx.state, key, { skip: o.skipped ? null : true }, `${o.skipped ? 'Restored' : 'Skipped'} ${o.name} on ${o.date}`)); } catch (err) { toast(err.message, { warn: true }); }
    });
    el.querySelector('[data-change]')?.addEventListener('click', () => {
      close();
      sheet('Change this one only', `<form novalidate>${field('Amount (£)', `<input name="amount" inputmode="decimal" value="${esc(penceToInput(o.amount))}">`)}
        ${field('Date', `<input type="date" name="date" value="${esc(o.date)}">`)}${errorBox()}
        <div class="btnrow"><button class="btn primary" type="submit">Save</button></div></form>`, el2 => {
        el2.querySelector('form').onsubmit = async e => {
          e.preventDefault();
          try {
            const amount = parsePounds(e.target.amount.value);
            if (amount === null || amount <= 0) throw new Error('Enter a valid amount.');
            const date = e.target.date.value;
            await ctx.dispatch(setOccurrence(ctx.state, key, { amount: amount === o.amount && !ctx.state.occ[key]?.amount ? null : amount, date: date === o.nominal ? null : date }, `Changed ${o.name} on ${o.nominal}`));
          } catch (err) { showError(el2, err); }
        };
      });
    });
    el.querySelector('[data-rule]')?.addEventListener('click', () => { close(); openRuleSheet(ctx, o.ruleId); });
    el.querySelector('[data-open-paid]')?.addEventListener('click', () => { close(); openTxnSheet(ctx, paid.id); });
    el.querySelector('[data-unpay]')?.addEventListener('click', async () => {
      try { await ctx.dispatch(deleteTxn(ctx.state, paid.id), { message: `${o.name} marked as not paid` }); } catch (err) { toast(err.message, { warn: true }); }
    });
  });
}

// ---- A regular payment ------------------------------------------------------------
export function openRuleSheet(ctx, ruleId = null) {
  const s = ctx.state, r = ruleId ? s.rule[ruleId] : null;
  const today = ctx.today();
  const kindOf = r?.kind || 'bill';
  const sched = r?.sched || { type: 'monthly', day: 1 };
  const body = `<form novalidate>
    ${field('Name', `<input name="name" maxlength="80" value="${esc(r?.name || '')}">`)}
    ${field('Type', `<select name="kind"><option value="bill" ${kindOf === 'bill' ? 'selected' : ''}>Payment out</option><option value="transfer" ${kindOf === 'transfer' ? 'selected' : ''}>Move between my accounts</option><option value="income" ${kindOf === 'income' ? 'selected' : ''}>Money in</option></select>`)}
    ${field('Amount (£)', `<input name="amount" inputmode="decimal" value="${esc(r ? penceToInput(r.amount) : '')}">`)}
    <div data-from>${field('From', `<select name="from">${accountOptions(s, r?.from || s.setting.mainAccount?.value)}</select>`)}</div>
    <div data-to>${field('To', `<select name="to">${accountOptions(s, r?.to || '', { none: 'Choose…' })}</select>`)}</div>
    ${field('When', `<select name="stype">
      <option value="monthly" ${sched.type === 'monthly' ? 'selected' : ''}>Monthly on a date</option>
      <option value="payday" ${sched.type === 'payday' ? 'selected' : ''}>Every payday</option>
      <option value="annual" ${sched.type === 'annual' ? 'selected' : ''}>Once a year</option>
      <option value="once" ${sched.type === 'once' ? 'selected' : ''}>Just once</option>
      <option value="undated" ${sched.type === 'undated' ? 'selected' : ''}>Monthly, date not known yet</option></select>`)}
    <div class="grid2" data-day>${field('Day of month', `<input name="day" inputmode="numeric" value="${esc(sched.day || '')}">`)}<div data-month>${field('Month', `<select name="month">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${sched.month === i + 1 ? 'selected' : ''}>${new Date(Date.UTC(2026, i, 1)).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })}</option>`).join('')}</select>`)}</div></div>
    <div data-date>${field('Date', `<input type="date" name="date" value="${esc(sched.date || today)}">`)}</div>
    <label class="check"><input type="checkbox" name="variable" ${r?.variable ? 'checked' : ''}><span>The amount changes each time (I’ll check the statement)</span></label>
    <div data-cat>${field('What it is', `<select name="category">${['must', 'allowance', 'saving'].map(c => `<option value="${c}" ${(r ? categoryOf(s, r) : 'must') === c ? 'selected' : ''}>${esc(CATEGORIES[c].label)}</option>`).join('')}</select>`)}</div>
    <div class="toggle" data-target><span>Stop when the pot reaches its target<br><small class="muted">Only moves what the pot still needs</small></span><button type="button" data-until aria-pressed="${!!r?.untilTarget}">${r?.untilTarget ? 'On' : 'Off'}</button></div>
    <div data-months><label class="field"><span>Months it doesn’t happen</span></label><div class="monthpick">${['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'].map((m, i) => `<button type="button" data-m="${i + 1}" aria-pressed="${(r?.skipMonths || []).includes(i + 1)}" aria-label="${new Date(Date.UTC(2026, i, 1)).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })}">${m}</button>`).join('')}</div>
      <p class="muted small">For example, accommodation that stops over summer.</p></div>
    ${r ? `${field('Change applies from', `<input type="date" name="from_date" value="${esc(today)}">`)}<p class="muted small">Earlier payments keep their old details.</p>` : field('Starts', `<input type="date" name="start" value="${esc(today)}">`)}
    ${errorBox()}
    <div class="btnrow"><button class="btn primary" type="submit">${r ? 'Save change' : 'Add regular payment'}</button>${r ? '<button class="btn danger" type="button" data-stop>Stop it</button>' : ''}</div>
    ${r ? `<p class="muted small">${esc(describeSchedule(r))}${r.end ? ` · ends ${esc(longDate(r.end))}` : ''}</p>` : ''}
  </form>`;
  sheet(r ? 'Regular payment' : 'New regular payment', body, el => {
    const f = el.querySelector('form');
    const sync = () => {
      el.querySelector('[data-from]').hidden = f.kind.value === 'income';
      el.querySelector('[data-to]').hidden = f.kind.value === 'bill';
      el.querySelector('[data-day]').hidden = !['monthly', 'annual'].includes(f.stype.value);
      el.querySelector('[data-month]').hidden = f.stype.value !== 'annual';
      el.querySelector('[data-date]').hidden = f.stype.value !== 'once';
      el.querySelector('[data-cat]').hidden = f.kind.value === 'income';
      el.querySelector('[data-target]').hidden = f.kind.value !== 'transfer';
      el.querySelector('[data-months]').hidden = !['monthly', 'payday'].includes(f.stype.value);
    };
    const until = el.querySelector('[data-until]');
    until.onclick = () => { const on = until.getAttribute('aria-pressed') !== 'true'; until.setAttribute('aria-pressed', String(on)); until.textContent = on ? 'On' : 'Off'; };
    el.querySelectorAll('[data-m]').forEach(b => b.onclick = () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')));
    f.kind.onchange = sync; f.stype.onchange = sync; sync();
    f.onsubmit = async e => {
      e.preventDefault();
      try {
        const amount = parsePounds(f.amount.value);
        if (amount === null || amount <= 0) throw new Error('Enter the amount.');
        const type = f.stype.value;
        const day = Number(f.day.value);
        if (['monthly', 'annual'].includes(type) && !(day >= 1 && day <= 31)) throw new Error('Enter a day between 1 and 31.');
        const newSched = type === 'monthly' ? { type, day } : type === 'annual' ? { type, day, month: Number(f.month.value) } : type === 'once' ? { type, date: f.date.value } : { type };
        const fields = { name: f.name.value.trim(), kind: f.kind.value, amount, from: f.kind.value === 'income' ? null : f.from.value || null,
          to: f.kind.value === 'bill' ? null : f.to.value || null, sched: newSched, variable: f.variable.checked,
          category: f.kind.value === 'income' ? null : f.category.value, untilTarget: f.kind.value === 'transfer' && until.getAttribute('aria-pressed') === 'true',
          skipMonths: [...el.querySelectorAll('[data-m][aria-pressed="true"]')].map(b => Number(b.dataset.m)) };
        if (!r?.category && fields.category === categoryOf(s, { ...fields, category: null })) fields.category = r?.category ?? null;
        if (!r?.untilTarget && !fields.untilTarget) fields.untilTarget = r?.untilTarget;
        if (!(r?.skipMonths?.length) && !fields.skipMonths.length) fields.skipMonths = r?.skipMonths;
        if (fields.kind === 'transfer' && !fields.to) throw new Error('Choose where the money goes.');
        if (!r) {
          const start = type === 'once' ? f.date.value : f.start.value;
          await ctx.dispatch(saveRule(ctx.state, { ...fields, start, end: null, versions: [], shift: type !== 'payday' && type !== 'once' }), { message: `Added ${fields.name}` });
        } else {
          if (!fields.name) throw new Error('Give it a name.');
          const fromDate = f.from_date.value;
          if (!fromDate) throw new Error('Choose when the change applies from.');
          const set = {};
          for (const k of Object.keys(fields)) if (JSON.stringify(fields[k]) !== JSON.stringify(r[k])) set[k] = fields[k];
          if (!Object.keys(set).length) throw new Error('Nothing has changed.');
          const ev = fromDate <= r.start ? saveRule(ctx.state, { ...r, ...set }) : changeRuleFrom(ctx.state, r.id, fromDate, set);
          await ctx.dispatch(ev, { message: `Changed ${fields.name}` });
        }
      } catch (err) { showError(el, err); }
    };
    el.querySelector('[data-stop]')?.addEventListener('click', () => {
      sheet(`Stop ${r.name}`, `<form novalidate>${field('Last payment on or before', `<input type="date" name="last" value="${esc(today)}">`)}${errorBox()}
        <div class="btnrow"><button class="btn danger" type="submit">Stop it</button></div></form>`, el2 => {
        el2.querySelector('form').onsubmit = async e => {
          e.preventDefault();
          try { await ctx.dispatch(endRule(ctx.state, r.id, e.target.last.value)); } catch (err) { showError(el2, err); }
        };
      });
    });
  });
}

// ---- Confirm: the balance shown matches the bank (one tap, undoable) ------------
export function lastCheckOf(state, id) {
  return Object.values(state.check).filter(c => c.account === id).sort((a, b) => (b.at || b.date).localeCompare(a.at || a.date))[0] || null;
}
export function confirmedBadge(state, id, today) {
  const c = lastCheckOf(state, id);
  if (!c) return '<span class="badge warn">Not confirmed yet</span>';
  const when = c.at ? new Date(c.at) : null;
  const time = when && !c.imported ? ` · ${when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '';
  const days = Math.round((Date.parse(today) - Date.parse(c.date)) / 86400000);
  return `<span class="badge ${days > 14 ? 'warn' : 'ok'}">${days > 14 ? '' : '✓ '}Confirmed ${esc(shortDate(c.date))}${time}</span>`;
}
export async function confirmBalance(ctx, accountId) {
  const s = ctx.state, a = s.account[accountId], today = ctx.today();
  const value = balances(s, today)[accountId];
  const { event } = checkBalance(s, accountId, value, today);
  await ctx.dispatch({ ...event, label: `Confirmed ${a.name}: ${money(displayBalance(a, value))} matches the bank` }, { message: `${a.name} confirmed at ${money(displayBalance(a, value))}` });
}

// ---- Update an account's balance ---------------------------------------------------
// One step: type what the bank shows and save. Anything that was due before today
// and not yet marked is listed first (set to "Gone" by default, because a bank
// balance already includes it), so nothing is counted twice. Whatever difference
// is left is recorded as a dated correction you can see and undo in History.
export function openCheckSheet(ctx, accountId) {
  const s = ctx.state, a = s.account[accountId], today = ctx.today();
  const isCard = a.type === 'card';
  const appValue = balances(s, today)[accountId];
  const due = allOccurrences(s, s.setting.startDate?.value || today, today, today)
    .filter(o => (o.status === 'overdue' || (o.status === 'planned' && o.date <= today) || o.status === 'part') && (o.from === accountId || o.to === accountId))
    .map(o => ({ ...o, amt: o.remaining || o.amount, gone: true }));
  const effect = o => (o.to === accountId ? o.amt : -o.amt);
  const body = `<form novalidate>
    <p class="muted">Payday has <strong>${money(displayBalance(a, appValue))}</strong>${isCard ? ' owed' : ''}. What does ${isCard ? 'your card app say you owe' : 'your bank app show'} now?</p>
    ${field(isCard ? 'Amount owed (£)' : 'Balance in the bank (£)', `<input class="big" name="bank" inputmode="decimal" autocomplete="off" placeholder="0.00">`)}
    ${due.length ? `<h3 style="margin-top:18px">Due before today, not yet marked</h3><p class="muted small">Your bank figure already includes anything that has gone. Set each one.</p>
      ${due.map((o, i) => `<div class="toggle"><span>${esc(o.name)}<br><small class="muted">${esc(shortDate(o.date))} · ${money(o.amt)}</small></span><button type="button" data-due="${i}" aria-pressed="true">${o.to === accountId ? 'Arrived' : 'Gone'}</button></div>`).join('')}` : ''}
    <div class="diffbox" data-diff hidden></div>
    ${field('Note (optional)', `<input name="reason" maxlength="100" placeholder="e.g. Cash withdrawal">`)}
    ${errorBox()}<div class="btnrow"><button class="btn primary block" type="submit">Correct balance</button></div>
    <p class="muted small">Saved as a dated correction, so the history still adds up. You can undo it straight after, or later from History.</p></form>`;
  sheet(`Correct ${a.name}`, body, el => {
    const f = el.querySelector('form');
    setTimeout(() => f.bank.focus(), 80);
    const show = () => {
      const box = el.querySelector('[data-diff]');
      const shown = parsePounds(f.bank.value);
      if (shown === null) { box.hidden = true; return; }
      const value = isCard ? -shown : shown;
      const after = appValue + due.filter(o => o.gone).reduce((t, o) => t + effect(o), 0);
      const diff = value - after;
      box.hidden = false;
      box.className = 'diffbox' + (diff === 0 ? ' ok' : '');
      box.innerHTML = diff === 0 ? '<strong>Matches.</strong> Nothing else to correct.'
        : `<span class="small">After the payments above, Payday would have ${money(displayBalance(a, after))}. A correction of <strong>${money(Math.abs(isCard ? -diff : diff))} ${(isCard ? -diff : diff) > 0 ? 'more' : 'less'}</strong> will be recorded.</span>`;
    };
    f.bank.oninput = show;
    el.querySelectorAll('[data-due]').forEach(b => b.onclick = () => {
      const o = due[Number(b.dataset.due)];
      o.gone = !o.gone;
      b.setAttribute('aria-pressed', String(o.gone));
      b.textContent = o.gone ? (o.to === accountId ? 'Arrived' : 'Gone') : 'Not yet';
      show();
    });
    f.onsubmit = async e => {
      e.preventDefault();
      try {
        const shown = parsePounds(f.bank.value);
        if (shown === null) throw new Error('Enter the figure your bank shows, for example 310.00 or -25.00.');
        const value = isCard ? -shown : shown;
        const now = new Date().toISOString();
        const changes = [];
        let after = appValue;
        for (const o of due.filter(x => x.gone)) {
          const kind = o.kind === 'income' ? 'income' : o.kind === 'transfer' ? 'transfer' : 'bill';
          const t = { id: newId('tx'), created: now, kind, amount: o.amt, date: o.date, from: o.from || null, to: o.to || null, desc: o.name, note: 'Marked when updating the balance', occ: o.key };
          validateTxn(ctx.state, t, today);
          changes.push({ kind: 'txn', key: t.id, value: t });
          after += effect(o);
        }
        const diff = value - after;
        const reason = f.reason.value.trim();
        if (diff !== 0) {
          const t = { id: newId('tx'), created: now, kind: 'adjust', amount: Math.abs(diff), date: today, from: diff < 0 ? accountId : null, to: diff > 0 ? accountId : null,
            desc: reason ? `Bank correction: ${reason}` : `Bank correction: ${a.name}`, reason, note: `Balance updated to ${money(shown)} from the bank`, occ: null };
          changes.push({ kind: 'txn', key: t.id, value: t });
        }
        changes.push({ kind: 'check', key: newId('chk'), value: { account: accountId, date: today, bank: value, app: after, at: now } });
        await ctx.dispatch(makeEvent(ctx.state, `Updated ${a.name} to ${money(shown)}`, changes), { message: `${a.name} is now ${money(shown)}` });
      } catch (err) { showError(el, err); }
    };
  });
}

// ---- What an account is for -----------------------------------------------------------
export function openAccountSettings(ctx, accountId) {
  const s = ctx.state, a = s.account[accountId];
  const role = roleOf(s, a);
  const roles = Object.entries(ROLES).filter(([k]) => k !== 'main' || role === 'main');
  sheet(`${a.name}: settings`, `<form novalidate>
    ${field('Name', `<input name="name" maxlength="60" value="${esc(a.name)}">`)}
    ${field('What it is for', `<select name="role">${roles.map(([k, v]) => `<option value="${k}" ${k === role ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select>`)}
    <p class="muted small" data-help>${esc(ROLES[role]?.help || '')}</p>
    <div data-bills>${field('Keep this much spare in it (£)', `<input name="buffer" inputmode="decimal" value="${esc(penceToInput(a.buffer || 0))}">`)}
      <p class="muted small">Payday adds this on top of what the direct debits need when it works out the payday top-up. Protects you from a payment that is a little higher than expected.</p></div>
    <div data-pot>${field('Target (£, optional)', `<input name="target" inputmode="decimal" value="${a.target != null ? esc(penceToInput(a.target)) : ''}" placeholder="None">`)}
      ${field('Never plan below (£)', `<input name="floor" inputmode="decimal" value="${esc(penceToInput(a.floor || 0))}">`)}
      <p class="muted small">"Can I afford it?" says no to anything that would take this account below this figure, e.g. a £1,000 emergency fund.</p></div>
    ${errorBox()}<div class="btnrow"><button class="btn primary block" type="submit">Save</button></div></form>`, el => {
    const f = el.querySelector('form');
    const sync = () => {
      el.querySelector('[data-help]').textContent = ROLES[f.role.value]?.help || '';
      el.querySelector('[data-bills]').hidden = f.role.value !== 'bills';
      el.querySelector('[data-pot]').hidden = !['savings', 'holding', 'allowance', 'other'].includes(f.role.value);
    };
    f.role.onchange = sync; sync();
    f.onsubmit = async e => {
      e.preventDefault();
      try {
        const num = (v, allowEmpty) => { if (allowEmpty && !v.trim()) return null; const x = parsePounds(v || '0'); if (x === null || x < 0) throw new Error('Enter amounts like 1000.00'); return x; };
        const next = { ...a, name: f.name.value.trim(), buffer: num(f.buffer.value), target: num(f.target.value, true), floor: num(f.floor.value) };
        if (f.role.value !== role || a.role) next.role = f.role.value;
        await ctx.dispatch(saveAccount(ctx.state, next), { message: `${next.name} saved` });
      } catch (err) { showError(el, err); }
    };
  });
}
export { field, errorBox, showError, addDays };
