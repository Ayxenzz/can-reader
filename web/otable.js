// The OBD table. It sits under the CAN table and works the same way. One row per request the car
// answers, in the same columns (ID, count, ms), then the answer's bytes in one wrapped cell, then
// your own formula columns. b0 is the first data byte after the answer's header, so for the standard
// engine speed answer (41 0C xx yy) b0 and b1 are xx and yy. Rows can be hidden, soloed, muted
// byte by byte, and the raw cells hidden once everything is decoded.
import { initRows } from './rows.js';
import { initView } from './view.js';
import { initCells } from './cells.js';
import { makeColumns } from './fcols.js';

const COLS = ['id', 'count', 'ms', 'data'];
const NAMES = { id: 'ID', count: 'Count', ms: 'ms', data: 'Data' };
const H = Array.from({ length: 256 }, (_, i) => i.toString(16).toUpperCase().padStart(2, '0'));

// How many bytes of an answer come before the data: 41 PP, 62 HH LL, or just the service byte.
export const skipFor = (req) => (req.length === 4 && req.startsWith('01') ? 2 : req.length === 6 && req.startsWith('22') ? 3 : req.length === 2 ? 1 : 0);
export const labelFor = (req) => (req.length > 2 ? req.slice(0, 2) + ' ' + req.slice(2) : req);

export function initOtable({ head, body, anchor, onPoll }) {
  const rows = new Map(), dirty = new Set(), hot = new Map();
  let tap = null, needSort = false;
  let paused = new Set();
  try { paused = new Set(JSON.parse(localStorage.getItem('canreader.opaused') || '[]')); } catch (e) {}
  const savePaused = () => { try { localStorage.setItem('canreader.opaused', JSON.stringify([...paused])); } catch (e) {} };

  const cols = makeColumns({ head, rows, dirty, key: 'canreader.ocols', legacy: false });
  const viewApi = initView({ rows, p: 'o', title: 'OBD view', head, body, anchor, cols: COLS, names: NAMES, scope: '#obdtable' });
  cols.rebuild();
  const dim = (r) => { if (r.tr) r.tr.style.opacity = paused.has(r.key) ? '0.5' : ''; };
  const togglePoll = (key) => {
    if (paused.has(key)) paused.delete(key); else paused.add(key);
    savePaused();
    const r = rows.get(key);
    if (r) dim(r);
    if (onPoll) onPoll();
  };
  const rowsApi = initRows({
    rows, redraw: (r) => dirty.add(r), p: 'o', title: 'OBD rows', body, anchor,
    extraMenu: (r) => [[paused.has(r.key) ? 'Poll this again' : 'Stop polling this', () => togglePoll(r.key)]],
  });
  initCells({ getCols: () => cols.cols, rebuild: cols.rebuild, preview: cols.preview, check: cols.check, head, body });

  function makeRow(r) {
    const tr = document.createElement('tr');
    const mk = (txt, cls) => { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = txt; tr.appendChild(td); return td; };
    mk(labelFor(r.req));
    const count = mk('', 'n'), period = mk('', 'n'), data = mk('', 'data');
    r.tr = tr;
    r.c = { count, period, data, spans: [] };
    cols.userCells(r);
    rowsApi.place(r);
    dim(r);
  }

  // One span per data byte, so each byte can flash, be muted, and wrap with the rest.
  function ensureSpans(r, n) {
    let added = false;
    while (r.c.spans.length < n) {
      const sp = document.createElement('span');
      sp.className = 'bb'; sp._b = r.c.spans.length; sp._t = '';
      r.c.data.appendChild(sp);
      r.c.spans.push(sp);
      added = true;
    }
    r.c.spans.forEach((sp, i) => { sp.style.display = i < n ? '' : 'none'; });
    if (added) viewApi.place(r);
  }

  // An answer arrived. req is the request in hex, bytes the whole answer starting at the service byte.
  function feed(req, bytes, now = performance.now()) {
    const skip = skipFor(req);
    if (bytes.length < skip) return;
    const data = bytes.slice(skip);
    let r = rows.get(req);
    if (!r) {
      r = { tbl: 'obd', req, id: parseInt(req.slice(-4), 16), ext: '0', hex: req, key: req, mute: [], fresh: false, hidden: false, count: 0, ts: 0, period: 0, dlc: 0, bytes: [], chg: [], tr: null, c: null, ux: [] };
      rows.set(req, r);
      makeRow(r);
      needSort = true;
    }
    ensureSpans(r, data.length);
    r.count++;
    if (r.ts) r.period = now - r.ts;
    r.ts = now;
    for (let i = 0; i < data.length; i++) {
      if (r.bytes[i] !== undefined && r.bytes[i] !== data[i] && !r.mute[i]) { r.chg[i] = true; if (tap) tap(r, i, r.bytes[i] ^ data[i]); }
    }
    r.bytes = data;
    r.dlc = data.length;
    dirty.add(r);
  }

  function paint() {
    const a = performance.now();
    if (needSort) {
      const all = [...rows.values()].sort((x, y) => parseInt(x.req, 16) - parseInt(y.req, 16));
      for (const r of all) body.appendChild(r.tr);
      needSort = false;
    }
    for (const r of dirty) {
      if (r.hidden) continue;
      r.c.count.textContent = r.count;
      r.c.period.textContent = r.period ? Math.round(r.period) : '';
      for (let i = 0; i < r.c.spans.length; i++) {
        const sp = r.c.spans[i];
        const txt = i < r.dlc ? H[r.bytes[i]] : '';
        if (sp._t !== txt) { sp.textContent = txt; sp._t = txt; }
        if (r.chg[i]) {
          r.chg[i] = false;
          if (!sp.classList.contains('hot')) sp.classList.add('hot');
          hot.set(sp, a + 150);
        }
      }
      cols.drawUser(r);
    }
    dirty.clear();
    for (const [sp, until] of hot) if (a >= until) { sp.classList.remove('hot'); hot.delete(sp); }
    requestAnimationFrame(paint);
  }
  requestAnimationFrame(paint);

  return {
    feed, rows, cols,
    reset: () => { rows.clear(); dirty.clear(); hot.clear(); body.innerHTML = ''; rowsApi.reset(); },
    paused: () => paused,
    getCols: () => cols.cols, setCols: (c) => cols.set(c),
    getHidden: () => rowsApi.getHidden(), setHidden: (h) => rowsApi.setHidden(h),
    getView: () => viewApi.getView(), setView: (v) => viewApi.setView(v),
    showOnly: (k) => rowsApi.showOnly(k),
    setTap: (f) => { tap = f; },
  };
}