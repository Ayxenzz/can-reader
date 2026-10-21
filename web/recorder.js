// Recording. Frames are written to IndexedDB in small chunks as they arrive, so a crash or a
// frozen page loses at most a couple of seconds. Saving builds one CSV file from the chunks.
// File format: header row, then one line per frame exactly as the board sent it
// (ts_us,id_hex,ext,dlc,data_hex). Lines starting with # are notes, such as connects and stalls.
const HEADER = 'ts_us,id,ext,dlc,data\n';
const MIN_FREE = 30 * 1024 * 1024;

export function initRecorder({ ev, setFrameTap, setEvTap }) {
  const $ = (id) => document.getElementById(id);
  const p2 = (n) => String(n).padStart(2, '0');
  const size = (b) => (b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
  const mmss = (s) => p2(Math.floor(s / 60)) + ':' + p2(Math.floor(s % 60));
  const done = (t) => new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted')); });
  const ask = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const range = (id) => IDBKeyRange.bound([id, 0], [id, Infinity]);

  const dbp = new Promise((res, rej) => {
    const q = indexedDB.open('canreader-rec', 1);
    q.onupgradeneeded = () => {
      q.result.createObjectStore('recs', { keyPath: 'id' });
      q.result.createObjectStore('chunks', { keyPath: ['rec', 'n'] });
    };
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  dbp.catch((e) => ev('recorder storage unavailable ' + (e && e.name || e)));

  let cur = null, buf = [], chain = Promise.resolve(), armed = false, tick = 0;
  let auto = false;
  try { auto = localStorage.getItem('canreader.recauto') === '1'; } catch (e) {}

  // ---- page elements ----
  const recBtn = document.createElement('button');
  recBtn.id = 'recbtn';
  recBtn.textContent = 'Record';
  $('btn').after(recBtn);
  const det = document.createElement('details');
  det.innerHTML = `<summary>Recordings</summary>
    <label><input type="checkbox" id="rauto" style="width:auto;margin:0 6px 0 0">Record automatically when connected</label>
    <pre id="rstat"></pre><pre id="rspace"></pre><div id="rmsg"></div><div id="rlist"></div>`;
  $('logbox').before(det);
  $('rauto').checked = auto;
  const note = (m) => { $('rmsg').textContent = m; };

  // ---- writing ----
  const enqueue = (fn) => (chain = chain.then(fn).catch(failed));
  function failed(e) {
    ev('recording error ' + (e && e.name || e));
    note('Recording error. ' + (e && e.name || e) + '. Recording stopped.');
    cur = null; buf = [];
    render();
  }
  async function writeChunk(r, n, text) {
    const db = await dbp;
    const t = db.transaction(['chunks', 'recs'], 'readwrite');
    t.objectStore('chunks').put({ rec: r.id, n, blob: new Blob([text]) });
    t.objectStore('recs').put({ ...r });
    await done(t);
  }
  function flush() {
    if (!cur || !buf.length) return chain;
    const r = cur, text = buf.join('');
    buf = [];
    const n = r.chunks++;
    r.bytes += text.length;
    r.last = Date.now();
    return enqueue(() => writeChunk(r, n, text));
  }

  function start(why) {
    if (cur) return;
    const d = new Date();
    cur = {
      id: Date.now(), start: Date.now(), last: Date.now(), frames: 0, bytes: 0, chunks: 0, closed: false,
      name: 'can-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '.csv',
    };
    buf = [HEADER];
    ev('recording started ' + cur.name + (why ? ' (' + why + ')' : ''));
    flush();
    render();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().then((p) => ev('storage persist ' + p)); } catch (e) {}
  }

  async function stop(why) {
    if (!cur) return;
    const r = cur;
    ev('recording stopped ' + r.name + (why ? ' (' + why + ')' : '') + ' ' + r.frames + ' frames');
    flush();
    cur = null;
    await enqueue(async () => {
      r.closed = true;
      const db = await dbp;
      const t = db.transaction('recs', 'readwrite');
      t.objectStore('recs').put({ ...r });
      await done(t);
    });
    render();
  }

  setFrameTap((line) => {
    if (!cur) {
      if (!(auto && armed)) return;
      armed = false;
      start('auto');
    }
    buf.push(line + '\n');
    cur.frames++;
    if (buf.length >= 2000) flush();
  });
  setEvTap((m) => {
    if (m.startsWith('connected')) armed = true;
    if (cur) buf.push('# ' + new Date().toTimeString().slice(0, 8) + ' ' + m + '\n');
  });

  // ---- saving and deleting ----
  async function save(r) {
    let handle = null;
    if ('showSaveFilePicker' in window) {
      try { handle = await showSaveFilePicker({ suggestedName: r.name, types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }] }); }
      catch (e) { if (e.name === 'AbortError') { note('Cancelled.'); return; } note('Picker failed (' + e.name + '), downloading instead.'); }
    }
    note('Preparing ' + r.name + '...');
    let blob;
    try {
      const db = await dbp;
      const items = await ask(db.transaction('chunks').objectStore('chunks').getAll(range(r.id)));
      items.sort((a, b) => a.n - b.n);
      blob = new Blob(items.map((x) => x.blob), { type: 'text/csv' });
    } catch (e) { note('Could not read the recording. ' + (e && e.name || e)); return; }
    if (handle) {
      try {
        const w = await handle.createWritable();
        await blob.stream().pipeTo(w);
        note('Saved ' + r.name + ' (' + size(blob.size) + ').');
        ev('recording saved ' + r.name);
        return;
      } catch (e) { note('Write failed (' + (e && e.name || e) + '), downloading instead.'); }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = r.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    note('Download started for ' + r.name + '. Check your Downloads.');
  }

  async function del(r) {
    if (cur && cur.id === r.id) { note('Stop the recording first.'); return; }
    if (!confirm('Delete ' + r.name + '?')) return;
    try {
      await chain;
      const db = await dbp;
      const t = db.transaction(['recs', 'chunks'], 'readwrite');
      t.objectStore('chunks').delete(range(r.id));
      t.objectStore('recs').delete(r.id);
      await done(t);
      note('Deleted ' + r.name + '.');
    } catch (e) { note('Delete failed. ' + (e && e.name || e)); }
    render();
  }

  // ---- display ----
  const mkBtn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; return b; };
  async function render() {
    recBtn.textContent = cur ? 'Stop rec' : 'Record';
    recBtn.style.color = cur ? '#e5484d' : '';
    let recs = [];
    try { const db = await dbp; recs = await ask(db.transaction('recs').objectStore('recs').getAll()); } catch (e) {}
    recs.sort((a, b) => b.id - a.id);
    $('rlist').replaceChildren(...recs.map((r) => {
      const div = document.createElement('div');
      div.style.margin = '8px 0';
      const t = document.createElement('div');
      const state = r.closed ? '' : cur && cur.id === r.id ? '  recording' : '  interrupted';
      t.textContent = r.name + '  ' + mmss((r.last - r.start) / 1000) + '  ' + r.frames + ' frames  ' + size(r.bytes) + state;
      div.append(t, mkBtn('Save', () => save(r)), mkBtn('Delete', () => del(r)));
      return div;
    }));
  }

  async function checkSpace() {
    try {
      const e = await navigator.storage.estimate();
      $('rspace').textContent = 'Storage ' + size(e.usage) + ' used of ' + size(e.quota);
      if (cur && e.quota - e.usage < MIN_FREE) stop('storage nearly full');
    } catch (err) {}
  }

  recBtn.onclick = () => (cur ? stop('manual') : start('manual'));
  $('rauto').onchange = () => {
    auto = $('rauto').checked;
    try { localStorage.setItem('canreader.recauto', auto ? '1' : '0'); } catch (e) {}
    if (auto) armed = true;   // start with the next frame if nothing is recording
  };

  setInterval(() => {
    tick++;
    if (tick % 2 === 0) flush();
    $('rstat').textContent = cur
      ? 'Recording ' + mmss((Date.now() - cur.start) / 1000) + '  ' + cur.frames + ' frames  ' + size(cur.bytes)
      : 'Not recording.';
    if (tick % 10 === 0) checkSpace();
  }, 1000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  window.addEventListener('pagehide', flush);
  checkSpace();
  render();
  return { start, stop };
}