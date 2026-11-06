// Money is always integer pence. Text is parsed by pattern, never by float maths.
export function parsePounds(text) {
  if (typeof text === 'number') {
    if (!Number.isFinite(text)) return null;
    text = text.toFixed(2);
  }
  const clean = String(text ?? '').trim().replace(/^£/, '').replace(/,/g, '');
  const m = /^(-)?(\d{1,9})(?:\.(\d{1,2}))?$/.exec(clean);
  if (!m) return null;
  const pence = Number(m[2]) * 100 + Number((m[3] || '').padEnd(2, '0'));
  return m[1] ? -pence : pence;
}

export function formatPounds(pence, { sign = false, blankZero = false } = {}) {
  if (pence === null || pence === undefined || Number.isNaN(pence)) return '—';
  if (blankZero && pence === 0) return '£0';
  const neg = pence < 0;
  const abs = Math.abs(Math.round(pence));
  const pounds = Math.floor(abs / 100).toLocaleString('en-GB');
  const p = String(abs % 100).padStart(2, '0');
  const body = `£${pounds}.${p}`;
  if (neg) return `−${body}`;
  return sign && pence > 0 ? `+${body}` : body;
}

export function penceToInput(pence) {
  if (pence === null || pence === undefined) return '';
  const neg = pence < 0, abs = Math.abs(pence);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function sum(list, f = x => x) {
  return list.reduce((a, x) => a + f(x), 0);
}
