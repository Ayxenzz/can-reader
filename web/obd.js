// OBD controller. Starts and stops polling on the board, asks which PIDs the car supports, builds
// the poll list from the rows you have not paused, and adds the standard PID formulas to the OBD
// table. The values themselves are shown by the OBD table, as formula cells you can edit.
// Every request is a read. The board refuses anything else.

// Standard PIDs as formulas. b0 is the first data byte. Each entry is [formula, label], a second
// entry goes in the second column.
const pct = (n = 'b0') => 'round(' + n + ' * 100 / 255, 1) + " %"';
const trim = (n = 'b0') => 'round((' + n + ' - 128) * 100 / 128, 1) + " %"';
const o2 = (hi, i) => '(bit(b0, ' + i + ') ? "' + hi + (i % 4 + 1) + ' " : "")';
const codes = '(b0 ? dtc(b1, b2) + (b0 > 1 ? " " + dtc(b3, b4) : "") + (b0 > 2 ? " " + dtc(b5, b6) : "") : "none")';
export const PRESET = {
  '0101': [['(bit(b0, 7) ? "light on" : "light off") + ", " + (b0 & 127) + ((b0 & 127) === 1 ? " code" : " codes")', 'warning light']],
  '0103': [['map(b0, {1: "open loop, cold", 2: "closed loop", 4: "open loop, load", 8: "open loop, fault", 16: "closed loop, fault"})', 'fuel system']],
  '0104': [[pct(), 'load']],
  '0105': [['(b0 - 40) + " °C"', 'coolant']],
  '0106': [[trim(), 'short trim']],
  '0107': [[trim(), 'long trim']],
  '010A': [['b0 * 3 + " kPa"', 'fuel pressure']],
  '010B': [['b0 + " kPa"', 'manifold']],
  '010C': [['round(be(b0, b1) / 4) + " rpm"', 'engine']],
  '010D': [['b0 + " km/h"', 'speed']],
  '010E': [['round(b0 / 2 - 64, 1) + " °"', 'timing']],
  '010F': [['(b0 - 40) + " °C"', 'intake air']],
  '0110': [['round(be(b0, b1) / 100, 2) + " g/s"', 'air flow']],
  '0111': [[pct(), 'throttle']],
  '0113': [[o2('B1S', 0) + ' + ' + o2('B1S', 1) + ' + ' + o2('B1S', 2) + ' + ' + o2('B1S', 3) + ' + ' + o2('B2S', 4) + ' + ' + o2('B2S', 5) + ' + ' + o2('B2S', 6) + ' + ' + o2('B2S', 7), 'O2 sensors']],
  '0115': [['round(b0 / 200, 2) + " V"', 'O2 B1S2'], ['b1 === 255 ? "no trim" : ' + trim('b1'), 'O2 trim']],
  '011F': [['be(b0, b1) + " s"', 'run time']],
  '0121': [['be(b0, b1) + " km"', 'light on for']],
  '012C': [[pct(), 'EGR command']],
  '012D': [[trim(), 'EGR error']],
  '012E': [[pct(), 'purge']],
  '012F': [[pct(), 'fuel level']],
  '0130': [['b0', 'warm-ups']],
  '0131': [['be(b0, b1) + " km"', 'since cleared']],
  '0133': [['b0 + " kPa"', 'barometric']],
  '0134': [['"λ " + round(be(b0, b1) / 32768, 3)', 'O2 B1S1'], ['round(be(b2, b3) / 256 - 128, 2) + " mA"', 'O2 current']],
  '0142': [['round(be(b0, b1) / 1000, 1) + " V"', 'voltage']],
  '0143': [['round(be(b0, b1) * 100 / 255, 1) + " %"', 'absolute load']],
  '0144': [['round(be(b0, b1) / 32768, 3)', 'air/fuel']],
  '0145': [[pct(), 'relative throttle']],
  '0146': [['(b0 - 40) + " °C"', 'ambient']],
  '0147': [[pct(), 'throttle B']],
  '0149': [[pct(), 'pedal D']],
  '014A': [[pct(), 'pedal E']],
  '014C': [[pct(), 'commanded throttle']],
  '014D': [['be(b0, b1) + " min"', 'light on time']],
  '014E': [['be(b0, b1) + " min"', 'since cleared']],
  '015C': [['(b0 - 40) + " °C"', 'oil']],
  '015E': [['round(be(b0, b1) / 20, 2) + " L/h"', 'fuel rate']],
  '03': [[codes, 'stored']],
  '07': [[codes, 'pending']],
  '0A': [[codes, 'permanent']],
};

// The Honda requests that answered on the 2008 Civic R18 engine ECU.
export const HONDA_IDS = ['2600', '2601', '260F', '2610', '2611', '2612', '2620', '2621', '2622', '2623', '2630', '2660', '2661', '2662', '2663', '2664', '2665', '266F', '2670', '2671', '2678', '2679', '267A', '267B', '267E', '267F', 'E401', 'E5FF', 'E600', 'E602', 'E800', 'E80E'];
const PAGES = [0x00, 0x20, 0x40, 0x60, 0x80, 0xa0, 0xc0];
const TWO_BYTE = new Set(['010C', '0110', '011F', '0121', '0131', '0142', '0143', '0144', '014D', '014E', '015E']);
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const hexBytes = (h) => (h ? h.match(/../g).map((x) => parseInt(x, 16)) : []);

// Writes the standard formulas into the table's formula columns. Cells you already have are kept
// unless overwrite is set. Returns how many cells were written.
export function applyPreset(colsApi, { overwrite = false } = {}) {
  const list = colsApi.cols;
  let n = 0;
  for (const [req, items] of Object.entries(PRESET)) {
    items.forEach(([f, label], j) => {
      const name = 'data' + (j + 1);
      let c = list.find((x) => x.name === name);
      if (!c) { c = { name, formula: '', cells: {}, labels: {} }; list.push(c); }
      c.cells = c.cells || {}; c.labels = c.labels || {};
      if (!overwrite && req in c.cells) return;
      c.cells[req] = f;
      c.labels[req] = label;
      n++;
    });
  }
  colsApi.rebuild();
  return n;
}

// Where does this raw value appear in the Honda rows? Byte numbers are the b numbers used in formulas.
export function findValue(rows, value, size) {
  const hits = [];
  for (const [req, r] of rows) {
    if (!req.startsWith('22')) continue;
    const b = r.bytes;
    for (let i = 0; i + size <= b.length; i++) {
      if ((size === 1 ? b[i] : b[i] * 256 + b[i + 1]) === value) hits.push(req.slice(2) + ' b' + i);
    }
  }
  return hits;
}

// The poll list, at most 48 requests. Speed and engine speed are asked twice per round. Requests
// you paused from the OBD table are left out.
export function buildList(supported, { codes, honda, paused }) {
  const std = [...supported].filter((p) => p % 0x20 !== 0).sort((a, b) => a - b).map((p) => '01' + hex2(p));
  const fast = ['010C', '010D'].filter((r) => std.includes(r));
  const list = std.filter((r) => !fast.includes(r));
  if (fast.length) { list.splice(Math.floor(list.length / 2), 0, ...fast); list.unshift(...fast); }   // twice per round
  if (codes) list.push('03', '07', '0A');
  for (const id of new Set(honda)) list.push('22' + id);
  const wanted = list.filter((r) => !paused.has(r));
  const kept = wanted.slice(0, 48);
  return { list: kept, dropped: wanted.length - kept.length };
}

export function initObd({ send, isLive, getTable, kaMs = 2000, discoverMs = 3000 }) {
  const $ = (id) => document.getElementById(id);
  const store = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } };
  const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const cfg = Object.assign({ rate: 20, codes: true, hon: false, hids: '2610 2612 2660' }, store('canreader.obd', {}));
  let supported = new Set(), pages = {}, phase = 'off', msg = 'Off.', kaTimer = 0, discTimer = 0, renderTimer = 0, polling = false;

  const det = document.createElement('details');
  det.innerHTML = `<summary>OBD polling</summary>
    <button id="obdgo">Start polling</button><span id="obdmsg"></span>
    <label><input type="checkbox" id="obdcodes" style="width:auto;margin:0 6px 0 0">Read trouble codes</label><br>
    <label><input type="checkbox" id="obdhon" style="width:auto;margin:0 6px 0 0">Poll Honda data</label>
    <input id="obdhids" placeholder="Honda requests, for example 2610 2612 2660">
    <input id="obdrate" placeholder="requests per second, 1 to 40">
    <button id="obdpreset">Add standard PID formulas</button><button id="obdreset">Reset them to the standard ones</button><span id="obdpmsg"></span>
    <details><summary>Find a value in the Honda rows</summary>
      <select id="obdfrow"></select>
      <input id="obdfval" placeholder="raw value to find, decimal or 0x hex">
      <select id="obdfsize"><option value="1">1 byte</option><option value="2">2 bytes, big endian</option></select>
      <button id="obdfgo">Find</button>
      <pre id="obdfout"></pre>
    </details>`;
  $('logbox').before(det);
  $('obdcodes').checked = cfg.codes;
  $('obdhon').checked = cfg.hon;
  $('obdhids').value = cfg.hids;
  $('obdrate').value = String(cfg.rate);

  const readCfg = () => {
    cfg.codes = $('obdcodes').checked; cfg.hon = $('obdhon').checked; cfg.hids = $('obdhids').value.trim();
    const r = parseInt($('obdrate').value, 10); cfg.rate = r >= 1 && r <= 40 ? r : 20;
    keep('canreader.obd', cfg);
  };
  const hondaIds = () => (cfg.hon ? cfg.hids.toUpperCase().split(/[\s,]+/).filter((x) => /^[0-9A-F]{4}$/.test(x)) : []);
  const pausedSet = () => { const t = getTable(); return t ? t.paused() : new Set(); };
  const list = () => buildList(supported, { codes: cfg.codes, honda: hondaIds(), paused: pausedSet() });

  // ---- talking to the board ----
  const later = () => { if (!renderTimer) renderTimer = setTimeout(render, 250); };
  const say = (m) => { msg = m; later(); };
  const stopTimers = () => { clearInterval(kaTimer); clearTimeout(discTimer); kaTimer = discTimer = 0; };
  const idle = () => { polling = false; phase = 'off'; stopTimers(); $('obdgo').textContent = 'Start polling'; };
  async function sendList() {
    readCfg();
    const { list: l, dropped } = list();
    if (!l.length) { say('Nothing to poll.'); return; }
    await send('poll ' + cfg.rate + ' ' + l.join(' ') + '\n');
    say('Polling ' + l.length + ' requests' + (dropped ? ', ' + dropped + ' left out because the board takes 48' : '') + '.');
  }
  function beginPolling() {
    phase = 'poll';
    clearInterval(kaTimer);
    kaTimer = setInterval(() => send('ka\n'), kaMs);
    sendList();
  }
  function finishDiscover() {
    clearTimeout(discTimer);
    if (phase !== 'discover') return;
    supported = new Set();
    for (const p of PAGES) {
      const b = pages[p];
      if (!b || b.length < 6) continue;
      for (let i = 0; i < 32; i++) if ((b[2 + (i >> 3)] >> (7 - (i & 7))) & 1) supported.add(p + 1 + i);
    }
    if (!pages[0x00]) { idle(); send('poll off\n'); say('The engine computer did not answer. Is the engine running, and is the board on the OBD port?'); return; }
    beginPolling();
  }
  async function start() {
    if (!isLive()) { say('Connect to the board first.'); return; }
    readCfg();
    polling = true; phase = 'discover'; pages = {};
    $('obdgo').textContent = 'Stop polling';
    say('Asking which PIDs the car supports...');
    clearInterval(kaTimer);
    kaTimer = setInterval(() => send('ka\n'), kaMs);
    discTimer = setTimeout(finishDiscover, discoverMs);
    await send('poll 20 ' + PAGES.map((p) => '01' + hex2(p)).join(' ') + '\n');
  }
  async function stop(why) {
    const was = polling;
    idle();
    if (was) { try { await send('poll off\n'); } catch (e) {} }
    say(why || 'Off.');
  }
  $('obdgo').onclick = () => (polling ? stop() : start());
  for (const id of ['obdcodes', 'obdhon', 'obdhids', 'obdrate']) $(id).onchange = () => { readCfg(); if (polling && phase === 'poll') sendList(); };

  // ---- lines from the board ----
  const OKBYTE = { '01': 0x41, '22': 0x62, '03': 0x43, '07': 0x47, '0A': 0x4a };
  function onLine(s) {
    if (s.startsWith('# poll')) {
      if (/^# poll (stopped|aborted|cannot|refused|no answers|restart)/.test(s) && polling && !/^# poll stopped$/.test(s)) idle();
      if (/^# poll (rejected|refused|no answers|aborted|cannot|stopped, )/.test(s)) say(s.slice(2));
      else later();
      return true;
    }
    if (!s.startsWith('# obd ')) return false;
    const p = s.split(' ');            // # obd 10 010C ok 4 410C0BF4
    const req = p[3], st = p[4];
    const bytes = st === 'ok' ? hexBytes(p[6] || '') : [];
    const isPage = req.length === 4 && req.startsWith('01') && PAGES.includes(parseInt(req.slice(2), 16));
    if (isPage && phase === 'discover') {
      const pid = parseInt(req.slice(2), 16);
      pages[pid] = st === 'ok' && bytes[0] === 0x41 && bytes[1] === pid ? bytes : null;
      if (PAGES.every((q) => q in pages)) finishDiscover();
    }
    const t = getTable();
    const svc = req.length === 2 ? req : req.slice(0, 2);
    const shape = req.length === 4 ? svc === '01' : req.length === 6 ? svc === '22' : req.length === 2;
    const echoed = svc !== '01' || bytes[1] === parseInt(req.slice(2), 16);
    if (t && st === 'ok' && !isPage && shape && bytes[0] === OKBYTE[svc] && echoed) t.feed(req, bytes);
    return true;
  }

  // ---- display and tools ----
  function render() {
    renderTimer = 0;
    $('obdmsg').textContent = '  ' + msg;
    const t = getTable();
    const keepRow = $('obdfrow').value;
    const opts = t ? [...t.rows.keys()].filter((k) => k.startsWith('01') && k.length === 4).sort().map((k) => { const o = new Option(k.slice(0, 2) + ' ' + k.slice(2)); o.value = k; return o; }) : [];
    $('obdfrow').replaceChildren(...opts);
    if (keepRow) $('obdfrow').value = keepRow;
  }
  $('obdfrow').onchange = () => {
    const t = getTable(), k = $('obdfrow').value, r = t && t.rows.get(k);
    if (!r || !r.bytes.length) return;
    const two = TWO_BYTE.has(k) && r.bytes.length >= 2;
    $('obdfsize').value = two ? '2' : '1';
    $('obdfval').value = String(two ? r.bytes[0] * 256 + r.bytes[1] : r.bytes[0]);
  };
  $('obdfgo').onclick = () => {
    const t = getTable();
    const s = $('obdfval').value.trim(), v = /^0x/i.test(s) ? parseInt(s, 16) : Number(s), size = parseInt($('obdfsize').value, 10);
    if (s === '' || Number.isNaN(v)) { $('obdfout').textContent = 'Enter a number, like 123 or 0x7B.'; return; }
    const hon = t ? [...t.rows.keys()].filter((k) => k.startsWith('22')).length : 0;
    const hits = t ? findValue(t.rows, v, size) : [];
    $('obdfout').textContent = hits.length ? hits.join('   ') : 'Not found in the ' + hon + ' Honda rows.';
  };
  $('obdpreset').onclick = () => { const n = applyPreset(getTable().cols); $('obdpmsg').textContent = ' Added ' + n + ' formulas. Rows fill in as the car answers.'; };
  $('obdreset').onclick = () => { const n = applyPreset(getTable().cols, { overwrite: true }); $('obdpmsg').textContent = ' Reset ' + n + ' formulas.'; };

  render();
  return {
    onLine,
    repoll: () => { if (polling && phase === 'poll') sendList(); },   // the paused rows changed
    disconnected: () => { if (polling) { idle(); say('Disconnected.'); } },
    state: () => ({ polling, phase, supported: [...supported] }),
  };
}