// OBD section. Starts and stops polling on the board, decodes standard PIDs into names and
// values, shows trouble codes, keeps the Honda answers for searching, and lets you define your own
// signals from any byte of a Honda answer. All requests are reads, the board refuses anything else.

const U = (name, unit, n, f, d = 0) => ({ name, unit, n, f, d });
const pct = (x) => (x * 100) / 255;
const ab = (b) => b[0] * 256 + b[1];
const trim = (x) => ((x - 128) * 100) / 128;
const num = (x, d = 0) => (d ? String(Number(x.toFixed(d))) : x.toFixed(0));
const FUEL = { 1: 'open loop, cold', 2: 'closed loop', 4: 'open loop, load', 8: 'open loop, fault', 16: 'closed loop, fault' };

export const PIDS = {
  0x01: { name: 'Warning light and codes', n: 1, text: (b) => (b[0] & 0x80 ? 'light on' : 'light off') + ', ' + (b[0] & 0x7f) + (((b[0] & 0x7f) === 1) ? ' code' : ' codes') },
  0x03: { name: 'Fuel system status', n: 1, text: (b) => FUEL[b[0]] || 'status ' + b[0] },
  0x04: U('Engine load', '%', 1, (b) => pct(b[0]), 1),
  0x05: U('Coolant temperature', '°C', 1, (b) => b[0] - 40),
  0x06: U('Short term fuel trim', '%', 1, (b) => trim(b[0]), 1),
  0x07: U('Long term fuel trim', '%', 1, (b) => trim(b[0]), 1),
  0x0a: U('Fuel pressure', 'kPa', 1, (b) => b[0] * 3),
  0x0b: U('Intake manifold pressure', 'kPa', 1, (b) => b[0]),
  0x0c: U('Engine speed', 'rpm', 2, (b) => ab(b) / 4),
  0x0d: U('Vehicle speed', 'km/h', 1, (b) => b[0]),
  0x0e: U('Timing advance', '°', 1, (b) => b[0] / 2 - 64, 1),
  0x0f: U('Intake air temperature', '°C', 1, (b) => b[0] - 40),
  0x10: U('Air flow', 'g/s', 2, (b) => ab(b) / 100, 2),
  0x11: U('Throttle position', '%', 1, (b) => pct(b[0]), 1),
  0x13: { name: 'Oxygen sensors present', n: 1, text: (b) => { const o = []; for (let i = 0; i < 8; i++) if (b[0] & (1 << i)) o.push('B' + (i < 4 ? 1 : 2) + 'S' + ((i % 4) + 1)); return o.join(', ') || 'none'; } },
  0x15: { name: 'Oxygen sensor B1S2', n: 2, text: (b) => num(b[0] / 200, 2) + ' V' + (b[1] !== 0xff ? ', trim ' + num(trim(b[1]), 1) + ' %' : '') },
  0x1f: U('Run time since start', 's', 2, ab),
  0x21: U('Distance with warning light on', 'km', 2, ab),
  0x2c: U('Commanded EGR', '%', 1, (b) => pct(b[0]), 1),
  0x2d: U('EGR error', '%', 1, (b) => trim(b[0]), 1),
  0x2e: U('Commanded purge', '%', 1, (b) => pct(b[0]), 1),
  0x2f: U('Fuel level', '%', 1, (b) => pct(b[0]), 1),
  0x30: U('Warm-ups since codes cleared', '', 1, (b) => b[0]),
  0x31: U('Distance since codes cleared', 'km', 2, ab),
  0x33: U('Barometric pressure', 'kPa', 1, (b) => b[0]),
  0x34: { name: 'Oxygen sensor B1S1 (wide)', n: 4, text: (b) => 'λ ' + num(ab(b) / 32768, 3) + ', ' + num((b[2] * 256 + b[3]) / 256 - 128, 2) + ' mA' },
  0x42: U('Control module voltage', 'V', 2, (b) => ab(b) / 1000, 1),
  0x43: U('Absolute load', '%', 2, (b) => (ab(b) * 100) / 255, 1),
  0x44: U('Commanded air/fuel ratio', 'λ', 2, (b) => ab(b) / 32768, 3),
  0x45: U('Relative throttle', '%', 1, (b) => pct(b[0]), 1),
  0x46: U('Ambient temperature', '°C', 1, (b) => b[0] - 40),
  0x47: U('Absolute throttle B', '%', 1, (b) => pct(b[0]), 1),
  0x49: U('Accelerator pedal D', '%', 1, (b) => pct(b[0]), 1),
  0x4a: U('Accelerator pedal E', '%', 1, (b) => pct(b[0]), 1),
  0x4c: U('Commanded throttle', '%', 1, (b) => pct(b[0]), 1),
  0x4d: U('Time with warning light on', 'min', 2, ab),
  0x4e: U('Time since codes cleared', 'min', 2, ab),
  0x5c: U('Oil temperature', '°C', 1, (b) => b[0] - 40),
  0x5e: U('Fuel rate', 'L/h', 2, (b) => ab(b) / 20, 2),
};

// The Honda requests that answered on the 2008 Civic R18 engine ECU.
export const HONDA_IDS = ['2600', '2601', '260F', '2610', '2611', '2612', '2620', '2621', '2622', '2623', '2630', '2660', '2661', '2662', '2663', '2664', '2665', '266F', '2670', '2671', '2678', '2679', '267A', '267B', '267E', '267F', 'E401', 'E5FF', 'E600', 'E602', 'E800', 'E80E'];
const PAGES = [0x00, 0x20, 0x40, 0x60, 0x80, 0xa0, 0xc0];
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const hexBytes = (h) => (h ? h.match(/../g).map((x) => parseInt(x, 16)) : []);

// data are the bytes after "41 PP". Returns text such as "83 °C", or null if unknown or too short.
export function decode(pid, data) {
  const p = PIDS[pid];
  if (!p || data.length < p.n) return null;
  if (p.text) return p.text(data);
  return num(p.f(data), p.d) + (p.unit ? ' ' + p.unit : '');
}

// Bytes start at the service byte (43, 47 or 4A), then a count, then two bytes per code.
export function dtcs(bytes) {
  const out = [];
  for (let i = 2; i + 1 < bytes.length; i += 2) {
    const hi = bytes[i], lo = bytes[i + 1];
    if (!hi && !lo) continue;
    out.push('PCBU'[hi >> 6] + ((hi >> 4) & 3) + (hi & 15).toString(16).toUpperCase() + hex2(lo));
  }
  return out;
}

// Where does this raw value appear in the Honda answers? Index 0 is the 62 at the start of a reply.
export function findValue(honda, value, size) {
  const hits = [];
  for (const [id, r] of honda) {
    const b = r.bytes;
    for (let i = 3; i + size <= b.length; i++) {
      if ((size === 1 ? b[i] : b[i] * 256 + b[i + 1]) === value) hits.push(id + '[' + i + ']');
    }
  }
  return hits;
}

// The poll list, at most 48 requests. Speed and engine speed are asked twice per round.
export function buildList(supported, { codes, honda, extra }) {
  const std = [...supported].filter((p) => p % 0x20 !== 0).sort((a, b) => a - b).map((p) => '01' + hex2(p));
  const fast = ['010C', '010D'].filter((r) => std.includes(r));
  const list = std.filter((r) => !fast.includes(r));
  if (fast.length) { list.splice(Math.floor(list.length / 2), 0, ...fast); list.unshift(...fast); }   // twice per round
  if (codes) list.push('03', '07', '0A');
  const h = new Set([...honda, ...extra]);
  for (const id of h) list.push('22' + id);
  const kept = list.slice(0, 48);
  return { list: kept, dropped: list.length - kept.length };
}

export function initObd({ send, ev, isLive, kaMs = 2000, discoverMs = 3000 }) {
  const $ = (id) => document.getElementById(id);
  const store = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } };
  const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const cfg = Object.assign({ rate: 20, codes: true, hon: false, hids: '2610 2612 2660' }, store('canreader.obd', {}));
  let sigs = store('canreader.obdsigs', []);
  const vals = new Map(), honda = new Map(), codeText = { '03': '', '07': '', '0A': '' };
  let supported = new Set(), pages = {}, phase = 'off', msg = 'Off.', kaTimer = 0, discTimer = 0, renderTimer = 0, polling = false;

  const det = document.createElement('details');
  det.innerHTML = `<summary>OBD</summary>
    <button id="obdgo">Start polling</button><span id="obdmsg"></span>
    <label><input type="checkbox" id="obdcodes" style="width:auto;margin:0 6px 0 0">Read trouble codes</label><br>
    <label><input type="checkbox" id="obdhon" style="width:auto;margin:0 6px 0 0">Poll Honda data</label>
    <input id="obdhids" placeholder="Honda requests, for example 2610 2612 2660">
    <input id="obdrate" placeholder="requests per second, 1 to 40">
    <table><tbody id="obdtab"></tbody></table>
    <pre id="obdcodeout"></pre>
    <details><summary>Honda answers</summary>
      <select id="obdhsel"></select>
      <pre id="obdhbytes"></pre>
      <select id="obdfpid"></select>
      <input id="obdfval" placeholder="raw value to find, decimal or 0x hex">
      <select id="obdfsize"><option value="1">1 byte</option><option value="2">2 bytes, big endian</option></select>
      <button id="obdfgo">Find</button>
      <pre id="obdfout"></pre>
      <b>Your signals</b>
      <input id="obdsname" placeholder="name">
      <input id="obdsreq" placeholder="request, for example 2610">
      <input id="obdsat" placeholder="byte number, 0 is the 62">
      <select id="obdsn"><option value="1">1 byte</option><option value="2">2 bytes, big endian</option></select>
      <input id="obdsscale" placeholder="multiply by, default 1">
      <input id="obdsoff" placeholder="then add, default 0">
      <input id="obdsunit" placeholder="unit">
      <button id="obdsadd">Add</button><span id="obdsmsg"></span>
      <div id="obdslist"></div>
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
  const list = () => buildList(supported, { codes: cfg.codes, honda: hondaIds(), extra: sigs.map((s) => s.req.toUpperCase()) });

  // ---- talking to the board ----
  const say = (m) => { msg = m; later(); };
  const stopTimers = () => { clearInterval(kaTimer); clearTimeout(discTimer); kaTimer = discTimer = 0; };
  async function sendList() {
    readCfg();
    const { list: l, dropped } = list();
    if (!l.length) { say('Nothing to poll yet.'); return; }
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
    if (!pages[0x00]) { phase = 'off'; polling = false; stopTimers(); $('obdgo').textContent = 'Start polling'; send('poll off\n'); say('The engine computer did not answer. Is the engine running, and is the board on the OBD port?'); return; }
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
    polling = false; phase = 'off';
    stopTimers();
    $('obdgo').textContent = 'Start polling';
    if (was) { try { await send('poll off\n'); } catch (e) {} }
    say(why || 'Off.');
  }
  $('obdgo').onclick = () => (polling ? stop() : start());
  for (const id of ['obdcodes', 'obdhon', 'obdhids', 'obdrate']) $(id).onchange = () => { readCfg(); if (polling && phase === 'poll') sendList(); };

  // ---- lines from the board ----
  function onLine(s) {
    if (s.startsWith('# poll')) {
      if (/^# poll (stopped|aborted|cannot|refused|no answers|restart)/.test(s) && polling && !/^# poll stopped$/.test(s)) {
        polling = false; phase = 'off'; stopTimers(); $('obdgo').textContent = 'Start polling';
      }
      if (/^# poll (rejected|refused|no answers|aborted|cannot|stopped, )/.test(s)) say(s.slice(2));
      else later();
      return true;
    }
    if (!s.startsWith('# obd ')) return false;
    const p = s.split(' ');            // # obd 10 010C ok 4 410C0BF4
    const req = p[3], st = p[4], bytes = st === 'ok' || st === 'bad' ? hexBytes(p[6] || '') : [];
    if (req.length === 4 && req.startsWith('01')) {
      const pid = parseInt(req.slice(2), 16);
      if (phase === 'discover' && PAGES.includes(pid)) {
        pages[pid] = st === 'ok' && bytes[0] === 0x41 && bytes[1] === pid ? bytes : null;
        if (PAGES.every((q) => q in pages)) finishDiscover();
      }
      if (st === 'ok' && bytes[0] === 0x41 && bytes[1] === pid && !PAGES.includes(pid)) vals.set(pid, { bytes: bytes.slice(2), t: Date.now() });   // the support lists are not values
    } else if (req === '03' || req === '07' || req === '0A') {
      const name = { '03': 'Stored', '07': 'Pending', '0A': 'Permanent' }[req];
      codeText[req] = st === 'ok' ? name + ': ' + (dtcs(bytes).join(' ') || 'none') : st === 'neg' ? name + ': not supported' : '';
    } else if (req.length === 6 && req.startsWith('22') && st === 'ok') {
      honda.set(req.slice(2), { bytes, len: Number(p[5]), t: Date.now() });
    }
    later();
    return true;
  }

  // ---- display ----
  const later = () => { if (!renderTimer) renderTimer = setTimeout(render, 250); };
  const cell = (t) => { const td = document.createElement('td'); td.textContent = t; return td; };
  function sigValue(s) {
    const r = honda.get(s.req.toUpperCase());
    if (!r || s.at + s.n > r.bytes.length) return null;
    const raw = s.n === 1 ? r.bytes[s.at] : r.bytes[s.at] * 256 + r.bytes[s.at + 1];
    return num(raw * s.scale + s.add, 2) + (s.unit ? ' ' + s.unit : '');
  }
  function render() {
    renderTimer = 0;
    $('obdmsg').textContent = '  ' + msg;
    const now = Date.now(), rows = [];
    for (const pid of [...vals.keys()].sort((a, b) => a - b)) {
      const v = vals.get(pid), d = decode(pid, v.bytes), name = PIDS[pid] ? PIDS[pid].name : 'PID ' + hex2(pid);
      const tr = document.createElement('tr');
      tr.append(cell(name), cell((d === null ? v.bytes.map(hex2).join(' ') : d) + (now - v.t > 6000 ? '  (old)' : '')));
      rows.push(tr);
    }
    for (const s of sigs) {
      const tr = document.createElement('tr');
      tr.append(cell(s.name), cell(sigValue(s) ?? 'no data yet'));
      rows.push(tr);
    }
    $('obdtab').replaceChildren(...rows);
    $('obdcodeout').textContent = ['03', '07', '0A'].map((k) => codeText[k]).filter(Boolean).join('\n');

    const keepSel = $('obdhsel').value;
    $('obdhsel').replaceChildren(...[...honda.keys()].sort().map((id) => { const o = new Option(id + '  ' + honda.get(id).len + ' bytes'); o.value = id; return o; }));
    if (honda.has(keepSel)) $('obdhsel').value = keepSel;
    showBytes();
    const keepP = $('obdfpid').value;
    $('obdfpid').replaceChildren(...[...vals.keys()].sort((a, b) => a - b).filter((p) => PIDS[p]).map((p) => { const o = new Option(PIDS[p].name); o.value = String(p); return o; }));
    if (keepP) $('obdfpid').value = keepP;

    $('obdslist').replaceChildren(...sigs.map((s, i) => {
      const b = document.createElement('button');
      b.textContent = 'Delete ' + s.name;
      b.onclick = () => { sigs.splice(i, 1); keep('canreader.obdsigs', sigs); later(); };
      return b;
    }));
  }
  function showBytes() {
    const id = $('obdhsel').value, r = honda.get(id);
    if (!r) { $('obdhbytes').textContent = ''; return; }
    const rows = [];
    for (let i = 0; i < r.bytes.length; i += 8) rows.push(String(i).padStart(2) + ': ' + r.bytes.slice(i, i + 8).map(hex2).join(' '));
    $('obdhbytes').textContent = rows.join('\n');
  }
  $('obdhsel').onchange = showBytes;

  // ---- find a value, and define signals ----
  $('obdfpid').onchange = () => {
    const pid = parseInt($('obdfpid').value, 10), v = vals.get(pid);
    if (!v) return;
    const two = PIDS[pid] && PIDS[pid].n >= 2;
    $('obdfsize').value = two ? '2' : '1';
    $('obdfval').value = String(two ? v.bytes[0] * 256 + v.bytes[1] : v.bytes[0]);
  };
  $('obdfgo').onclick = () => {
    const t = $('obdfval').value.trim(), v = /^0x/i.test(t) ? parseInt(t, 16) : Number(t), size = parseInt($('obdfsize').value, 10);
    if (t === '' || Number.isNaN(v)) { $('obdfout').textContent = 'Enter a number, like 123 or 0x7B.'; return; }
    const hits = findValue(honda, v, size);
    $('obdfout').textContent = hits.length ? hits.join('  ') : 'Not found in the ' + honda.size + ' stored answers.';
  };
  $('obdsadd').onclick = () => {
    const name = $('obdsname').value.trim(), req = $('obdsreq').value.trim().toUpperCase();
    const at = parseInt($('obdsat').value, 10), n = parseInt($('obdsn').value, 10);
    const scale = $('obdsscale').value.trim() === '' ? 1 : Number($('obdsscale').value), add = $('obdsoff').value.trim() === '' ? 0 : Number($('obdsoff').value);
    const m = $('obdsmsg');
    if (!name) { m.textContent = ' Enter a name.'; return; }
    if (!/^[0-9A-F]{4}$/.test(req)) { m.textContent = ' The request is 4 hex digits, like 2610.'; return; }
    if (!(at >= 0 && at < 64)) { m.textContent = ' Byte number 0 to 63.'; return; }
    if (Number.isNaN(scale) || Number.isNaN(add)) { m.textContent = ' Multiply and add must be numbers.'; return; }
    sigs.push({ name, req, at, n, scale, add, unit: $('obdsunit').value.trim() });
    keep('canreader.obdsigs', sigs);
    m.textContent = ' Added. Its request joins the poll list automatically.';
    later();
  };

  render();
  return {
    onLine,
    disconnected: () => { if (polling) { polling = false; phase = 'off'; stopTimers(); $('obdgo').textContent = 'Start polling'; say('Disconnected.'); } },
    state: () => ({ polling, phase, supported: [...supported], values: vals, honda }),
  };
}