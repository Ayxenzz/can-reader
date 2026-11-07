// View controls for the built-in columns. Tap a column header to hide the column, or to mute a
// byte column. Tap a byte cell to mute just that cell. Muted cells turn grey, stop flashing, and
// are left out of the diff tool. Their value still updates. Hiding and muting only change the
// display, so formulas, recordings and replay are not affected.
const CAN_COLS = ['id', 'count', 'ms', 'b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'];
const CAN_NAMES = { id: 'ID', count: 'Count', ms: 'ms', b0: 'B0', b1: 'B1', b2: 'B2', b3: 'B3', b4: 'B4', b5: 'B5', b6: 'B6', b7: 'B7' };

export function initView({ rows, p = '', title = 'View', head, body, anchor, cols, names, scope = 'table' }) {
  const $ = (id) => document.getElementById(id);
  const headEl = head || $('head'), bodyEl = body || $('body'), anchorEl = anchor || $('logbox');
  const COLS = cols || CAN_COLS, NAMES = names || CAN_NAMES, RAW = COLS.filter((c) => c !== 'id');
  let hide = new Set(), mute = new Set(), cells = new Set();
  const arr = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);

  // one header cell per built-in column, user columns are added after these by app.js
  headEl.replaceChildren(...COLS.map((id) => {
    const th = document.createElement('th');
    th.textContent = NAMES[id];
    th._bi = id;
    th.style.cursor = 'pointer';
    return th;
  }));
  const styleEl = document.createElement('style');
  document.head.appendChild(styleEl);

  const det = document.createElement('details');
  det.innerHTML = `<summary id="${p}viewsum">${title}</summary>
    <button id="${p}viewraw">Hide raw columns</button><button id="${p}viewshow">Show all columns</button>
    <button id="${p}viewunmute">Unmute all cells</button><button id="${p}viewreset">Reset view</button>
    <pre id="${p}viewinfo"></pre><div id="${p}viewhid"></div>`;
  anchorEl.before(det);

  const menu = document.createElement('div');
  menu.style.cssText = 'position:fixed;left:0;right:0;bottom:0;padding:10px;background:Canvas;color:CanvasText;border-top:1px solid #8886;display:none;z-index:5';
  document.body.appendChild(menu);

  function placeRow(r) {
    r.mute = r.mute || [];
    const n = r.c ? r.c.spans.length : 0;   // 8 on the CAN table, one per data byte on the OBD table
    for (let i = 0; i < n; i++) {
      const m = mute.has('b' + i) || cells.has(r.key + ':' + i);
      r.mute[i] = m;
      const td = r.c && r.c.spans[i];
      if (!td) continue;
      if (m) { td.classList.add('muted'); td.classList.remove('hot'); r.chg[i] = false; }
      else td.classList.remove('muted');
    }
  }

  function chips() {
    const mk = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; return b; };
    $(p + 'viewhid').replaceChildren(
      ...[...hide].sort().map((id) => mk('Show ' + NAMES[id], () => { hide.delete(id); apply(); })),
      ...[...mute].sort().map((id) => mk('Unmute ' + NAMES[id], () => { mute.delete(id); apply(); })),
    );
  }
  function apply() {
    for (const r of rows.values()) if (r.tr) placeRow(r);
    // hide by position so rows created later follow the rule without extra work
    styleEl.textContent = [...hide].map((id) => {
      const n = COLS.indexOf(id) + 1;
      return scope + ' th:nth-child(' + n + '),' + scope + ' td:nth-child(' + n + '){display:none}';
    }).join('');
    $(p + 'viewinfo').textContent = 'Hidden columns ' + hide.size + ', muted columns ' + mute.size + ', muted cells ' + cells.size + '.';
    $(p + 'viewsum').textContent = title + (hide.size || mute.size || cells.size ? ' (' + (hide.size + mute.size + cells.size) + ' set)' : '');
    chips();
  }

  function openMenu(label, buttons) {
    menu.replaceChildren();
    const span = document.createElement('span');
    span.textContent = label + '  ';
    const mk = (t, fn) => { const b = document.createElement('button'); b.textContent = t; b.onclick = () => { menu.style.display = 'none'; fn(); }; return b; };
    menu.append(span, ...buttons.map(([t, fn]) => mk(t, fn)), mk('Cancel', () => {}));
    menu.style.display = 'block';
  }
  function colMenu(id) {
    const b = [];
    if (id !== 'id') b.push(['Hide', () => { hide.add(id); apply(); }]);
    if (/^b\d+$/.test(id)) b.push([mute.has(id) ? 'Unmute column' : 'Mute column', () => { if (mute.has(id)) mute.delete(id); else mute.add(id); apply(); }]);
    openMenu('Column ' + NAMES[id], b);
  }
  function cellMenu(r, i) {
    const k = r.key + ':' + i;
    if (mute.has('b' + i)) {
      openMenu('ID ' + r.key + ' B' + i + ' is muted with its column', [['Unmute column', () => { mute.delete('b' + i); apply(); }]]);
      return;
    }
    openMenu('ID ' + r.key + ' B' + i, [[cells.has(k) ? 'Unmute cell' : 'Mute cell', () => { if (cells.has(k)) cells.delete(k); else cells.add(k); apply(); }]]);
  }

  headEl.addEventListener('click', (e) => {
    const th = e.target.closest && e.target.closest('th');
    if (th && th._bi) colMenu(th._bi);
  });
  bodyEl.addEventListener('click', (e) => {
    let t = e.target;   // a byte cell on the CAN table, a byte inside the data cell on the OBD table
    if (t && t._b === undefined && t.closest) t = t.closest('td');
    if (!t || t._b === undefined) return;
    let row = t;
    while (row && row._r === undefined && row.parentNode) row = row.parentNode;
    const r = row && row._r;
    if (r) cellMenu(r, t._b);
  });
  $(p + 'viewraw').onclick = () => { for (const c of RAW) hide.add(c); apply(); };
  $(p + 'viewshow').onclick = () => { hide.clear(); apply(); };
  $(p + 'viewunmute').onclick = () => { cells.clear(); apply(); };
  $(p + 'viewreset').onclick = () => { hide.clear(); mute.clear(); cells.clear(); apply(); };
  apply();

  return {
    place: placeRow,
    getView: () => ({ hide: [...hide].sort(), mute: [...mute].sort(), cells: [...cells].sort() }),
    setView: (v) => {
      hide = new Set(arr(v && v.hide).filter((c) => COLS.includes(c) && c !== 'id'));
      mute = new Set(arr(v && v.mute).filter((c) => /^b\d+$/.test(c) && COLS.includes(c)));
      cells = new Set(arr(v && v.cells));
      apply();
    },
  };
}