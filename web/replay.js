// Replay. Plays a recorded CSV through the same parser the live stream uses, paced by the
// recording's own timestamps. Idle gaps over one second are skipped, and a timestamp that
// jumps backwards (the board rebooted) resynchronises the clock.
const GAP = 1000000;   // microseconds

class Source {
  constructor(blob) { this.rd = blob.stream().getReader(); this.dec = new TextDecoder(); this.rest = ''; this.q = []; this.qi = 0; this.eof = false; }
  async fill() {
    if (this.qi > 50000) { this.q = this.q.slice(this.qi); this.qi = 0; }
    while (!this.eof && this.q.length - this.qi < 4000) {
      const { value, done } = await this.rd.read();
      if (done) { this.eof = true; if (this.rest) { this.q.push(this.rest); this.rest = ''; } break; }
      const parts = (this.rest + this.dec.decode(value, { stream: true })).split('\n');
      this.rest = parts.pop();
      for (const p of parts) this.q.push(p);
    }
  }
}

export function initReplay({ ev, begin, end, feed, isLive }) {
  const $ = (id) => document.getElementById(id);
  const det = document.createElement('details');
  det.innerHTML = `<summary>Replay</summary>
    <input type="file" id="rfile" accept=".csv,.log,.txt,text/csv,text/plain">
    <select id="rspeed">
      <option value="0.25">0.25x</option><option value="0.5">0.5x</option><option value="1" selected>1x</option>
      <option value="2">2x</option><option value="5">5x</option><option value="10">10x</option><option value="0">max</option>
    </select>
    <label><input type="checkbox" id="rloop" style="width:auto;margin:0 6px 0 0">Loop</label><br>
    <input type="range" id="rseek" min="0" max="1000" value="0" style="width:100%">
    <button id="rpause">Pause</button><button id="rrestart">Restart</button><button id="rstop">Stop</button>
    <pre id="rprog">No replay. Pick a file, or press Play on a recording.</pre>`;
  $('logbox').before(det);

  let src = null, blob = null, name = '', paused = false, vt = 0, lastTs = 0, firstTs = 0, first = true;
  let consumed = 0, fed = 0, timer = 0, busy = false, lastWall = 0, lastProg = 0, seekTo = -1, resync = false;
  const say = (m) => { $('rprog').textContent = m; };

  function open() {
    src = new Source(blob);
    first = true; paused = false; vt = 0; lastTs = 0; consumed = 0; fed = 0; seekTo = -1; resync = false;
    lastWall = performance.now();
    $('rpause').textContent = 'Pause';
  }
  const stopTimer = () => { clearInterval(timer); timer = 0; };

  function play(b, nm) {
    if (isLive()) { say('Disconnect from the board first.'); return; }
    stopTimer();
    blob = b; name = nm;
    open();
    begin(name);
    ev('replay started ' + name);
    timer = setInterval(tick, 20);
  }
  function stop() {
    if (!src && !timer) return;
    stopTimer();
    src = null;
    ev('replay stopped ' + name);
    end('stopped');
    say('Stopped.');
  }
  function finish() {
    if ($('rloop').checked) { open(); return; }   // table keeps its rows, the clock restarts
    stopTimer();
    src = null;
    ev('replay finished ' + name);
    end('finished');
    say('Finished ' + name + ', ' + fed + ' frames.');
  }

  function advance(dtWall, speed, started) {
    if (speed > 0 && seekTo < 0) vt += dtWall * 1000 * speed;   // microseconds of recording time
    let n = 0;
    const budget = seekTo >= 0 ? 30 : 10;   // fast-forwarding may use more of each tick
    for (;;) {
      if (seekTo >= 0 && consumed >= seekTo) { seekTo = -1; resync = true; }   // arrived, back to normal pace
      const sp = seekTo >= 0 ? 0 : speed;
      if (src.qi >= src.q.length) break;
      const line = src.q[src.qi];
      if (!line) { src.qi++; consumed++; continue; }
      const len = line.length + 1;
      if (line.charCodeAt(0) === 35) { src.qi++; consumed += len; feed(line); continue; }   // # note
      const c = line.indexOf(',');
      const ts = Number(line.slice(0, c));
      if (!(ts >= 0)) { src.qi++; consumed += len; continue; }                              // header row
      if (first) { first = false; firstTs = ts; vt = ts; }
      if (resync) { resync = false; vt = ts; }
      if (sp > 0) {
        if (ts > vt + GAP) vt = ts;                // skip long idle gaps
        else if (ts < lastTs - GAP) vt = ts;       // timestamps restarted
        if (ts > vt) break;                        // not due yet
      }
      feed(line);
      fed++; lastTs = ts; consumed += len; src.qi++;
      if (++n % 200 === 0 && performance.now() - started > budget) break;   // keep the page responsive
    }
    if (src.qi >= src.q.length && src.eof) finish();
  }

  async function tick() {
    if (busy || !src) return;
    busy = true;
    try {
      const t = performance.now();
      const dtWall = Math.min(t - lastWall, 200);   // a frozen page must not make the clock jump
      lastWall = t;
      if (!paused) {
        const s = src;
        await s.fill();
        if (src === s) advance(dtWall, Number($('rspeed').value), t);
      }
      if (src && t - lastProg > 250) {
        lastProg = t;
        const pct = Math.min(100, consumed / Math.max(blob.size, 1) * 100);
        say(name + (seekTo >= 0 ? '  seeking' : paused ? '  paused' : '') + '  ' + pct.toFixed(0) + '%  ' +
            fed + ' frames  ' + (first ? 0 : (lastTs - firstTs) / 1e6).toFixed(1) + ' s');
        if (seekTo < 0 && document.activeElement !== $('rseek')) $('rseek').value = Math.round(pct * 10);
      }
    } catch (e) {
      ev('replay error ' + (e && e.name || e));
      stop();
    }
    busy = false;
  }

  // Seeking forward replays the skipped part at full speed so the table is correct when it arrives.
  // Seeking backward starts over and fast-forwards to the target.
  function seek(bytes) {
    if (!blob || !src) return;
    if (bytes < consumed) {
      stopTimer();
      open();
      begin(name);
      timer = setInterval(tick, 20);
    }
    seekTo = bytes;
  }
  $('rseek').oninput = () => { if (blob && src) seek(Number($('rseek').value) / 1000 * blob.size); };
  $('rfile').onchange = () => { const f = $('rfile').files[0]; if (f) play(f, f.name); };
  $('rpause').onclick = () => { if (!src) return; paused = !paused; $('rpause').textContent = paused ? 'Resume' : 'Pause'; };
  $('rrestart').onclick = () => { if (blob) play(blob, name); };
  $('rstop').onclick = stop;
  return { play, stop };
}