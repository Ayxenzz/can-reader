// Tap-to-edit. Tap a cell under a formula column to type that row's formula and an optional
// label. Tap a column header to rename it, set a default formula for every row, hide or delete
// it. Tap the + at the end of the header row to add a column.
export function initCells({ getCols, rebuild, check, preview }) {
  const $ = (id) => document.getElementById(id);
  const sheet = document.createElement('div');
  sheet.style.cssText = 'position:fixed;left:0;right:0;bottom:0;max-height:75vh;overflow:auto;padding:12px;background:Canvas;color:CanvasText;border-top:1px solid #8886;display:none;z-index:6';
  document.body.appendChild(sheet);

  const el = (tag, text, props) => {
    const e = document.createElement(tag);
    if (text) e.textContent = text;
    if (props) Object.assign(e, props);
    return e;
  };
  const close = () => { sheet.style.display = 'none'; sheet.replaceChildren(); };
  const open = (...kids) => { sheet.replaceChildren(...kids); sheet.style.display = 'block'; };
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const refRe = (name) => new RegExp('\\[\\s*' + esc(name) + '\\s*\\]', 'gi');
  const badName = (name, except) => {
    if (!name) return 'Enter a name.';
    if (/[\[\]]/.test(name)) return 'Names cannot contain [ or ].';
    if (getCols().some((c) => c !== except && c.name.toLowerCase() === name.toLowerCase())) return 'That name is already used.';
    return '';
  };
  const btn = (label, fn) => el('button', label, { onclick: fn });
  const title = (text) => { const e = el('div', text); e.style.fontWeight = 'bold'; return e; };

  // ---- one cell ----
  function openCell(r, ci) {
    const c = getCols()[ci];
    if (!c) return;
    c.cells = c.cells || {};
    c.labels = c.labels || {};
    const f = el('input', '', { placeholder: 'formula, for example be(b0, b1)', value: c.cells[r.hex] || '' });
    const lab = el('input', '', { placeholder: 'label, for example speed (optional)', value: c.labels[r.hex] || '' });
    const msg = el('div');
    const update = () => {
      const src = f.value.trim() || c.formula;
      if (!src) { msg.textContent = 'No formula yet.'; return; }
      const e = check(src);
      msg.textContent = e ? 'Error: ' + e : 'Now: ' + preview(r, src);
    };
    f.oninput = update;
    const save = () => {
      const src = f.value.trim();
      if (src) { const e = check(src); if (e) { msg.textContent = 'Error: ' + e; return; } }
      if (src) c.cells[r.hex] = src; else delete c.cells[r.hex];
      const l = lab.value.trim();
      if (l) c.labels[r.hex] = l; else delete c.labels[r.hex];
      close();
      rebuild();
    };
    const clear = () => { delete c.cells[r.hex]; delete c.labels[r.hex]; close(); rebuild(); };
    open(
      title(c.name + '  ·  row ' + r.key),
      ...(c.formula ? [el('div', 'Column default: ' + c.formula + '. Leave the formula empty to use it.')] : []),
      f, lab, msg,
      btn('Save', save), btn('Clear', clear), btn('Cancel', close),
    );
    update();
    if (f.focus) f.focus();
  }

  // ---- one column ----
  function openCol(ci) {
    const cols = getCols(), c = cols[ci];
    if (!c) return;
    const name = el('input', '', { placeholder: 'column name', value: c.name });
    const def = el('input', '', { placeholder: 'default formula for every row (optional)', value: c.formula || '' });
    const msg = el('div');
    const own = Object.keys(c.cells || {}).length;
    const save = () => {
      const n = name.value.trim(), f = def.value.trim();
      const bad = badName(n, c);
      if (bad) { msg.textContent = bad; return; }
      if (f) { const e = check(f); if (e) { msg.textContent = 'Error: ' + e; return; } }
      if (n !== c.name) {   // formulas that use [old name] follow the rename
        const re = refRe(c.name);
        for (const o of cols) {
          if (o.formula) o.formula = o.formula.replace(re, () => '[' + n + ']');
          for (const k of Object.keys(o.cells || {})) o.cells[k] = o.cells[k].replace(re, () => '[' + n + ']');
        }
        c.name = n;
      }
      c.formula = f;
      close();
      rebuild();
    };
    const del = () => {
      const re = refRe(c.name);
      let refs = 0;
      for (const o of cols) {
        if (o === c) continue;
        if (o.formula && re.test(o.formula)) refs++;
        re.lastIndex = 0;
        for (const k of Object.keys(o.cells || {})) { if (re.test(o.cells[k])) refs++; re.lastIndex = 0; }
      }
      if (!confirm('Delete column ' + c.name + ' and its ' + own + ' row formulas?' + (refs ? ' ' + refs + ' other formulas use it and will show errors.' : ''))) return;
      cols.splice(cols.indexOf(c), 1);
      close();
      rebuild();
    };
    open(
      title('Column  ·  ' + own + ' row formulas'),
      name, def, msg,
      btn('Save', save),
      btn(c.hidden ? 'Show' : 'Hide', () => { c.hidden = !c.hidden; close(); rebuild(); }),
      btn('Delete', del), btn('Cancel', close),
    );
  }

  function addColumn() {
    const n = (prompt('Column name, for example data1') || '').trim();
    if (!n) return;
    const bad = badName(n, null);
    if (bad) { alert(bad); return; }
    getCols().push({ name: n, formula: '', cells: {}, labels: {} });
    rebuild();
  }

  $('body').addEventListener('click', (e) => {
    const td = e.target.closest && e.target.closest('td');
    if (!td || td._ci === undefined) return;
    const r = td.parentNode._r;
    if (r) openCell(r, td._ci);
  });
  $('head').addEventListener('click', (e) => {
    const th = e.target.closest && e.target.closest('th');
    if (!th) return;
    if (th._plus) addColumn();
    else if (th._ci !== undefined) openCol(th._ci);
  });
  return { close };
}