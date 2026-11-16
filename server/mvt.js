// Decodes Mapbox Vector Tiles (the protobuf inside a vector PMTiles map) into plain objects:
// { layerName: { extent, features: [{ id, type, props, geom }] } }. Geometry stays in tile
// coordinates (0 to extent): points as [x, y] pairs, lines and polygon rings as flat [x, y, x, y...].
const TYPES = { 1: 'point', 2: 'line', 3: 'polygon' };

function varint(b, i) {
  let r = 0, s = 1, c;
  do { c = b[i++]; r += (c & 0x7f) * s; s *= 128; } while (c >= 0x80);
  return [r, i];
}
// Calls fn(field, wireType, value, start, end) for each field of a message in b[from..to].
function fields(b, from, to, fn) {
  let i = from;
  while (i < to) {
    let key, v;
    [key, i] = varint(b, i);
    const f = Math.floor(key / 8), wt = key & 7;
    if (wt === 0) { [v, i] = varint(b, i); fn(f, wt, v); }
    else if (wt === 2) { [v, i] = varint(b, i); fn(f, wt, null, i, i + v); i += v; }
    else if (wt === 1) { fn(f, wt, b.readDoubleLE(i)); i += 8; }
    else if (wt === 5) { fn(f, wt, b.readFloatLE(i)); i += 4; }
    else throw new Error('Unsupported protobuf wire type ' + wt);
  }
}
const zigzag = n => (n % 2 ? -(n + 1) / 2 : n / 2);

function value(b, from, to) {
  let out = null;
  fields(b, from, to, (f, wt, v, s, e) => {
    if (f === 1) out = b.toString('utf8', s, e);
    else if (f === 2 || f === 3 || f === 4 || f === 5) out = v;
    else if (f === 6) out = zigzag(v);
    else if (f === 7) out = !!v;
  });
  return out;
}

function geometry(cmds, type) {
  const parts = [];
  let x = 0, y = 0, cur = null;
  for (let i = 0; i < cmds.length;) {
    const c = cmds[i++], op = c & 7, n = c >> 3;
    if (op === 1 || op === 2) {
      for (let k = 0; k < n; k++) {
        x += zigzag(cmds[i++]); y += zigzag(cmds[i++]);
        if (type === 'point') parts.push([x, y]);
        else { if (op === 1) { cur = []; parts.push(cur); } cur.push(x, y); }
      }
    }
  }
  return parts;
}

// `want` lists the layers to decode; the others are skipped without being read.
function decode(buf, want) {
  const out = {};
  fields(buf, 0, buf.length, (f, wt, v, s, e) => {
    if (f !== 3) return;
    let name = '', extent = 4096;
    const keys = [], vals = [], feats = [];
    fields(buf, s, e, (lf, lwt, lv, ls, le) => {
      if (lf === 1) name = buf.toString('utf8', ls, le);
      else if (lf === 3) keys.push(buf.toString('utf8', ls, le));
      else if (lf === 4) vals.push(value(buf, ls, le));
      else if (lf === 5) extent = lv;
      else if (lf === 2) feats.push([ls, le]);
    });
    if (want && !want.includes(name)) return;
    const features = feats.map(([fs, fe]) => {
      let id = 0, type = 'unknown', tags = [], cmds = [];
      fields(buf, fs, fe, (ff, fwt, fv, a, z) => {
        if (ff === 1) id = fv;
        else if (ff === 3) type = TYPES[fv] || 'unknown';
        else if (ff === 2 || ff === 4) {
          const arr = [];
          for (let j = a; j < z;) { let n; [n, j] = varint(buf, j); arr.push(n); }
          if (ff === 2) tags = arr; else cmds = arr;
        }
      });
      const props = {};
      for (let t = 0; t + 1 < tags.length; t += 2) props[keys[tags[t]]] = vals[tags[t + 1]];
      return { id, type, props, geom: geometry(cmds, type) };
    });
    out[name] = { extent, features };
  });
  return out;
}

module.exports = { decode };
