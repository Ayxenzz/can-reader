const KEY = 'canreader.profiles', CUR = 'canreader.profile';

// A profile is { cols, hidden } where hidden lists row keys. Older backups held just the cols array.
export function initExtras({ getCols, setCols, getHidden, setHidden, setTap, ev }) {
  const $ = (id) => document.getElementById(id);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const norm = (p) => (Array.isArray(p)
    ? { cols: p, hidden: [] }
    : { cols: Array.isArray(p && p.cols) ? p.cols : [], hidden: Array.isArray(p && p.hidden) ? p.hidden : [] });
  let profiles = {}, cur = 'default';
  try { profiles = JSON.parse(localStorage.getItem(KEY) || '{}'); cur = localStorage.getItem(CUR) || 'default'; } catch (e) {}
  for (const k of Object.keys(profiles)) profiles[k] = norm(profiles[k]);
  const live = () => ({ cols: clone(getCols()), hidden: [...getHidden()] });
  if (!profiles[cur]) profiles[cur] = live(); else setHidden(profiles[cur].hidden);
  const load = (p) => { setCols(clone(p.cols)); setHidden(p.hidden); };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(profiles)); localStorage.setItem(CUR, cur); } catch (e) {} };
  const sync = () => { profiles[cur] = live(); };

  const add = (html) => {
    const d = document.createElement('details');
    d.innerHTML = html;
    $('logbox').before(d);
  };
  add(`<summary>Profiles and backup</summary>
    <select id="psel"></select>
    <button id="pnew">New</button><button id="pdel">Delete</button><button id="pexp">Copy backup</button>
    <textarea id="pbox" rows="3" style="width:100%;box-sizing:border-box" placeholder="Paste a backup here"></textarea>
    <button id="pimp">Import</button><span id="pmsg"></span>`);
  add(`<summary>Diff</summary>
    <button id="dn">Record noise</button><button id="da">Record action</button><button id="dc">Clear</button>
    <pre>Record noise with nothing touched, then record the action. Bits that changed only during the action are listed.</pre>
    <pre id="dout"></pre>`);

  // ---- profiles ----
  const sel = $('psel'), msg = $('pmsg');
  const fill = () => { sel.replaceChildren(...Object.keys(profiles).map((n) => new Option(n))); sel.value = cur; };
  fill();
  setInterval(() => { if (JSON.stringify(live()) !== JSON.stringify(profiles[cur])) { sync(); save(); } }, 2000);
  sel.onchange = () => { sync(); cur = sel.value; load(profiles[cur]); save(); ev('profile ' + cur); };
  $('pnew').onclick = () => {
    const n = (prompt('Profile name') || '').trim();
    if (!n || profiles[n]) return;
    sync(); cur = n; profiles[n] = { cols: [], hidden: [] }; load(profiles[n]); fill(); save();
  };
  $('pdel').onclick = () => {
    if (Object.keys(profiles).length < 2) { msg.textContent = 'Keep at least one profile.'; return; }
    delete profiles[cur]; cur = Object.keys(profiles)[0]; load(profiles[cur]); fill(); save();
  };
  $('pexp').onclick = async () => {
    sync();
    try { await navigator.clipboard.writeText(JSON.stringify({ profiles, cur })); msg.textContent = 'Copied.'; }
    catch (e) { $('pbox').value = JSON.stringify({ profiles, cur }); msg.textContent = 'Copy it from the box.'; }
  };
  $('pimp').onclick = () => {
    try {
      const d = JSON.parse($('pbox').value);
      if (!d || typeof d.profiles !== 'object') throw new Error('not a backup');
      for (const [k, v] of Object.entries(d.profiles)) profiles[k] = norm(v);
      if (profiles[d.cur]) cur = d.cur;
      load(profiles[cur]); fill(); save(); msg.textContent = 'Imported.';
    } catch (e) { msg.textContent = 'Import failed. ' + e.message; }
  };

  // ---- interval diff, noise bits are subtracted ----
  let mode = null;
  const rec = { noise: new Map(), action: new Map() };
  setTap((r, i, x) => {
    if (!mode) return;
    const k = r.hex + (r.ext === '1' ? 'x' : '') + ' b' + i, m = rec[mode];
    m.set(k, (m.get(k) || 0) | x);
  });
  const labels = { noise: 'Record noise', action: 'Record action' };
  const show = () => {
    const out = [];
    for (const [k, m] of rec.action) {
      const d = m & ~(rec.noise.get(k) || 0) & 255;
      if (d) out.push(k + '  0x' + d.toString(16).toUpperCase().padStart(2, '0') + '  ' + d.toString(2).padStart(8, '0'));
    }
    out.sort();
    $('dout').textContent = (out.join('\n') || 'No bits changed beyond the noise.') +
      '\n(noise ' + rec.noise.size + ' bytes, action ' + rec.action.size + ' bytes)';
  };
  const toggle = (name, btnId) => {
    if (mode === name) { mode = null; $(btnId).textContent = labels[name]; show(); return; }
    mode = name; rec[name].clear();
    $('dn').textContent = labels.noise; $('da').textContent = labels.action;
    $(btnId).textContent = 'Stop ' + name;
  };
  $('dn').onclick = () => toggle('noise', 'dn');
  $('da').onclick = () => toggle('action', 'da');
  $('dc').onclick = () => { mode = null; rec.noise.clear(); rec.action.clear(); $('dout').textContent = ''; $('dn').textContent = labels.noise; $('da').textContent = labels.action; };
}