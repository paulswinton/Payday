// Payday — app controller: storage, autosave, automatic backup, undo, routing.
import { emptyState, applyEvent, replay, undoEvent, canUndo } from './model.js';
import { openStore, requestPersistence, isStandalone } from './store.js';
import { todayLocal } from './calendar.js';
import { upload } from './backup.js';
import { toast, esc, closeSheet } from './ui.js';
import { renderToday } from './screens/today.js';
import { renderPlan, renderPeriod, renderRules } from './screens/plan.js';
import { renderPayday } from './screens/payday.js';
import { renderMoney, renderAccount, renderHistory } from './screens/money.js';
import { renderSettings, renderWelcome } from './screens/settings.js';
import { openAddSheet } from './screens/forms.js';
import { applyTheme } from './screens/settings.js';

export const VERSION = '1.1.0';

const ctx = {
  state: emptyState(), store: null, meta: {}, key: null,
  backup: { status: 'off', message: 'Automatic backup is not set up yet.', at: null },
  persistence: { persisted: false, supported: false },
  today: () => { if (window.PAYDAY_TEST) { try { const d = localStorage.getItem('payday-test-today'); if (d) return d; } catch { /* ignore */ } } return todayLocal(); },
  go: hash => { if (location.hash === hash) render(); else location.hash = hash; },
  render: () => render(),
};

// Save first, then show. If saving fails, nothing changes on screen.
ctx.dispatch = async (ev, { message = null, undoable = true } = {}) => {
  if (ctx.meta.role === 'viewer') throw new Error('This device is set to view only. Change it in Settings to make changes here.');
  await ctx.store.append(ev);
  applyEvent(ctx.state, ev);
  closeSheet();
  render();
  toast(message || ev.label, undoable ? { undo: () => ctx.undo(ev) } : {});
  scheduleBackup();
  return ev;
};

ctx.undo = async ev => {
  const check = canUndo(ctx.state, ev);
  if (!check.ok) { toast(check.why, { warn: true }); return; }
  const u = undoEvent(ctx.state, ev);
  await ctx.dispatch(u, { message: 'Undone: ' + ev.label.replace(/^Undo: /, '') });
};

ctx.replaceAll = async events => {
  await ctx.store.replaceAll(events);
  ctx.state = replay(events);
  render();
};

ctx.saveMeta = async (key, value) => { ctx.meta[key] = value; await ctx.store.set(key, value); };

// ---- automatic backup ---------------------------------------------------------
let timer = null, running = false, again = false;
function scheduleBackup(delay = 2500) {
  if (!ctx.meta.backupCfg) return;
  clearTimeout(timer);
  timer = setTimeout(runBackup, delay);
}
ctx.backupNow = async (opts = {}) => { clearTimeout(timer); return runBackup(opts); };

async function runBackup({ force = false } = {}) {
  if (window.PAYDAY_TEST) { setBackup('off', 'Test copy: backups are switched off, so your real backup is never touched.'); return; }
  if (!ctx.meta.backupCfg || ctx.meta.role === 'viewer') return;
  if (!ctx.key) { setBackup('locked', 'Enter your backup passphrase in Settings to resume automatic backups.'); return; }
  if (running) { again = true; return; }
  const head = ctx.state.events[ctx.state.events.length - 1];
  if (!force && head && ctx.meta.lastBackup?.seq === head.seq) { setBackup('ok', 'Backed up', ctx.meta.lastBackup.at); return; }
  running = true;
  setBackup('saving', 'Backing up…');
  try {
    const events = [...ctx.state.events];
    const res = await upload(ctx.meta.backupCfg, ctx.key, ctx.meta.salt, events, { knownSha: ctx.meta.lastBackup?.sha || null, force, device: ctx.meta.deviceName || 'iPhone' });
    await ctx.saveMeta('lastBackup', res);
    setBackup('ok', 'Backed up', res.at);
  } catch (e) {
    setBackup(e.conflict ? 'conflict' : e.offline ? 'waiting' : 'error', e.message);
  } finally {
    running = false;
    if (again) { again = false; scheduleBackup(500); }
  }
}
function setBackup(status, message, at = ctx.backup.at) {
  ctx.backup = { status, message, at };
  document.dispatchEvent(new CustomEvent('payday:backup'));
}
window.addEventListener('online', () => scheduleBackup(300));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') ctx.backupNow();
  else checkNewDay();
});
// An iPhone app can sit open in the background for days: redraw when the date moves on.
let shownDay = todayLocal();
function checkNewDay() {
  const d = ctx.today();
  if (d !== shownDay) { shownDay = d; if (ctx.store && !document.querySelector('.sheet-back')) ctx.renderSameRoute(); }
}
setInterval(checkNewDay, 60000);

// ---- routing --------------------------------------------------------------------
const routes = [
  [/^#\/today$/, renderToday, 'today'],
  [/^#\/plan$/, renderPlan, 'plan'],
  [/^#\/period\/([\d-]+)$/, renderPeriod, 'plan'],
  [/^#\/rules$/, renderRules, 'plan'],
  [/^#\/payday$/, renderPayday, 'payday'],
  [/^#\/payday\/([\d-]+)$/, renderPayday, 'payday'],
  [/^#\/money$/, renderMoney, 'money'],
  [/^#\/account\/(.+)$/, renderAccount, 'money'],
  [/^#\/history$/, renderHistory, 'money'],
  [/^#\/settings$/, renderSettings, 'settings'],
];

function hasData() { return Object.keys(ctx.state.account).length > 0; }

export function render() {
  const app = document.getElementById('app');
  const tabbar = document.getElementById('tabbar');
  if (!hasData() && !/^#\/settings/.test(location.hash)) {
    tabbar.hidden = true;
    app.innerHTML = renderWelcome(ctx);
    ctx.afterRender?.(app);
    return;
  }
  tabbar.hidden = false;
  const hash = location.hash || '#/today';
  const match = routes.find(([re]) => re.test(hash)) || routes[0];
  const args = (hash.match(match[0]) || []).slice(1).map(decodeURIComponent);
  ctx.afterRender = null;
  app.innerHTML = match[1](ctx, ...args);
  for (const a of tabbar.querySelectorAll('a[data-tab]')) {
    if (a.dataset.tab === match[2]) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  ctx.afterRender?.(app);
  if (!render.sameRoute) window.scrollTo(0, 0);
}
ctx.renderSameRoute = () => { render.sameRoute = true; render(); render.sameRoute = false; };

async function init() {
  applyTheme();
  try {
    ctx.store = await openStore();
    const events = await ctx.store.events();
    ctx.state = replay(events);
    for (const k of ['backupCfg', 'salt', 'lastBackup', 'role', 'deviceName', 'cryptoKey']) ctx.meta[k] = await ctx.store.get(k);
    ctx.key = ctx.meta.cryptoKey || null;
    if (ctx.meta.backupCfg) setBackup(ctx.key ? 'ok' : 'locked', ctx.key ? 'Backed up' : 'Enter your backup passphrase in Settings to resume automatic backups.', ctx.meta.lastBackup?.at || null);
    ctx.persistence = await requestPersistence();
    ctx.standalone = isStandalone();
  } catch (e) {
    document.getElementById('app').innerHTML = `<div class="card"><h2>Payday could not open its storage</h2><p>${esc(e.message)}</p><p class="muted">If you are in a private browsing window, open Payday from your Home Screen instead.</p></div>`;
    return;
  }
  document.getElementById('tab-add').addEventListener('click', () => openAddSheet(ctx));
  window.addEventListener('hashchange', () => render());
  document.addEventListener('payday:backup', () => { if (/today|settings/.test(location.hash) || !location.hash) ctx.renderSameRoute(); });
  render();
  scheduleBackup(1500);
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) toast('A new version of Payday is ready. Close and reopen the app to use it.', { ms: 12000 });
        });
      });
    }).catch(() => {});
  }
}

window.paydayCtx = ctx; // for diagnostics in tests
init();
export { ctx };
