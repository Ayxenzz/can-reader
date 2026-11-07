// Row controls. Hiding only changes the display. Hidden rows keep updating in memory, in
// recordings, and in the diff tool. A row that appears after the first five seconds of a run
// shows by default and flashes its ID, because a new ID is often the signal you are hunting.
export function initRows({ rows, redraw, p = '', title = 'Rows', body, anchor, extraMenu }) {
  const $ = (id) => document.getElementById(id);
  const bodyEl = body || $('body'), anchorEl = anchor || $('logbox');
  let hidden = new Set(), solo = null, filter = null, note = '';

  const det = document.createElement('details');
  det.innerHTML = `<summary id="${p}rowsum">${title}</summary>
    <input id="${p}rowfilter" placeholder="filter, for example 164 17C 100-1FF">
    <button id="${p}rowhall">Hide all</button><button id="${p}rowsall">Show all</button><button id="${p}rowsolo">Clear solo</button>
    <pre id="${p}rowinfo"></pre><div id="${p}rowhid"></div>`;
  anchorEl.before(det);

  const menu = document.createElement('div');
  menu.style.cssText = 'position:fixed;left:0;right:0;bottom:0;padding:10px;background:Canvas;color:CanvasText;border-top:1px solid #8886;display:none;z-index:5';
  document.body.appendChild(menu);

  const parseFilter = (text) => {
    const out = [];
    for (const t of text.split(/[\s,]+/).filter(Boolean)) {
      const m = /^([0-9a-f]+)(?:-([0-9a-f]+))?$/i.exec(t);
      if (!m) continue;
      const a = parseInt(m[1], 16), b = m[2] ? parseInt(m[2], 16) : a;
      out.push([Math.min(a, b), Math.max(a, b)]);
    }
    return out.length ? out : null;
  };
  const visible = (r) => !hidden.has(r.key) && (solo === null || solo === r.key) &&
    (!filter || filter.some(([a, b]) => r.id >= a && r.id <= b));

  function chips() {
    $(p + 'rowhid').replaceChildren(...[...hidden].sort().slice(0, 150).map((k) => {
      const b = document.createElement('button');
      b.textContent = k;
      b.onclick = () => { hidden.delete(k); apply(); };
      return b;
    }));
  }
  function text() {
    let shown = 0, total = 0;
    for (const r of rows.values()) { total++; if (!r.hidden) shown++; }
    $(p + 'rowsum').textContent = title + (hidden.size ? ' (' + hidden.size + ' hidden)' : '') + (solo ? ', solo ' + solo : '');
    $(p + 'rowinfo').textContent = 'Showing ' + shown + ' of ' + total + ' rows.' + (note ? ' ' + note : '');
  }
  function apply() {
    for (const r of rows.values()) {
      const h = !visible(r);
      if (r.hidden === h) continue;
      r.hidden = h;
      if (r.tr) r.tr.style.display = h ? 'none' : '';
      if (!h) redraw(r);   // catch up on what changed while it was hidden
    }
    text();
    chips();
  }

  function place(r) {
    r.tr._r = r;
    r.hidden = !visible(r);
    r.tr.style.display = r.hidden ? 'none' : '';
    if (r.fresh && !r.hidden) {
      const td = r.tr.children[0];
      td.style.background = '#2f9e44';
      setTimeout(() => { td.style.background = ''; }, 4000);
    }
  }

  function openMenu(r) {
    menu.replaceChildren();
    const label = document.createElement('span');
    label.textContent = 'ID ' + r.key + '  ';
    const mk = (t, fn) => {
      const b = document.createElement('button');
      b.textContent = t;
      b.onclick = () => { menu.style.display = 'none'; fn(); };
      return b;
    };
    menu.append(label,
      mk('Hide', () => { hidden.add(r.key); apply(); }),
      mk(solo === r.key ? 'Unsolo' : 'Solo', () => { solo = solo === r.key ? null : r.key; apply(); }),
      ...(extraMenu ? extraMenu(r).map(([t, fn]) => mk(t, fn)) : []),   // for example a poll switch on the OBD table
      mk('Close', () => {}));
    menu.style.display = 'block';
  }
  bodyEl.addEventListener('click', (e) => {
    const td = e.target.closest && e.target.closest('td');
    if (!td || td.parentNode.children[0] !== td) return;   // only the ID cell opens the menu
    const r = td.parentNode._r;
    if (r) openMenu(r);
  });

  $(p + 'rowfilter').oninput = () => { filter = parseFilter($(p + 'rowfilter').value); apply(); };
  $(p + 'rowhall').onclick = () => { for (const r of rows.values()) hidden.add(r.key); note = ''; apply(); };
  $(p + 'rowsall').onclick = () => { hidden.clear(); solo = null; note = ''; apply(); };
  $(p + 'rowsolo').onclick = () => { solo = null; apply(); };
  setInterval(text, 1000);
  text();

  return {
    place,
    getHidden: () => [...hidden].sort(),
    setHidden: (a) => { hidden = new Set(a); apply(); },
    // Keeps only the given row keys visible, used by the diff tool.
    showOnly: (keys) => {
      const keep = new Set(keys);
      for (const r of rows.values()) { if (keep.has(r.key)) hidden.delete(r.key); else hidden.add(r.key); }
      note = 'Showing only the ' + keep.size + ' rows from the diff.';
      apply();
    },
    reset: () => { solo = null; note = ''; },
  };
}