import { initExtras } from './extras.js';
import { initRecorder } from './recorder.js';
import { initReplay } from './replay.js';
import { initRows } from './rows.js';
import { initCells } from './cells.js';
import { initView } from './view.js';
import { makeColumns } from './fcols.js';
import { initOtable } from './otable.js';
import { initObd } from './obd.js';

const $ = (id) => document.getElementById(id);
const btn = $('btn'), info = $('info'), warn = $('warn'), body = $('body'), head = $('head');
const logEl = $('log'), logBox = $('logbox');
const H = Array.from({ length: 256 }, (_, i) => i.toString(16).toUpperCase().padStart(2, '0'));

const rows = new Map(), dirty = new Set(), hot = new Map(), prevs = {};
let needSort = false, total = 0, lastTotal = 0, bad = 0, bytes = 0;
let fMark = null, totalMark = 0, lost = 0, lostAcc = 0;
let t0 = null, endT = null, lastT = 0, minFps = Infinity, lagMs = 0, lagMax = 0;
let lastByteT = 0, lastFrameT = 0, noData = false, noFrames = false;
let st = {}, lastUp = -1, reboots = 0, dev = '', idsEarly = 0, earlyDone = false;
let status = 'Not connected.', port = null, reader = null, busy = false, wake = null;
let frameTap = null, evTap = null;   // set by recorder.js
let replaying = false, replayApi = null;   // set by replay.js
let rowsApi = null, viewApi = null;   // set by rows.js and view.js
let obdApi = null, obdTable = null;   // the OBD controller and the OBD table

// ---- event log, kept across reloads ----
let logArr = [];
try { logArr = JSON.parse(localStorage.getItem('canreader.log') || '[]'); } catch (e) {}
const ev = (m) => { if (replaying && !/^(replay|js )/.test(m)) return; logArr.push(new Date().toTimeString().slice(0, 8) + '  ' + m); if (logArr.length > 300) logArr.shift(); if (evTap) evTap(m); };
ev('--- page loaded ---');
setInterval(() => { try { localStorage.setItem('canreader.log', JSON.stringify(logArr.slice(-200))); } catch (e) {} }, 3000);
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText(logArr.join('\n')); ev('log copied'); }
  catch (e) { logEl.textContent = logArr.join('\n'); }
};
$('clear').onclick = () => { logArr = []; logEl.textContent = ''; };
window.addEventListener('error', (e) => ev('js error ' + e.message));
window.addEventListener('unhandledrejection', (e) => ev('js rejection ' + (e.reason && e.reason.message || e.reason)));
document.addEventListener('visibilitychange', () => { ev(document.hidden ? 'page hidden' : 'page visible'); if (!document.hidden && reader) getWake(); });
document.addEventListener('freeze', () => ev('page frozen by browser'));
document.addEventListener('resume', () => ev('page resumed'));

async function getWake() {
  if (!('wakeLock' in navigator) || wake) return;
  try {
    wake = await navigator.wakeLock.request('screen');
    ev('wake lock on');
    wake.addEventListener('release', () => { wake = null; ev('wake lock released'); });
  } catch (e) { ev('wake lock failed ' + (e.name || e)); }
}

// ---- formula columns ----
const canCols = makeColumns({ head, rows, dirty, key: 'canreader.cols', legacy: true });
let tap = null;   // set by extras.js, called when a byte changes

// ---- parsing ----
function onStat(s) {
  const o = {};
  for (const kv of s.slice(7).split(' ')) {
    const i = kv.indexOf('=');
    if (i > 0) o[kv.slice(0, i)] = kv.slice(i + 1);
  }
  const f = Number(o.frames), up = Number(o.up);
  if (!isNaN(up)) {
    if (lastUp >= 0 && up < lastUp) { reboots++; ev('device restarted, reset ' + o.rst); lostAcc += lost; fMark = null; lost = 0; }
    lastUp = up;
  }
  if (!isNaN(f)) {
    if (fMark === null) { fMark = f; totalMark = total; lost = 0; }
    else lost = (f - fMark) - (total - totalMark);   // frames the board sent minus frames counted here
  }
  const prev = st;
  st = o;
  if (prev.up === undefined) ev('device ' + o.rate + ' reset ' + o.rst);
  else for (const k of ['state', 'rate', 'buserr', 'missed', 'recov', 'usbdrop', 'ringdrop']) {
    if (prev[k] !== o[k]) ev('dev ' + k + ' ' + prev[k] + ' to ' + o[k]);
  }
}

function onLine(s) {
  s = s.trim();
  if (!s) return;
  if (s[0] === '#') {
    if (obdApi && obdApi.onLine(s)) return;   // answers to OBD requests and polling messages
    if (s.startsWith('# stat ')) onStat(s); else { dev = s; ev('dev ' + s.slice(2)); }
    return;
  }
  const p = s.split(',');
  const ts = Number(p[0]), id = parseInt(p[1], 16), ext = p[2], dlc = Number(p[3]), hex = p[4];
  if (p.length !== 5 || isNaN(ts) || isNaN(id) || (ext !== '0' && ext !== '1') ||
      !(dlc >= 0 && dlc <= 8) || hex.length !== dlc * 2 || /[^0-9A-F]/.test(hex)) { bad++; return; }
  if (frameTap && !replaying) frameTap(s);
  const key = ext + ':' + id;
  let r = rows.get(key);
  if (!r) {
    r = { id, ext, hex: p[1].toUpperCase(), key: p[1].toUpperCase() + (ext === '1' ? 'x' : ''), mute: [], fresh: false, hidden: false, count: 0, ts: 0, period: 0, dlc: 0, bytes: [], chg: [], tr: null, c: null, ux: [] };
    rows.set(key, r);
    needSort = true;
    if (performance.now() - t0 < 5000) idsEarly++; else { ev('new id ' + p[1]); r.fresh = !replaying; }
  }
  r.count++;
  if (r.ts) r.period = (ts - r.ts) / 1000;
  r.ts = ts;
  r.dlc = dlc;
  for (let i = 0; i < dlc; i++) {
    const v = parseInt(hex.substr(i * 2, 2), 16);
    if (r.bytes[i] !== undefined && r.bytes[i] !== v && !r.mute[i]) { r.chg[i] = true; if (tap) tap(r, i, r.bytes[i] ^ v); }   // muted cells neither flash nor count for the diff
    r.bytes[i] = v;
  }
  r.bytes.length = dlc;
  dirty.add(r);
  total++;
  lastFrameT = performance.now();
}

// ---- drawing ----
function makeRow(r) {
  const tr = document.createElement('tr');
  const mk = (txt, cls) => { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = txt; tr.appendChild(td); return td; };
  mk(r.id.toString(16).toUpperCase().padStart(r.ext === '1' ? 8 : 3, '0'));   // 8 digits = 29-bit, 3 = 11-bit
  const count = mk('', 'n'), period = mk('', 'n');
  const spans = [];   // one cell per data byte
  for (let i = 0; i < 8; i++) { const td = mk('', 'b'); td._t = ''; td._b = i; spans.push(td); }
  r.tr = tr;
  r.c = { count, period, spans };
  canCols.userCells(r);
  if (rowsApi) rowsApi.place(r);
  if (viewApi) viewApi.place(r);
}

function paint() {
  const a = performance.now();
  if (needSort) {
    for (const r of rows.values()) if (!r.tr) makeRow(r);
    const all = [...rows.values()].sort((x, y) => x.ext - y.ext || x.id - y.id);
    for (const r of all) body.appendChild(r.tr);
    needSort = false;
  }
  for (const r of dirty) {
    if (r.hidden) continue;   // redrawn from memory when it is shown again
    r.c.count.textContent = r.count;
    r.c.period.textContent = r.period ? r.period.toFixed(1) : '';
    for (let i = 0; i < 8; i++) {
      const sp = r.c.spans[i];
      const txt = i < r.dlc ? H[r.bytes[i]] : '';
      if (sp._t !== txt) { sp.textContent = txt; sp._t = txt; }
      if (r.chg[i]) {
        r.chg[i] = false;
        if (!sp.classList.contains('hot')) sp.classList.add('hot');
        hot.set(sp, a + 150);
      }
    }
    canCols.drawUser(r);   // formulas run once per repaint, not once per frame
  }
  dirty.clear();
  for (const [sp, until] of hot) if (a >= until) { sp.classList.remove('hot'); hot.delete(sp); }
  requestAnimationFrame(paint);
}

// ---- once-per-second stats and event detection ----
const mmss = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const kb = (v) => (v === undefined ? '-' : (Number(v) / 1024).toFixed(0) + 'k');
function delta(k, cur, label) { const p = prevs[k]; prevs[k] = cur; if (p !== undefined && cur > p) ev(label + ' +' + (cur - p)); }

setInterval(() => {
  if (logBox.open) logEl.textContent = logArr.slice(-15).join('\n');
  if (t0 === null) { info.textContent = status; return; }
  const t = performance.now(), live = endT === null;
  const el = Math.max(((live ? t : endT) - t0) / 1000, 0.001), dt = Math.max((t - lastT) / 1000, 0.001);
  const fps = (total - lastTotal) / dt;
  lagMs = Math.max(0, dt * 1000 - 1000);
  if (live && lagMs > lagMax) lagMax = lagMs;
  lastT = t; lastTotal = total;
  if (live && el > 2) minFps = Math.min(minFps, fps);
  const lostAll = lostAcc + lost;

  if (live && !replaying) {
    if (lagMs > 300) ev('stall ' + lagMs.toFixed(0) + ' ms' + (document.hidden ? ' (page hidden)' : ''));
    const gb = t - lastByteT, gf = t - lastFrameT;
    if (gb > 3000 && !noData) { noData = true; ev('no usb data for 3 s'); }
    if (gb < 3000 && noData) { noData = false; ev('usb data resumed'); }
    if (gf > 3000 && gb < 3000 && !noFrames) { noFrames = true; ev('no frames for 3 s (bus quiet or wrong bitrate)'); }
    if (gf < 3000 && noFrames) { noFrames = false; ev('frames resumed'); }
    if (!earlyDone && el > 5) { earlyDone = true; ev(idsEarly + ' ids seen in first 5 s'); }
    delta('lost', lostAll, 'lost');
    delta('bad', bad, 'malformed');
  }

  const L = [status + '   run ' + mmss(el),
    'frames/s now ' + (live ? fps.toFixed(0) : '-') + ' avg ' + (total / el).toFixed(0) + ' min ' + (minFps === Infinity ? '-' : minFps.toFixed(0)),
    'KB/s avg ' + (bytes / 1024 / el).toFixed(1) + '  total ' + total + '  ids ' + rows.size,
    'malformed ' + bad + '  lost ' + (fMark === null && lostAcc === 0 ? '-' : lostAll)];
  if (st.up !== undefined) {
    L.push('dev up ' + st.up + 's ' + st.rate + ' ' + st.state + '  reset ' + st.rst + '  reboots ' + reboots,
      'tec ' + st.tec + ' rec ' + st.rec + ' buserr ' + st.buserr + ' missed ' + st.missed,
      'ring peak ' + st.peakfill + ' drop ' + st.ringdrop + '  usbdrop ' + st.usbdrop,
      'heap ' + kb(st.heap) + ' min ' + kb(st.minheap) + '  loop gap max ' + (st.maxgap / 1000).toFixed(1) + 'ms');
  }
  L.push('tick lag ' + lagMs.toFixed(0) + 'ms (max ' + lagMax.toFixed(0) + ')  wake lock ' + (wake ? 'on' : 'off'));
  if (dev) L.push(dev);
  info.textContent = L.join('\n');

  const w = [];
  if (live && noData) w.push('NO USB DATA'); else if (live && noFrames) w.push('No frames. Bus quiet or wrong bitrate.');
  if (reboots) w.push('Device restarted ' + reboots + 'x');
  warn.textContent = w.join('\n');
}, 1000);

// ---- connection ----
function resetRun() {
  rows.clear(); dirty.clear(); hot.clear(); body.innerHTML = '';   // fresh run
  total = lastTotal = bad = bytes = 0;
  fMark = null; totalMark = 0; lost = 0; lostAcc = 0;
  st = {}; lastUp = -1; reboots = 0; dev = '';
  lagMs = 0; lagMax = 0; noData = noFrames = false; idsEarly = 0; earlyDone = false;
  for (const k in prevs) delete prevs[k];
  t0 = performance.now(); lastT = t0; endT = null; minFps = Infinity; lastByteT = t0; lastFrameT = t0;
  if (rowsApi) rowsApi.reset();
  if (obdTable) obdTable.reset();
}

async function connect(p) {
  if (busy) return;
  if (replaying && replayApi) replayApi.stop();
  if (!('serial' in navigator)) { status = 'Web Serial is not available in this browser.'; return; }
  busy = true;
  try {
    port = p || await navigator.serial.requestPort();
    await port.open({ baudRate: 2000000, bufferSize: 65536 });
  } catch (e) { status = 'Could not open port. ' + e.message; ev('open failed ' + e.message); port = null; busy = false; return; }

  resetRun();

  ev('connected' + (p ? ' (auto)' : ''));
  status = 'Connected.';
  btn.textContent = 'Disconnect';
  getWake();

  const dec = new TextDecoder();
  let buf = '', first = true, why = 'closed';
  reader = port.readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      lastByteT = performance.now();
      bytes += value.length;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (first) { first = false; continue; }   // the first piece may be a cut-off line
        onLine(line);
      }
      if (buf.length > 1000) buf = '';
    }
  } catch (e) { why = e.message; status = 'Read error. ' + e.message; }
  finally {
    endT = performance.now();
    try { reader.releaseLock(); await port.close(); } catch (e) {}
    reader = null; port = null; busy = false;
    btn.textContent = 'Connect';
    if (status === 'Connected.') status = 'Disconnected.';
    ev('disconnected ' + why);
    if (obdApi) obdApi.disconnected();
    if (wake) wake.release();
  }
}

// Writes to the board, one at a time. A second write while one is running would be refused.
let sendChain = Promise.resolve();
function send(text) {
  sendChain = sendChain.then(async () => {
    if (!port) return;
    const w = port.writable.getWriter();
    try { await w.write(new TextEncoder().encode(text)); } finally { w.releaseLock(); }
  }).catch((e) => ev('send failed ' + (e.message || e)));
  return sendChain;
}

async function tryAuto() {
  if (busy || !('serial' in navigator)) return;
  try {
    const ps = await navigator.serial.getPorts();
    ev('auto-connect, granted ports ' + ps.length);
    if (ps.length) await connect(ps[0]);
  } catch (e) { ev('auto-connect failed ' + (e.message || e)); }
}
if ('serial' in navigator) {
  navigator.serial.addEventListener('connect', () => { ev('usb device attached'); tryAuto(); });
  navigator.serial.addEventListener('disconnect', () => ev('usb device detached'));
  tryAuto();
}
btn.onclick = () => { if (reader) reader.cancel(); else connect(); };

viewApi = initView({ rows, scope: '#cantable' });   // builds the built-in header cells, so it runs before the user columns
canCols.rebuild();
rowsApi = initRows({ rows, redraw: (r) => dirty.add(r) });
obdApi = initObd({ send, isLive: () => reader !== null, getTable: () => obdTable });   // its section comes first
obdTable = initOtable({ head: $('ohead'), body: $('obody'), anchor: logBox, onPoll: () => obdApi.repoll() });
initExtras({
  getCols: () => canCols.cols, setCols: (c) => canCols.set(c),
  getHidden: () => rowsApi.getHidden(), setHidden: (h) => rowsApi.setHidden(h), showOnly: (k) => rowsApi.showOnly(k),
  getView: () => viewApi.getView(), setView: (v) => viewApi.setView(v),
  setTap: (f) => { tap = f; obdTable.setTap(f); }, ev,
  obd: { ...obdTable, getPoll: () => obdApi.getSettings(), setPoll: (s) => obdApi.setSettings(s) },
});
initCells({
  getCols: () => canCols.cols, rebuild: canCols.rebuild, preview: canCols.preview, check: canCols.check,
});
initRecorder({ ev, setFrameTap: (f) => { frameTap = f; }, setEvTap: (f) => { evTap = f; }, onPlay: (b, n) => replayApi && replayApi.play(b, n) });
replayApi = initReplay({
  ev,
  isLive: () => reader !== null,
  begin: (name) => { replaying = true; resetRun(); status = 'Replaying ' + name + '.'; },
  end: (why) => { replaying = false; endT = performance.now(); status = 'Replay ' + why + '.'; },
  feed: (s) => {
    if (s[0] === '#') { dev = s; return; }   // notes from the recording, shown but not logged
    bytes += s.length + 1;
    lastByteT = performance.now();
    onLine(s);
  },
});
requestAnimationFrame(paint);