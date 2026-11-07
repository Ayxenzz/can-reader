// Formula columns for one table. A column is { name, formula, cells, labels, hidden }. cells maps
// a row's key to that row's own formula and labels maps it to an optional label. The CAN table and
// the OBD table each get their own set, stored under their own key.
import { compile, run, show } from './formula.js';

export function makeColumns({ head, rows, dirty, key, legacy }) {
  const $ = (id) => document.getElementById(id);
  let cols = [];
  try { cols = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) {}
  const compiled = new Map();
  const cbox = document.createElement('div');   // hide and show buttons, only for the old Columns form
  if (legacy) $('clist').after(cbox);

  function fnFor(src) {
    if (!compiled.has(src)) { try { compiled.set(src, compile(src)); } catch (e) { compiled.set(src, e); } }
    return compiled.get(src);
  }
  const check = (src) => { const x = fnFor(src); return x instanceof Error ? x.message : ''; };

  function evalSrc(r, src, cache, stack) {
    const f = fnFor(src);
    if (f instanceof Error) throw f;
    return run(f, r, (n) => {
      const o = cols.find((x) => x.name.toLowerCase() === n);
      if (!o) throw new Error('no column ' + n);
      return evalCol(r, o, cache, stack).v;
    });
  }

  function evalCol(r, c, cache, stack) {
    if (cache[c.name]) return cache[c.name];
    if (stack.has(c.name)) throw new Error('cycle at ' + c.name);
    stack.add(c.name);
    const src = r.hex in c.cells ? c.cells[r.hex] : c.formula;
    const res = src ? evalSrc(r, src, cache, stack) : { v: NaN, f: null };
    stack.delete(c.name);
    return (cache[c.name] = res);
  }

  // What a formula gives for this row right now, used by the edit sheet.
  function preview(r, src) {
    try { const x = evalSrc(r, src, {}, new Set()); return show(x.v, x.f) || '(blank)'; }
    catch (e) { return 'error: ' + e.message; }
  }

  function drawUser(r) {
    const cache = {};
    cols.forEach((c, i) => {
      const td = r.ux[i];
      let t = '', tip = '';
      try {
        const x = evalCol(r, c, cache, new Set());
        t = show(x.v, x.f);
        const lab = c.labels && c.labels[r.hex];
        if (lab && t !== '') t = lab + ' ' + t;   // optional label such as speed
      }
      catch (e) { t = 'err'; tip = e.message; }
      if (td._t !== t) { td.textContent = t; td._t = t; td.title = tip; }
    });
  }

  function userCells(r) {
    (r.ux || []).forEach((td) => td.remove());
    r.ux = cols.map((c, i) => {
      const td = document.createElement('td');
      td._t = ''; td._ci = i;
      td.style.minWidth = '6ch'; td.style.cursor = 'pointer';
      if (c.hidden) td.style.display = 'none';
      r.tr.appendChild(td);
      return td;
    });
    dirty.add(r);
  }

  function rebuild() {
    head.querySelectorAll('.uh').forEach((e) => e.remove());
    cols.forEach((c, i) => {
      const th = document.createElement('th');
      th.className = 'uh'; th.textContent = c.name; th._ci = i; th.style.cursor = 'pointer';
      if (c.hidden) th.style.display = 'none';
      head.appendChild(th);
    });
    const plus = document.createElement('th');   // tap to add a column
    plus.className = 'uh'; plus.textContent = '+'; plus._plus = true; plus.style.cursor = 'pointer';
    head.appendChild(plus);
    for (const r of rows.values()) if (r.tr) userCells(r);
    if (legacy) {
      cbox.replaceChildren(...cols.map((c) => {
        const b = document.createElement('button');
        b.textContent = (c.hidden ? 'Show ' : 'Hide ') + c.name;
        b.onclick = () => { c.hidden = !c.hidden; rebuild(); };   // a hidden column still computes
        return b;
      }));
      $('clist').textContent = cols.map((c) => c.name + ' = ' + (c.formula || '(rows below only)') +
        Object.keys(c.cells).map((k) => '\n   ' + k + ': ' + c.cells[k]).join('')).join('\n') || 'No columns yet.';
    }
    try { localStorage.setItem(key, JSON.stringify(cols)); } catch (e) {}
  }

  if (legacy) {
    $('cadd').onclick = () => {
      const msg = $('cmsg');
      const name = $('cname').value.trim(), f = $('cf').value.trim();
      const rid = $('cid').value.trim().toUpperCase().replace(/^0X/, '');
      if (!name) { msg.textContent = 'Enter a column name.'; return; }
      if (f) { const e = check(f); if (e) { msg.textContent = e; return; } }
      let c = cols.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!c) {
        c = { name, formula: '', cells: {}, labels: {} };
        cols.push(c);
      }
      if (rid) { if (f) c.cells[rid] = f; else delete c.cells[rid]; }
      else if (f) c.formula = f;
      else cols.splice(cols.indexOf(c), 1);
      msg.textContent = 'Saved.';
      rebuild();
    };
  }

  return {
    get cols() { return cols; },
    set: (c) => { cols = c; rebuild(); },
    check, preview, drawUser, userCells, rebuild,
  };
}