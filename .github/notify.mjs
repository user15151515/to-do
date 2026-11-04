// Sends the push notifications of Semestre. Runs every few minutes from GitHub Actions.
// Needs one secret, PUSH_KEY: the private VAPID key. It also decrypts the board codes the app registers.
import webpush from 'web-push';
import crypto from 'node:crypto';

const PUB = 'BM3ij87p5-xgw6B6LjdSPAcXmVXG0BLBg37Ov0ieBbal6Gr2qa3uIjJ86DHC7nW1GkortHaI3_JXr-vmljuW01Q';
const KEY = process.env.PUSH_KEY;
const API = 'AIzaSyDI5TNe9PeTHGjraciRTb-zqsxFzwz1wlQ';
const BASE = 'https://firestore.googleapis.com/v1/projects/to-do-d35e2/databases/(default)/documents/boards/';
const REGISTRY = 'semestre_push_registry_v1';
const APP_URL = 'https://user15151515.github.io/to-do/';
const DRY = process.env.DRY_RUN === '1';
const NOW = +(process.env.NOW || Date.now());
const MAX_LATE = 6 * 3600e3;          // do not send reminders that are more than 6 h late
const FIRST_LOOKBACK = 20 * 60e3;     // on the first run, look 20 minutes back

/* ---------- Firestore REST ---------- */
const val = v => v == null ? undefined : 'stringValue' in v ? v.stringValue : 'integerValue' in v ? +v.integerValue : 'doubleValue' in v ? v.doubleValue
  : 'booleanValue' in v ? v.booleanValue : 'nullValue' in v ? null : 'mapValue' in v ? obj(v.mapValue.fields || {}) : 'arrayValue' in v ? (v.arrayValue.values || []).map(val) : undefined;
const obj = f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, val(v)]));
async function getDoc(id){
  const r = await fetch(BASE + id + '?key=' + API);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('GET ' + r.status + ' ' + await r.text());
  return obj((await r.json()).fields || {});
}
async function patchDoc(id, fields, mask){
  const q = mask.map(m => 'updateMask.fieldPaths=' + encodeURIComponent(m)).join('&');
  const r = await fetch(BASE + id + '?key=' + API + '&' + q, { method:'PATCH', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ fields }) });
  if (!r.ok) throw new Error('PATCH ' + r.status + ' ' + await r.text());
}

/* ---------- board codes: encrypted by the app with ECDH (P-256, the VAPID key) + AES-GCM ---------- */
const b64u = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function decryptCode(entry){
  const { e, iv, c } = JSON.parse(entry);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.setPrivateKey(b64u(KEY));
  const key = crypto.createHash('sha256').update(ecdh.computeSecret(b64u(e))).digest();
  const raw = b64u(c), tag = raw.subarray(raw.length - 16), data = raw.subarray(0, raw.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, b64u(iv)); d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

/* ---------- dates in the user's time zone ---------- */
function tzOffset(ts, tz){
  const p = new Intl.DateTimeFormat('en-US', { timeZone:tz, hourCycle:'h23', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' }).formatToParts(new Date(ts));
  const g = t => +p.find(x => x.type === t).value;
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - ts;
}
function at(date, time, tz){          // 'YYYY-MM-DD', 'HH:MM' local -> epoch ms
  const [y, m, d] = date.split('-').map(Number), [hh, mm] = (time || '09:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffset(guess, tz);
  return guess - tzOffset(t, tz);
}
function localDate(ts, tz){ return new Intl.DateTimeFormat('en-CA', { timeZone:tz, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(ts)); }
function addDays(date, n){ const [y, m, d] = date.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); }
const daysBetween = (a, b) => Math.round((Date.UTC(...b.split('-').map((x, i) => i === 1 ? x - 1 : +x)) - Date.UTC(...a.split('-').map((x, i) => i === 1 ? x - 1 : +x))) / 864e5);
const rel = n => n === 0 ? 'Hoy' : n === 1 ? 'Mañana' : n > 1 ? `En ${n} días` : n === -1 ? 'Ayer' : `Hace ${-n} días`;
function repeats(r, date){
  if (!r) return false;
  if (r.days && r.days.length) { const [y, m, d] = date.split('-').map(Number); return r.days.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay()); }
  if (r.every) { const n = daysBetween(r.from || date, date); return n >= 0 && n % r.every === 0; }
  return false;
}

/* ---------- what to send between "since" and "now" ---------- */
export function due(board, since, now){
  const notif = board.notif || {}, tz = notif.tz || 'Europe/Madrid', out = [];
  const subjects = (() => { try { return JSON.parse(board.subjects || '[]'); } catch(e){ return []; } })();
  const papers = Object.values(board.p || {}).map(j => { try { return JSON.parse(j); } catch(e){ return null; } }).filter(Boolean);
  const inWin = t => t > since && t <= now && now - t < MAX_LATE;
  const name = p => (p.title || '').trim() || subjects.find(s => s.id === p.subject)?.name || 'Papel';
  const days = [...new Set([localDate(since, tz), localDate(now, tz)])];   // local dates covered by the window
  const add = (key, t, title, body) => out.push({ key, at:t, title, body });

  for (const p of papers) {
    const pending = (p.items || []).filter(x => !x.done).length, total = (p.items || []).length;
    const finished = total > 0 && pending === 0;
    if (p.date && !finished) {
      for (const r of p.rem || []) {
        const day = addDays(p.date, -(r.d || 0)), t = at(day, r.t, tz);
        if (inWin(t)) add(`p:${p.id}:${r.d}:${r.t}`, t, name(p), `${rel(r.d || 0)}${total ? ` · ${pending} pendiente${pending === 1 ? '' : 's'}` : ''}`);
      }
      if (notif.dates) {
        const t = at(addDays(p.date, -1), notif.datesTime || '19:00', tz);
        if (inWin(t)) add(`auto:${p.id}`, t, name(p), `Mañana${total ? ` · ${pending} pendiente${pending === 1 ? '' : 's'}` : ''}`);
      }
    }
    for (const x of p.items || []) {
      if (!x.rem || !x.rem.length) continue;
      if (x.repeat) {
        for (const day of days) {
          if (!repeats(x.repeat, day)) continue;
          if (x.done && x.lastReset && x.lastReset >= day) continue;          // already done for this occurrence
          for (const r of x.rem) { const t = at(day, r.t, tz); if (inWin(t)) add(`r:${x.id}:${day}:${r.t}`, t, x.t || 'Tarea', name(p)); }
        }
      } else if (x.date && !x.done) {
        for (const r of x.rem) {
          const t = at(addDays(x.date, -(r.d || 0)), r.t, tz);
          if (inWin(t)) add(`i:${x.id}:${r.d}:${r.t}`, t, x.t || 'Tarea', `${rel(r.d || 0)} · ${name(p)}`);
        }
      }
    }
  }
  if (notif.daily) {
    for (const day of days) {
      const t = at(day, notif.daily, tz);
      if (!inWin(t)) continue;
      const list = [];
      for (const p of papers) {
        if (p.date === day && (p.items || []).some(x => !x.done)) list.push(name(p) + ' (hoy)');
        for (const x of p.items || []) {
          const doneToday = x.done && (!x.repeat || (x.lastReset && x.lastReset >= day));
          if (doneToday) continue;
          if (x.date === day || repeats(x.repeat, day)) list.push(x.t || 'Tarea');
        }
      }
      if (list.length) add(`daily:${day}`, t, list.length === 1 ? 'Hoy toca 1 cosa' : `Hoy tocan ${list.length} cosas`, list.slice(0, 4).join(' · ') + (list.length > 4 ? ` y ${list.length - 4} más` : ''));
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/* ---------- run ---------- */
async function main(){
  if (!KEY) { console.log('Falta el secreto PUSH_KEY: no se envía nada.'); return; }
  webpush.setVapidDetails(APP_URL, PUB, KEY);
  const reg = await getDoc(REGISTRY);
  const codes = new Set();
  for (const e of Object.values(reg?.r || {})) { try { codes.add(decryptCode(e)); } catch(err){} }
  console.log('boards:', codes.size);
  for (const code of codes) {
    const b = await getDoc(code); if (!b) continue;
    const subs = Object.entries(b.subs || {});
    const since = Math.max(b.pushRun || 0, NOW - (b.pushRun ? MAX_LATE : FIRST_LOOKBACK));
    const list = subs.length ? due(b, since, NOW) : [];
    const dead = [];
    for (const n of list) {
      for (const [dev, s] of subs) {
        if (dead.includes(dev)) continue;
        if (DRY) { console.log('[dry]', dev, n.title, '—', n.body); continue; }
        try {
          await webpush.sendNotification(JSON.parse(s), JSON.stringify({ title:n.title, body:n.body, tag:n.key, url:APP_URL }), { TTL:6 * 3600, urgency:'high' });
        } catch(err) {
          if (err.statusCode === 404 || err.statusCode === 410) dead.push(dev);
          else console.log('send error', err.statusCode || err.message);
        }
      }
    }
    console.log('board', code.slice(0, 4), 'devices', subs.length, 'sent', list.length, 'removed', dead.length);
    if (!DRY) await patchDoc(code, { pushRun:{ integerValue:String(NOW) } }, ['pushRun', ...dead.map(d => 'subs.' + d)]);
  }
}
if (import.meta.url === 'file://' + process.argv[1]) main().catch(e => { console.error(e); process.exit(1); });
