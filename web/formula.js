// Formula engine. Formulas are checked token by token, so only the names listed here can
// appear and nothing else is ever executed. Strings cannot contain a backslash.
let fmt = null, cur = [];

const bitAt = (p) => { const b = cur[p >> 3]; return b === undefined ? NaN : (b >> (p & 7)) & 1; };
const helpers = {
  hex: (x) => { fmt = 'h'; return x; },
  dec: (x) => { fmt = 'd'; return x; },
  bin: (x) => { fmt = 'b'; return x; },
  bit: (x, n) => (Number.isNaN(x) ? NaN : (x >>> n) & 1),
  be: (...b) => b.reduce((a, v) => a * 256 + v, 0),
  le: (...b) => b.reduceRight((a, v) => a * 256 + v, 0),
  // field(start, len) counts bit 0 as the lowest bit of b0. Add "be" for DBC big-endian numbering.
  field: (start, len, order) => {
    let v = 0, p = start;
    for (let i = 0; i < len; i++) {
      if (order === 'be') { v = v * 2 + bitAt(p); p = (p & 7) === 0 ? p + 15 : p - 1; }
      else v += bitAt(start + i) * 2 ** i;
    }
    return v;
  },
  signed: (x, len) => (x >= 2 ** (len - 1) ? x - 2 ** len : x),
  map: (x, m) => (x in m ? m[x] : '_' in m ? m._ : x),
  round: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d,
  abs: Math.abs, min: Math.min, max: Math.max,
};

const VARS = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'id', 'dlc', 'ext', 'count', 'period'];
const ARGS = [...VARS, 'col', ...Object.keys(helpers)];
const NAMES = new Set([...ARGS, 'none', 'true', 'false']);
NAMES.delete('col');   // [name] is the only way to reach col
const TOKEN = /\s+|0x[0-9a-f]+|0b[01]+|\d+(?:\.\d+)?|"[^"\\]*"|'[^'\\]*'|\[[^\]]+\]|[a-z_]\w*|===|!==|==|!=|<=|>=|<<|>>>|>>|&&|\|\||[-+*\/%&|^~<>!?:(),{}]/iy;

export function compile(src) {
  let js = '', i = 0;
  while (i < src.length) {
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(src);
    if (!m) throw new Error('unexpected "' + src[i] + '"');
    const t = m[0];
    i += t.length;
    if (t[0] === '[') js += 'col(' + JSON.stringify(t.slice(1, -1).trim().toLowerCase()) + ')';
    else if (/^[a-z_]/i.test(t)) {
      if (t === '_') js += '"_"';
      else if (t === 'none') js += 'NaN';
      else if (NAMES.has(t)) js += t;
      else throw new Error('unknown name ' + t);
    } else js += t;
  }
  if (!js.trim()) throw new Error('empty formula');
  return new Function(...ARGS, 'return (' + js + ');');
}

// Missing bytes are NaN, which shows as a blank cell. The format is saved and restored so a
// nested [column] lookup cannot change the outer cell's format.
export function run(f, r, col) {
  const saved = fmt;
  fmt = null;
  cur = r.bytes;
  const b = (i) => (i < r.dlc ? r.bytes[i] : NaN);
  const v = f(b(0), b(1), b(2), b(3), b(4), b(5), b(6), b(7), r.id, r.dlc,
              r.ext === '1' ? 1 : 0, r.count, r.period, col, ...Object.values(helpers));
  const out = { v, f: fmt };
  fmt = saved;
  return out;
}

export function show(v, f) {
  if (typeof v === 'boolean') v = +v;
  if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) return '';
  if (typeof v !== 'number') return String(v);
  if (f === 'h') return Math.round(v).toString(16).toUpperCase();
  if (f === 'b') return Math.round(v).toString(2).padStart(8, '0');
  return String(Number.isInteger(v) ? v : +v.toFixed(3));
}