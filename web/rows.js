// Row controls. Hiding only changes the display. Hidden rows keep updating in memory, in
// recordings, and in the diff tool. A row that appears after the first five seconds of a run
// shows by default and flashes its ID, because a new ID is often the signal you are hunting.
export function initRows({ rows, redraw }) {
  const $ = (id) => document.getElementById(id);
  let hidden = new Set(), solo = null, filter = null, note = '';

  const det = document.createElement('details');
  det.innerHTML = `<summary id="rowsum">Rows</summary>
    <input id="rowfilter" placeholder="filter, for example 164 17C 100-1FF">
    <button id="rowhall">Hide all</button><button id="rowsall">Show all</button><button id="rowsolo">Clear solo</button>
    <pre id="rowinfo"></pre><div id="rowhid"></div>`;
  $('logbox').before(det);

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
    $('rowhid').replaceChildren(...[...hidden].sort().slice(0, 150).map((k) => {
      const b = document.createElement('button');
      b.textContent = k;
      b.onclick = () => { hidden.delete(k); apply(); };
      return b;
    }));
  }
  function text() {
    let shown = 0, total = 0;
    for (const r of rows.values()) { total++; if (!r.hidden) shown++; }
    $('rowsum').textContent = 'Rows' + (hidden.size ? ' (' + hidden.size + ' hidden)' : '') + (solo ? ', solo ' + solo : '');
    $('rowinfo').textContent = 'Showing ' + shown + ' of ' + total + ' rows.' + (note ? ' ' + note : '');
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
      mk('Close', () => {}));
    menu.style.display = 'block';
  }
  $('body').addEventListener('click', (e) => {
    const td = e.target.closest && e.target.closest('td');
    if (!td || td.parentNode.children[0] !== td) return;   // only the ID cell opens the menu
    const r = td.parentNode._r;
    if (r) openMenu(r);
  });

  $('rowfilter').oninput = () => { filter = parseFilter($('rowfilter').value); apply(); };
  $('rowhall').onclick = () => { for (const r of rows.values()) hidden.add(r.key); note = ''; apply(); };
  $('rowsall').onclick = () => { hidden.clear(); solo = null; note = ''; apply(); };
  $('rowsolo').onclick = () => { solo = null; apply(); };
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