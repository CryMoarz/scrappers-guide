// Decodes Mapbox Vector Tiles (the protobuf inside a vector PMTiles map) into plain objects:
// { layerName: { extent, features: [{ id, type, props, geom }] } }. Geometry stays in tile
// coordinates (0 to extent): points as [x, y] pairs, lines and polygon rings as flat [x, y, x, y...].
// A map can come from anyone, so every length is checked and a broken tile is an error, never a
// hang or a full memory.
const TYPES = { 1: 'point', 2: 'line', 3: 'polygon' };
// What one tile may hold: every point takes two numbers, so at most a million points. The busiest
// tile in the 15.8 GB Canada map has 10,326 features and 294,024 numbers in its tags and shapes
// (137,274 points), so real tiles fit with room to spare.
const MAX_FEATURES = 200000, MAX_NUMBERS = 2000000;

const bad = why => new Error('Broken map tile: ' + why);
// A varint is at most 10 bytes and must end before `end`.
function varint(b, i, end) {
  let r = 0, s = 1;
  for (let n = 0; n < 10 && i < end; n++) {
    const c = b[i++];
    r += (c & 0x7f) * s;
    if (c < 0x80) return [r, i];
    s *= 128;
  }
  throw bad('a number runs past its end');
}
// Calls fn(field, wireType, value, start, end) for each field of a message in b[from..to].
// Only length-delimited fields (wire type 2) have a start and end, and they lie inside the message.
function fields(b, from, to, fn) {
  let i = from;
  while (i < to) {
    let key, v;
    [key, i] = varint(b, i, to);
    const f = Math.floor(key / 8), wt = key & 7;
    if (wt === 0) { [v, i] = varint(b, i, to); fn(f, wt, v); }
    else if (wt === 2) { [v, i] = varint(b, i, to); if (v > to - i) throw bad('a field runs past its end'); fn(f, wt, null, i, i + v); i += v; }
    else if (wt === 1) { if (i + 8 > to) throw bad('a field runs past its end'); fn(f, wt, b.readDoubleLE(i)); i += 8; }
    else if (wt === 5) { if (i + 4 > to) throw bad('a field runs past its end'); fn(f, wt, b.readFloatLE(i)); i += 4; }
    else throw new Error('Unsupported protobuf wire type ' + wt);
  }
}
const zigzag = n => (n % 2 ? -(n + 1) / 2 : n / 2);

function value(b, from, to) {
  let out = null;
  fields(b, from, to, (f, wt, v, s, e) => {
    if (f === 1) { if (wt === 2) out = b.toString('utf8', s, e); }
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
    const c = cmds[i++], op = c & 7, n = Math.floor(c / 8);
    if (op === 1 || op === 2) {
      // Each point takes two numbers: a command can't claim more points than are left.
      if (n * 2 > cmds.length - i) throw bad('a shape claims more points than it holds');
      for (let k = 0; k < n; k++) {
        x += zigzag(cmds[i++]); y += zigzag(cmds[i++]);
        if (type === 'point') parts.push([x, y]);
        else {
          if (op === 1) { cur = []; parts.push(cur); } else if (!cur) throw bad('a line starts without a move');
          cur.push(x, y);
        }
      }
    }
  }
  return parts;
}

// `want` lists the layers to decode; the others are skipped without being read.
function decode(buf, want) {
  const out = {};
  // Counted over the whole tile, so a hostile tile is refused before it fills the memory.
  let featureCount = 0, numberCount = 0;
  fields(buf, 0, buf.length, (f, wt, v, s, e) => {
    if (f !== 3 || wt !== 2) return;
    let name = '', extent = 4096;
    const keys = [], vals = [], feats = [];
    fields(buf, s, e, (lf, lwt, lv, ls, le) => {
      if (lwt !== 2) { if (lf === 5 && lwt === 0) extent = lv; return; }
      if (lf === 1) name = buf.toString('utf8', ls, le);
      else if (lf === 3) keys.push(buf.toString('utf8', ls, le));
      else if (lf === 4) vals.push(value(buf, ls, le));
      else if (lf === 2) { if (++featureCount > MAX_FEATURES) throw bad('more than ' + MAX_FEATURES + ' features'); feats.push(ls, le); }
    });
    if (want && !want.includes(name)) return;
    const features = [];
    for (let n = 0; n < feats.length; n += 2) {
      let id = 0, type = 'unknown', tags = [], cmds = [];
      fields(buf, feats[n], feats[n + 1], (ff, fwt, fv, a, z) => {
        if (fwt === 2) {
          if (ff !== 2 && ff !== 4) return;
          const arr = [];
          for (let j = a; j < z;) {
            if (++numberCount > MAX_NUMBERS) throw bad('more than ' + MAX_NUMBERS + ' numbers in its tags and shapes');
            let num; [num, j] = varint(buf, j, z); arr.push(num);
          }
          if (ff === 2) tags = arr; else cmds = arr;
        } else if (ff === 1) id = fv;
        else if (ff === 3) type = TYPES[fv] || 'unknown';
      });
      const props = {};
      for (let t = 0; t + 1 < tags.length; t += 2) props[keys[tags[t]]] = vals[tags[t + 1]];
      features.push({ id, type, props, geom: geometry(cmds, type) });
    }
    out[name] = { extent, features };
  });
  return out;
}

module.exports = { decode, MAX_FEATURES, MAX_NUMBERS };
