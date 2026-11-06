// Settings, automatic backup, restoring, and bringing in the Mac records.
import { esc, money, icon, sheet, confirmSheet, toast, relTime } from '../ui.js';
import { parsePounds, penceToInput } from '../money.js';
import { longDate, shortDate, periodName } from '../calendar.js';
import { replay, selfCheck, balances, emptyState, applyEvent } from '../model.js';
import { setSetting, changeRuleFrom } from '../commands.js';
import { planPeriods } from '../plan.js';
import { deriveKey, newSalt, readEnvelope, encryptJSON } from '../crypto.js';
import { checkRepo, versions, download, openBackup } from '../backup.js';
import { validateExport, startChoices, openingBalances, buildImport, verifyImport, START_DATE } from '../importer.js';
import { field, errorBox, showError, accountsList } from './forms.js';

const VERSION = '1.0.0';

// ---- First run ----------------------------------------------------------------
export function renderWelcome(ctx) {
  ctx.afterRender = el => {
    el.querySelector('[data-import]').onchange = e => readImportFile(ctx, e.target.files[0]);
    el.querySelector('[data-restore-gh]').onclick = () => backupSetupSheet(ctx, { restore: true });
    el.querySelector('[data-restore-file]').onchange = e => restoreFromFile(ctx, e.target.files[0]);
  };
  const installed = ctx.standalone;
  return `
  <header class="topbar"><div><h1>Payday</h1><div class="sub">Your money, payday to payday</div></div></header>
  ${installed ? '' : `<div class="banner"><span class="dot">!</span><div><strong>Add Payday to your Home Screen first</strong>
    <p class="small muted">In Safari tap the Share button, then “Add to Home Screen”. Open Payday from its icon and continue there: records saved in a Safari tab are kept separately from the Home Screen app.</p></div></div>`}
  <section class="card"><h2>Bring in my records from the Mac</h2>
    <p class="muted">On the Mac, double-click “Export for iPhone” in the Payday Studio folder. It saves <strong>payday-for-iphone.json</strong> to iCloud Drive. Then choose it here.</p>
    <label class="btn primary block" style="display:grid;place-items:center">Choose the file<input type="file" accept=".json,application/json" data-import class="sr-only"></label></section>
  <section class="card"><h2>Restore from my backup</h2>
    <p class="muted">Use this on a new or reset iPhone, or on the Mac to view your records.</p>
    <div class="btnrow stack"><button class="btn" data-restore-gh>From my GitHub backup</button>
    <label class="btn" style="display:grid;place-items:center">From a backup file<input type="file" accept=".json,application/json" data-restore-file class="sr-only"></label></div></section>`;
}

async function readImportFile(ctx, file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    validateExport(data);
    startCheck(ctx, data);
  } catch (e) { toast(e.message || 'That file could not be read.', { warn: true }); }
}

// The 29 October start-up check.
function startCheck(ctx, data) {
  const ch = startChoices(data);
  const names = Object.fromEntries(data.accounts.map(a => [a.id, a.name]));
  const affected = () => {
    const ids = new Set(['acc-current']);
    for (const s of ch.snapshot) { if (s.from) ids.add(s.from); if (s.to) ids.add(s.to); }
    for (const p of ch.paydayTransfers) { if (p.from) ids.add(p.from); if (p.to) ids.add(p.to); }
    return [...ids].filter(id => data.accounts.find(a => a.id === id && a.tracked && a.opening_4nov != null));
  };
  const draw = () => {
    const opening = openingBalances(data, ch);
    return `
    <p>Payday starts on <strong>payday, ${esc(longDate(START_DATE))}</strong>, before your salary arrived. Your balances were checked against the bank on 4 November. Tell Payday what happened in between, and it works out where you started.</p>
    <section><h2>1. Salary on 29 October</h2>
      <label class="check"><input type="checkbox" data-salary ${ch.salary.received ? 'checked' : ''}><span>My salary of <strong>${money(ch.salary.amount)}</strong> arrived on 29 October</span></label></section>
    <section><h2>2. Payments between 29 October and 4 November</h2>
      <p class="muted small">Payday Studio assumed these had already gone out. Untick any that had not.</p>
      ${ch.snapshot.map((s, i) => `<label class="check"><input type="checkbox" data-snap="${i}" ${s.paid ? 'checked' : ''}><span><strong>${esc(s.name)}</strong> ${money(s.amount)} · ${esc(shortDate(s.date))}${s.inferred_date ? ' <span class="tag warn">date estimated</span>' : ''}<br><span class="muted small">${esc([names[s.from], names[s.to]].filter(Boolean).join(' → '))}</span></span></label>`).join('')}</section>
    <section><h2>3. Payday transfers on 29 October</h2>
      <p class="muted small">These standing orders were never recorded for October. Tick the ones your bank shows on 29 October.</p>
      ${ch.paydayTransfers.map((p, i) => `<label class="check"><input type="checkbox" data-pay="${i}" ${p.moved ? 'checked' : ''}><span><strong>${esc(p.name)}</strong> ${money(p.amount)}<br><span class="muted small">${esc([names[p.from], names[p.to]].filter(Boolean).join(' → '))}</span></span></label>`).join('')}</section>
    <section><h2>4. Your balances on the morning of 29 October</h2>
      <p class="muted small">Worked out from the 4 November balances and your answers above. If a bank statement shows a different figure, type it in: the difference is recorded on 4 November so your checked balances still match.</p>
      <div class="list">${affected().map(id => `<div class="row" style="cursor:default"><div class="main"><div class="title">${esc(names[id])}</div><div class="meta">Worked out: ${money(opening[id])}</div></div>
        <input data-stmt="${id}" inputmode="decimal" placeholder="Statement (optional)" value="${ch.statement[id] != null ? esc(penceToInput(ch.statement[id])) : ''}" style="max-width:170px"></div>`).join('')}</div>
      ${opening['acc-current'] < 0 && ch.statement['acc-current'] == null ? '<p class="small"><span class="tag warn">Check</span> A balance below £0 usually means a payday transfer above happened but is not ticked.</p>' : ''}</section>
    ${errorBox()}
    <div class="btnrow"><button class="btn primary block" data-go>Bring in my records</button></div>`;
  };
  const mount = el => {
    const body = el.querySelector('.sheet-body');
    const wire = () => {
      body.querySelector('[data-salary]').onchange = e => { ch.salary.received = e.target.checked; redraw(); };
      body.querySelectorAll('[data-snap]').forEach(b => b.onchange = () => { ch.snapshot[b.dataset.snap].paid = b.checked; redraw(); });
      body.querySelectorAll('[data-pay]').forEach(b => b.onchange = () => { ch.paydayTransfers[b.dataset.pay].moved = b.checked; redraw(); });
      body.querySelectorAll('[data-stmt]').forEach(b => b.onchange = () => { const v = b.value.trim() ? parsePounds(b.value) : null; if (b.value.trim() && v === null) { toast('Enter an amount like 246.00', { warn: true }); return; } ch.statement[b.dataset.stmt] = v; redraw(); });
      body.querySelector('[data-go]').onclick = () => doImport(ctx, data, ch, el);
    };
    const redraw = () => { const y = el.scrollTop; body.innerHTML = draw(); wire(); el.scrollTop = y; };
    wire();
  };
  sheet('Start-up check: 29 October', draw(), mount);
}

async function doImport(ctx, data, ch, el) {
  try {
    for (const k of Object.keys(ch.statement)) if (ch.statement[k] == null) delete ch.statement[k];
    const { event, unlinked } = buildImport(ctx.state, data, ch);
    const test = emptyState(); applyEvent(test, event);
    const problems = verifyImport(test, data);
    if (problems.length) throw new Error(`Stopped: ${problems.length} balance(s) would not match Payday Studio (${problems.map(p => p.name).join(', ')}). Nothing was saved.`);
    await ctx.dispatch(event, { message: 'Records brought in', undoable: true });
    const n = data.accounts.filter(a => a.tracked && a.v19_value != null).length;
    sheet('Your records are in', `<div class="verdict yes"><strong>All ${n} balances match Payday Studio to the penny</strong>
      <p>${Object.keys(ctx.state.txn).length} transactions and ${Object.keys(ctx.state.rule).length} regular payments, starting on payday 29 October.${unlinked ? ` ${unlinked} older payments could not be matched to a plan date and were kept as plain transactions.` : ''}</p></div>
      <p>Next, set up the automatic backup so a cleared phone never loses anything. Then delete <strong>payday-for-iphone.json</strong> from iCloud Drive: it is not encrypted.</p>
      <div class="btnrow"><button class="btn primary" data-backup>Set up backup now</button><a class="btn" href="#/today" data-close>Later</a></div>`, el2 => {
      el2.querySelector('[data-backup]').onclick = () => backupSetupSheet(ctx);
    });
  } catch (e) { showError(el, e); }
}

// ---- Settings ------------------------------------------------------------------------
export function renderSettings(ctx) {
  const s = ctx.state, today = ctx.today();
  if (!Object.keys(s.account).length) {
    ctx.afterRender = el => { el.querySelector('[data-restore-gh]').onclick = () => backupSetupSheet(ctx, { restore: true }); };
    return `<a class="back" href="#/today">${icon('back')} Back</a><header class="topbar"><h1>Settings</h1></header><button class="btn block" data-restore-gh>Restore from my GitHub backup</button>`;
  }
  const b = ctx.backup, cfg = ctx.meta.backupCfg;
  const problems = selfCheck(s);
  const everyday = s.setting.everydaySpend?.value;
  const list = planPeriods(s);
  const cur = list.find(p => p.start <= today && today <= p.end);
  const prev = cur ? list[list.indexOf(cur) - 1] : null;
  const main = s.setting.mainAccount?.value || 'acc-current';
  const spentPrev = prev ? Object.values(s.txn).filter(t => t.kind === 'spend' && t.from === main && t.date >= prev.start && t.date <= prev.end).reduce((x, t) => x + t.amount, 0) : 0;
  const salary = s.rule['r-salary'];
  ctx.afterRender = el => {
    el.querySelector('[data-setup]')?.addEventListener('click', () => backupSetupSheet(ctx));
    el.querySelector('[data-now]')?.addEventListener('click', () => ctx.backupNow());
    el.querySelector('[data-unlock]')?.addEventListener('click', () => unlockSheet(ctx));
    el.querySelector('[data-versions]')?.addEventListener('click', () => versionsSheet(ctx));
    el.querySelector('[data-keep-phone]')?.addEventListener('click', async () => { if (await confirmSheet('Keep this phone’s copy?', 'The backup on GitHub will be replaced by this phone’s records. GitHub still keeps the older version.', 'Keep this phone’s copy')) ctx.backupNow({ force: true }); });
    el.querySelector('[data-use-backup]')?.addEventListener('click', () => versionsSheet(ctx));
    el.querySelector('[data-file]')?.addEventListener('click', () => saveFile(ctx));
    el.querySelector('[data-restore-file]')?.addEventListener('change', e => restoreFromFile(ctx, e.target.files[0]));
    el.querySelector('[data-off]')?.addEventListener('click', async () => {
      if (!(await confirmSheet('Turn off automatic backup?', 'Your records stay on this phone only. Existing backups on GitHub are not deleted.', 'Turn off', true))) return;
      for (const k of ['backupCfg', 'cryptoKey', 'salt', 'lastBackup']) { await ctx.store.del(k); ctx.meta[k] = null; }
      ctx.key = null; ctx.backup = { status: 'off', message: '', at: null }; ctx.renderSameRoute();
    });
    const sv = async (key, input, label) => {
      const v = parsePounds(input.value);
      if (v === null || v < 0) { toast('Enter an amount like 600.00', { warn: true }); return; }
      await ctx.dispatch(setSetting(ctx.state, key, v, label));
    };
    el.querySelector('[data-everyday]')?.addEventListener('submit', e => { e.preventDefault(); sv('everydaySpend', e.target.amount, 'Changed everyday spending'); });
    el.querySelector('[data-cushion]')?.addEventListener('submit', e => { e.preventDefault(); sv('cushion', e.target.amount, 'Changed cushion'); });
    el.querySelector('[data-comfort]')?.addEventListener('submit', e => { e.preventDefault(); sv('comfortMargin', e.target.amount, 'Changed comfortable margin'); });
    el.querySelector('[data-salary]')?.addEventListener('submit', async e => {
      e.preventDefault();
      const v = parsePounds(e.target.amount.value);
      if (v === null || v <= 0) { toast('Enter your take-home pay, for example 3189.00', { warn: true }); return; }
      await ctx.dispatch(changeRuleFrom(ctx.state, 'r-salary', e.target.from.value, { amount: v }), { message: `Expected salary ${money(v)} from ${shortDate(e.target.from.value)}` });
    });
    el.querySelector('[data-payday]')?.addEventListener('submit', async e => {
      e.preventDefault();
      const key = e.target.period.value, date = e.target.date.value;
      const o = { ...(ctx.state.setting.paydayOverrides?.value || {}) };
      if (date) o[key] = date; else delete o[key];
      await ctx.dispatch(setSetting(ctx.state, 'paydayOverrides', o, date ? `Payday for ${key} moved to ${date}` : `Payday for ${key} back to normal`));
    });
    el.querySelector('[data-theme]')?.addEventListener('change', e => { try { localStorage.setItem('payday-theme', e.target.value); } catch { /* ignore */ } applyTheme(); });
    el.querySelector('[data-erase]')?.addEventListener('click', () => eraseSheet(ctx));
  };
  const statusLine = !cfg ? '<span class="tag bad">Not set up</span> Your records exist only on this phone.'
    : b.status === 'ok' ? `<span class="tag ok">On</span> Backed up ${esc(relTime(b.at))} to <strong>${esc(cfg.owner)}/${esc(cfg.repo)}</strong>.`
    : `<span class="tag ${b.status === 'saving' || b.status === 'waiting' ? 'warn' : 'bad'}">${esc(b.status === 'saving' ? 'Saving' : b.status === 'waiting' ? 'Waiting' : 'Problem')}</span> ${esc(b.message)}`;
  return `<a class="back" href="#/today">${icon('back')} Today</a>
  <header class="topbar"><h1>Settings</h1></header>
  <section class="card"><h2>Automatic backup</h2><p>${statusLine}</p>
    <p class="muted small">Every change is saved on this phone straight away, then an encrypted copy goes to your private GitHub repository a few seconds later. GitHub keeps every earlier version.</p>
    <div class="btnrow">${!cfg ? '<button class="btn primary" data-setup>Set up backup</button>' : b.status === 'conflict' ? '<button class="btn primary" data-keep-phone>Keep this phone’s copy</button><button class="btn" data-use-backup>Use a backup copy</button>' : b.status === 'locked' ? '<button class="btn primary" data-unlock>Enter passphrase</button>' : '<button class="btn" data-now>Back up now</button><button class="btn" data-versions>Restore an earlier version</button>'}</div>
    ${cfg ? '<div class="btnrow"><button class="btn small" data-setup>Change details</button><button class="btn small danger" data-off>Turn off</button></div>' : ''}</section>
  <section class="card"><h2>Backup file</h2><p class="muted small">An encrypted copy you can keep in Files or iCloud Drive, as well as GitHub.</p>
    <div class="btnrow"><button class="btn" data-file ${ctx.key ? '' : 'disabled'}>Save a copy to Files</button>
    <label class="btn" style="display:grid;place-items:center">Restore from a file<input type="file" accept=".json,application/json" data-restore-file class="sr-only"></label></div>
    ${ctx.key ? '' : '<p class="muted small">Set up the backup first: the file uses the same passphrase.</p>'}</section>
  <section class="card"><h2>Everyday spending</h2>
    <p class="muted small">If day-to-day spending comes from a spending allowance account (such as Pocket money), leave this empty: the money moved there each payday already covers it. Otherwise, enter roughly what you spend day to day in a payday period from your main account. ${prev ? `Last period you recorded ${money(spentPrev)} of spending from your current account.` : ''}</p>
    <form data-everyday class="grid2" novalidate>${field('Per payday (£)', `<input name="amount" inputmode="decimal" value="${everyday != null ? esc(penceToInput(everyday)) : ''}" placeholder="Not set">`)}<button class="btn primary" type="submit" style="align-self:end">Save</button></form></section>
  <section class="card"><h2>Cushion</h2><p class="muted small">Money you never count as spendable. Safe-to-spend keeps this back.</p>
    <form data-cushion class="grid2" novalidate>${field('Keep at least (£)', `<input name="amount" inputmode="decimal" value="${esc(penceToInput(s.setting.cushion?.value || 0))}">`)}<button class="btn primary" type="submit" style="align-self:end">Save</button></form></section>
  <section class="card"><h2>Comfortable margin</h2><p class="muted small">“Can I afford it?” says <em>fits, but tight</em> when the lowest point afterwards is less than this above your cushion.</p>
    <form data-comfort class="grid2" novalidate>${field('Margin (£)', `<input name="amount" inputmode="decimal" value="${esc(penceToInput(s.setting.comfortMargin?.value ?? 25000))}">`)}<button class="btn primary" type="submit" style="align-self:end">Save</button></form></section>
  ${salary ? `<section class="card"><h2>Expected salary</h2><p class="muted small">Never counted as money until you confirm it has arrived. Change it for a pay rise or new job.</p>
    <form data-salary novalidate><div class="grid2">${field('Take-home (£)', `<input name="amount" inputmode="decimal" value="${esc(penceToInput(salary.amount))}">`)}${field('From payday', `<select name="from">${list.filter(p => p.end >= today).map(p => `<option value="${p.start}">${esc(periodName(p))}</option>`).join('')}</select>`)}</div>
    <button class="btn primary block" type="submit" style="margin-top:10px">Save</button></form></section>` : ''}
  <section class="card"><h2>Payday moved?</h2><p class="muted small">Payday is the last Thursday of the month, or the working day before if that is a bank holiday (for example 24 December 2030). If your employer pays on another day, set it here.</p>
    <form data-payday novalidate><div class="grid2">${field('Month', `<select name="period">${list.filter(p => p.end >= today).map(p => `<option value="${p.key}">${esc(new Date(p.key + '-15').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }))} (${esc(shortDate(p.start))})</option>`).join('')}</select>`)}
    ${field('Actual payday (empty = normal)', '<input type="date" name="date">')}</div><button class="btn block" type="submit" style="margin-top:10px">Save</button></form></section>
  <section class="card"><h2>Appearance</h2>${field('Theme', `<select data-theme>${['auto', 'dark', 'light'].map(v => `<option value="${v}" ${currentTheme() === v ? 'selected' : ''}>${v === 'auto' ? 'Match my iPhone' : v === 'dark' ? 'Dark' : 'Light'}</option>`).join('')}</select>`)}</section>
  <section class="card"><h2>Record check</h2>
    <p>${problems.length ? `<span class="tag bad">${problems.length} problem${problems.length === 1 ? '' : 's'}</span> ${esc(problems.slice(0, 5).join('. '))}` : `<span class="tag ok">All consistent</span> ${s.events.length} saved changes rebuild exactly the same balances.`}</p>
    <p class="muted small">Storage on this phone: ${ctx.persistence.persisted ? 'kept (iOS will not clear it to save space)' : 'not guaranteed: open Payday from the Home Screen icon'}. ${ctx.standalone ? 'Running from the Home Screen.' : 'Running in a browser tab.'} Version ${VERSION}.</p></section>
  <section class="card"><h2>Start again on this phone</h2><p class="muted small">Erases this phone’s copy only. Your GitHub backups are untouched.</p><button class="btn danger" data-erase>Erase this phone’s copy</button></section>`;
}

export function currentTheme() { try { return localStorage.getItem('payday-theme') || 'auto'; } catch { return 'auto'; } }
export function applyTheme() {
  const t = currentTheme();
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
}

// ---- Backup set-up, unlocking and restoring -------------------------------------------
function backupSetupSheet(ctx, { restore = false } = {}) {
  const cfg = ctx.meta.backupCfg || {};
  sheet(restore ? 'Restore from GitHub' : 'Automatic backup', `<form novalidate>
    <p class="muted small">${restore ? 'Enter the same details you used when you set up the backup.' : 'You need a free GitHub account, a PRIVATE repository (for example “payday-backups”) and an access token that can read and write only that repository. The setup guide walks through it.'}</p>
    ${field('GitHub username', `<input name="owner" autocapitalize="none" autocomplete="username" value="${esc(cfg.owner || '')}">`)}
    ${field('Private repository name', `<input name="repo" autocapitalize="none" value="${esc(cfg.repo || 'payday-backups')}">`)}
    ${field('Access token', '<input name="token" type="password" autocomplete="off" placeholder="github_pat_…">')}
    ${field('Backup passphrase (10+ characters)', '<input name="pass" type="password" autocomplete="new-password">')}
    ${restore ? '' : field('Type the passphrase again', '<input name="pass2" type="password" autocomplete="new-password">')}
    <p class="muted small"><strong>Write the passphrase down</strong> and keep it at home, and save it in Apple Passwords. Without it, no backup can ever be opened, by you or anyone else.</p>
    ${errorBox()}<div class="btnrow"><button class="btn primary block" type="submit">${restore ? 'Find my backup' : 'Turn on backup'}</button></div></form>`, el => {
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      const f = e.target, btn = f.querySelector('[type=submit]');
      try {
        btn.disabled = true; btn.textContent = 'Checking…';
        const next = { owner: f.owner.value.trim(), repo: f.repo.value.trim(), token: f.token.value.trim() || cfg.token };
        if (!next.owner || !next.repo || !next.token) throw new Error('Fill in the username, repository and token.');
        if (!restore && f.pass.value !== f.pass2.value) throw new Error('The two passphrases are different.');
        await checkRepo(next);
        if (restore) {
          const env = await download(next);
          const key = await deriveKey(f.pass.value, env.kdf.salt);
          const events = await openBackup(env, key);
          await saveBackupSettings(ctx, next, env.kdf.salt, key);
          await ctx.replaceAll(events);
          await ctx.saveMeta('lastBackup', { sha: null, at: env.created, seq: env.seq });
          toast(`Restored ${events.length} saved changes from ${new Date(env.created).toLocaleString('en-GB')}`);
          ctx.go('#/today');
          ctx.backupNow({ force: false });
          return;
        }
        const salt = ctx.meta.salt && !f.pass.value ? ctx.meta.salt : newSalt();
        if (!f.pass.value && !ctx.key) throw new Error('Choose a passphrase.');
        const key = f.pass.value ? await deriveKey(f.pass.value, salt) : ctx.key;
        await saveBackupSettings(ctx, next, salt, key);
        await ctx.saveMeta('lastBackup', null);
        el.closest('.sheet-back').remove();
        await ctx.backupNow({ force: true });
        toast(ctx.backup.status === 'ok' ? 'Backup is on. Your first backup is saved.' : ctx.backup.message, { warn: ctx.backup.status !== 'ok' });
        ctx.renderSameRoute();
      } catch (err) { showError(el, err); btn.disabled = false; btn.textContent = restore ? 'Find my backup' : 'Turn on backup'; }
    };
  });
}

async function saveBackupSettings(ctx, cfg, salt, key) {
  await ctx.saveMeta('backupCfg', cfg);
  await ctx.saveMeta('salt', salt);
  ctx.key = key;
  try { await ctx.saveMeta('cryptoKey', key); }  // a locked key the phone can use but never export
  catch { ctx.meta.cryptoKey = null; toast('This phone cannot keep the backup key between launches. You will be asked for the passphrase when Payday opens.', { warn: true }); }
}

function unlockSheet(ctx) {
  sheet('Enter backup passphrase', `<form novalidate>${field('Passphrase', '<input name="pass" type="password" autocomplete="current-password">')}${errorBox()}
    <div class="btnrow"><button class="btn primary block" type="submit">Unlock</button></div></form>`, el => {
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      try {
        const key = await deriveKey(e.target.pass.value, ctx.meta.salt);
        try { const env = await download(ctx.meta.backupCfg); await openBackup(env, key); } catch (err) { if (/passphrase/.test(err.message)) throw err; }
        ctx.key = key;
        try { await ctx.saveMeta('cryptoKey', key); } catch { /* memory only */ }
        el.closest('.sheet-back').remove();
        await ctx.backupNow();
        ctx.renderSameRoute();
      } catch (err) { showError(el, err); }
    };
  });
}

async function versionsSheet(ctx) {
  try {
    const list = await versions(ctx.meta.backupCfg);
    sheet('Restore an earlier version', `<p class="muted small">This replaces what is on this phone with the chosen backup. Your current records are backed up first.</p>
      <div class="list">${list.map((v, i) => `<button class="row" data-ref="${esc(v.ref)}"><div class="main"><div class="title">${esc(new Date(v.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}${i === 0 ? ' <span class="tag ok">Latest</span>' : ''}</div><div class="meta">${esc(v.message)}</div></div></button>`).join('')}</div>`, el => {
      el.querySelectorAll('[data-ref]').forEach(b => b.onclick = async () => {
        if (!(await confirmSheet('Replace this phone’s records?', 'Payday will first back up what is on this phone, so you can come back to it.', 'Restore this version', true))) return;
        try {
          if (ctx.backup.status !== 'conflict') await ctx.backupNow();
          const env = await download(ctx.meta.backupCfg, b.dataset.ref);
          const key = ctx.key || await deriveKey(prompt('Backup passphrase') || '', env.kdf.salt);
          const events = await openBackup(env, key);
          await ctx.replaceAll(events);
          await ctx.saveMeta('lastBackup', null);
          await ctx.backupNow({ force: true });
          toast(`Restored the backup from ${new Date(env.created).toLocaleString('en-GB')}`);
          ctx.go('#/today');
        } catch (err) { toast(err.message, { warn: true }); }
      });
    });
  } catch (err) { toast(err.message, { warn: true }); }
}

async function saveFile(ctx) {
  try {
    const text = await encryptJSON(ctx.key, ctx.meta.salt, { events: ctx.state.events }, { created: new Date().toISOString(), seq: ctx.state.seq });
    const name = `payday-backup-${ctx.today()}.json`;
    const file = new File([text], name, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'Payday backup' }); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (err) { if (err.name !== 'AbortError') toast(err.message, { warn: true }); }
}

async function restoreFromFile(ctx, file) {
  if (!file) return;
  try {
    const env = readEnvelope(await file.text());
    sheet('Restore from a backup file', `<form novalidate><p class="muted small">Backup made ${esc(new Date(env.created).toLocaleString('en-GB'))}. It replaces what is on this phone.</p>
      ${field('Backup passphrase', '<input name="pass" type="password">')}${errorBox()}<div class="btnrow"><button class="btn primary block" type="submit">Restore</button></div></form>`, el => {
      el.querySelector('form').onsubmit = async e => {
        e.preventDefault();
        try {
          const key = await deriveKey(e.target.pass.value, env.kdf.salt);
          const events = await openBackup(env, key);
          if (Object.keys(ctx.state.account).length && !(await confirmSheet('Replace this phone’s records?', 'What is on this phone now will be replaced.', 'Replace', true))) return;
          await ctx.replaceAll(events);
          if (!ctx.meta.salt) { await ctx.saveMeta('salt', env.kdf.salt); ctx.key = key; try { await ctx.saveMeta('cryptoKey', key); } catch { /* memory */ } }
          toast(`Restored ${events.length} saved changes`);
          ctx.go('#/today');
        } catch (err) { showError(el, err); }
      };
    });
  } catch (err) { toast(err.message, { warn: true }); }
}

function eraseSheet(ctx) {
  sheet('Erase this phone’s copy', `<form novalidate><p>${ctx.meta.backupCfg ? 'Your latest changes will be backed up first.' : '<strong>You have no backup.</strong> Everything will be lost.'}</p>
    ${field('Type ERASE to confirm', '<input name="word" autocapitalize="characters">')}${errorBox()}<div class="btnrow"><button class="btn danger block" type="submit">Erase</button></div></form>`, el => {
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      if (e.target.word.value.trim() !== 'ERASE') { showError(el, new Error('Type ERASE in capitals.')); return; }
      if (ctx.meta.backupCfg) await ctx.backupNow();
      await ctx.replaceAll([]);
      for (const k of ['lastBackup']) { await ctx.store.del(k); ctx.meta[k] = null; }
      ctx.go('#/today');
    };
  });
}
export { balances, accountsList, replay };
