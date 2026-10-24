const KEY = 'canreader.profiles', CUR = 'canreader.profile';

// A profile is { cols, hidden, view } where hidden lists row keys and view holds hidden and muted columns
// and cells. Older backups held just the cols array.
export function initExtras({ getCols, setCols, getHidden, setHidden, getView, setView, showOnly, setTap, ev }) {
  const $ = (id) => document.getElementById(id);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const list = (a) => (Array.isArray(a) ? a : []);
  const normView = (v) => ({ hide: list(v && v.hide), mute: list(v && v.mute), cells: list(v && v.cells) });
  const norm = (p) => (Array.isArray(p)
    ? { cols: p, hidden: [], view: normView() }
    : { cols: list(p && p.cols), hidden: list(p && p.hidden), view: normView(p && p.view) });
  let profiles = {}, cur = 'default';
  try { profiles = JSON.parse(localStorage.getItem(KEY) || '{}'); cur = localStorage.getItem(CUR) || 'default'; } catch (e) {}
  for (const k of Object.keys(profiles)) profiles[k] = norm(profiles[k]);
  const live = () => ({ cols: clone(getCols()), hidden: [...getHidden()], view: clone(getView()) });
  if (!profiles[cur]) profiles[cur] = live(); else { setHidden(profiles[cur].hidden); setView(profiles[cur].view); }
  const load = (p) => { setCols(clone(p.cols)); setHidden(p.hidden); setView(p.view); };
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
    <button id="dshow">Show only changed rows</button>
    <pre>Record noise with nothing touched, 20 seconds or more, in the same ignition state. Then record the action. Bits that changed only during the action are listed, and counters and checksums drop out because they also changed during the noise.</pre>
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
    sync(); cur = n; profiles[n] = { cols: [], hidden: [], view: normView() }; load(profiles[n]); fill(); save();
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
  let diffKeys = new Set();
  const show = () => {
    const out = [];
    diffKeys = new Set();
    for (const [k, m] of rec.action) {
      const d = m & ~(rec.noise.get(k) || 0) & 255;
      if (d) { out.push(k + '  0x' + d.toString(16).toUpperCase().padStart(2, '0') + '  ' + d.toString(2).padStart(8, '0')); diffKeys.add(k.split(' ')[0]); }
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
  $('dshow').onclick = () => {
    if (!diffKeys.size) { $('dout').textContent = 'Record noise, then an action, first. No rows changed beyond the noise.'; return; }
    showOnly([...diffKeys]);
  };
  $('dc').onclick = () => { mode = null; diffKeys = new Set(); rec.noise.clear(); rec.action.clear(); $('dout').textContent = ''; $('dn').textContent = labels.noise; $('da').textContent = labels.action; };
}