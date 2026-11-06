// Small UI helpers: escaping, icons, sheets, toasts and the line chart.
import { formatPounds } from './money.js';
import { shortDate } from './calendar.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (p, o) => formatPounds(p, o);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Simple line icons drawn for Payday (24px grid, stroke = currentColor).
const P = {
  today: '<path d="M4 11.5 12 5l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
  plan: '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  afford: '<path d="M4 18 9 12l4 3 7-8"/><path d="M15 7h5v5"/>',
  money: '<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18M16 15h2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  spend: '<path d="M6 7h12l-1 12H7z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
  transfer: '<path d="M5 9h13l-3-3M19 15H6l3 3"/>',
  income: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M5 20h14"/>',
  bill: '<path d="M7 3h10v18l-2.5-1.5L12 21l-2.5-1.5L7 21z"/><path d="M10 8h4M10 12h4"/>',
  adjust: '<path d="M4 20h16M7 16l9-9 2 2-9 9H7z"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18"/>',
  pot: '<path d="M6 9h12v8a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3z"/><path d="M9 9V6h6v3"/>',
  bank: '<path d="M3 10 12 4l9 6M5 10v8M19 10v8M9 10v8M15 10v8M3 20h18"/>',
  undo: '<path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 0 12"/>',
  check: '<path d="m5 12 4 4 10-10"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9a4.5 4.5 0 0 0 1 9z"/>',
  history: '<path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M4 4v4h4M12 8v5l3 2"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
};
export function icon(name, label = '') {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'}>${P[name] || ''}</svg>`;
}

// Bottom sheet. `body` is HTML; `onMount(el, close)` wires behaviour.
export function sheet(title, body, onMount) {
  closeSheet();
  const back = document.createElement('div');
  back.className = 'sheet-back';
  back.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" tabindex="-1" aria-label="${esc(title)}"><div class="grab"></div>
    <header><h2>${esc(title)}</h2><button class="iconbtn" data-close aria-label="Close">${icon('close')}</button></header>
    <div class="sheet-body">${body}</div></div>`;
  document.body.appendChild(back);
  const close = () => { back.remove(); document.body.style.overflow = ''; };
  back.addEventListener('click', e => { if (e.target === back || e.target.closest('[data-close]')) close(); });
  document.body.style.overflow = 'hidden';
  onMount?.(back.querySelector('.sheet'), close);
  // Move focus into the sheet for VoiceOver and keyboards, but never steal it from a field already in use.
  setTimeout(() => {
    if (back.isConnected && !back.contains(document.activeElement)) back.querySelector('.sheet')?.focus({ preventScroll: true });
  }, 50);
  return close;
}
export function closeSheet() { document.querySelector('.sheet-back')?.remove(); document.body.style.overflow = ''; }

let toastTimer = null;
export function toast(message, { undo = null, warn = false, ms = 8000 } = {}) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const el = document.createElement('div');
  el.className = 'toast' + (warn ? ' warn' : '');
  el.setAttribute('role', 'status');
  el.innerHTML = `<div class="msg">${esc(message)}</div>${undo ? '<button type="button">Undo</button>' : ''}`;
  if (undo) el.querySelector('button').onclick = () => { el.remove(); undo(); };
  document.body.appendChild(el);
  toastTimer = setTimeout(() => el.remove(), ms);
}

export function confirmSheet(title, text, yesLabel, danger = false) {
  return new Promise(resolve => {
    const close = sheet(title, `<p>${esc(text)}</p><div class="btnrow"><button class="btn" data-no>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(yesLabel)}</button></div>`, el => {
      el.querySelector('[data-yes]').onclick = () => { close(); resolve(true); };
      el.querySelector('[data-no]').onclick = () => { close(); resolve(false); };
    });
  });
}

// Line chart of balances per payday period. series: [{values:[pence|null], cls}]
export function lineChart({ labels, series, guide = null, height = 180, title = '' }) {
  const all = series.flatMap(s => s.values).filter(v => v != null).concat(guide != null ? [guide, 0] : [0]);
  if (!all.length) return '';
  let lo = Math.min(...all), hi = Math.max(...all);
  if (lo === hi) { lo -= 10000; hi += 10000; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const W = 340, H = height, L = 46, R = 8, T = 10, B = 22;
  const x = i => L + (labels.length < 2 ? 0 : (i * (W - L - R)) / (labels.length - 1));
  const y = v => T + ((hi - v) * (H - T - B)) / (hi - lo);
  const color = { base: 'var(--accent-ink)', alt: 'var(--orange)' };
  const paths = series.map(s => {
    let d = '';
    s.values.forEach((v, i) => { if (v == null) return; d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
    return `<path d="${d}" fill="none" stroke="${color[s.cls] || 'var(--accent-ink)'}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join('');
  const ticks = [hi - pad, (hi + lo) / 2, lo + pad].map(v => `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${esc(compact(v))}</text><line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/>`).join('');
  const zero = lo < 0 && hi > 0 ? `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="var(--red)" stroke-width="1.2"/>` : '';
  const g = guide != null ? `<line x1="${L}" x2="${W - R}" y1="${y(guide)}" y2="${y(guide)}" stroke="var(--faint)" stroke-dasharray="4 4" stroke-width="1.2"/>` : '';
  const step = Math.max(1, Math.ceil(labels.length / 5));
  const xl = labels.map((l, i) => (i % step === 0 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--muted)">${esc(l)}</text>` : '')).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${ticks}${zero}${g}${paths}${xl}</svg>`;
}
function compact(p) {
  const v = p / 100, a = Math.abs(v);
  const s = a >= 1000 ? `£${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k` : `£${Math.round(a)}`;
  return v < 0 ? `−${s}` : s;
}

export function dateLabel(s) { return shortDate(s); }
export function relTime(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

// Money in is green with a plus; money out is red with a minus; a move between your
// own accounts is plain. Words and signs carry the meaning, not colour alone.
export function signed(pence, dir) {
  if (pence === null || pence === undefined) return '—';
  if (pence === 0) return `<span class="amount move">${formatPounds(0)}</span>`;
  if (dir === 'in') return `<span class="amount in">+${formatPounds(Math.abs(pence))}</span>`;
  if (dir === 'out') return `<span class="amount out">−${formatPounds(Math.abs(pence))}</span>`;
  return `<span class="amount move">${formatPounds(pence)}</span>`;
}
const CHIP = { planned: ['due', 'Due'], due: ['due', 'Due'], paid: ['paid', 'Paid'], overdue: ['overdue', 'Overdue'], part: ['part', 'Part paid'], skipped: ['skipped', 'Skipped'], est: ['est', 'Estimate'], now: ['now', 'Now'] };
export function chip(status, text) {
  const [cls, label] = CHIP[status] || ['', status];
  return `<span class="chip ${cls}">${esc(text || label)}</span>`;
}
