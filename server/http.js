// A tiny HTTP toolkit: routing, JSON bodies with size limits, gzip, CORS and rate limiting.
// No dependencies, so the hub runs on anything that runs Node.
const zlib = require('zlib');
const SDG = require('../core');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

function router() {
  const routes = [];
  const add = (method, pattern, handler, opts) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler, opts: opts || {} });
  };
  const match = (method, path) => {
    let allowed = [];
    for (const r of routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) { allowed.push(r.method); continue; }
      const params = {};
      try { r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]))); } catch (e) { throw new HttpError(400, 'Bad request path'); }
      return { handler: r.handler, params, opts: r.opts };
    }
    return allowed.length ? { allowed } : null;
  };
  return {
    get: (p, h, o) => add('GET', p, h, o), post: (p, h, o) => add('POST', p, h, o), delete: (p, h, o) => add('DELETE', p, h, o), match,
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const gz = /gzip/.test(req.headers['content-encoding'] || '');
    const src = gz ? req.pipe(zlib.createGunzip()) : req;
    src.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, `Request body is larger than ${Math.round(limit / 1024)} KB`)); req.destroy(); return; }
      chunks.push(c);
    });
    src.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    src.on('error', e => reject(new HttpError(400, 'Could not read the request body: ' + e.message)));
  });
}
async function readJSON(req, limit) {
  const text = await readBody(req, limit);
  if (!text) return {};
  try { return SDG.util.parse(text); } catch (e) { throw new HttpError(400, 'The request body is not valid JSON'); }
}

// Big bodies are compressed off the main thread, and cached bodies (the app, the release) once.
const gzipped = new WeakMap();
const gzip = buf => new Promise((ok, fail) => zlib.gzip(buf, { level: 6 }, (e, out) => (e ? fail(e) : ok(out))));
async function send(req, res, status, body, headers) {
  headers = Object.assign({}, headers || {});
  let buf;
  if (Buffer.isBuffer(body)) buf = body;
  else if (typeof body === 'string') buf = Buffer.from(body);
  else { buf = Buffer.from(JSON.stringify(body)); headers['Content-Type'] = headers['Content-Type'] || 'application/json; charset=utf-8'; }
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && !headers['Content-Encoding']) {
    let gz = Buffer.isBuffer(body) && gzipped.get(body);
    if (!gz) { gz = buf.length > 65536 ? await gzip(buf) : zlib.gzipSync(buf, { level: 6 }); if (Buffer.isBuffer(body)) gzipped.set(body, gz); }
    buf = gz;
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

// Token bucket per client and bucket name: `rate` tokens refilled over `per` milliseconds.
// limit(key, rate, per) takes one; limit.take(key, rate, per, n, partial) takes n (all or none,
// or as many as there are with partial) and says how many it took.
function limiter() {
  const buckets = new Map();
  setInterval(() => { const t = Date.now(); buckets.forEach((b, k) => { if (t - b.t > 3600e3) buckets.delete(k); }); }, 600e3).unref();
  const take = (key, rate, per, n, partial) => {
    const t = Date.now();
    const b = buckets.get(key) || { tokens: rate, t };
    b.tokens = Math.min(rate, b.tokens + ((t - b.t) / per) * rate);
    b.t = t;
    buckets.set(key, b);
    const got = Math.min(n, Math.floor(b.tokens));
    if (got < n && !partial) return 0;
    b.tokens -= got;
    return got;
  };
  const limit = (key, rate, per) => take(key, rate, per, 1) === 1;
  limit.take = take;
  return limit;
}

// Behind `hops` trusted proxies, the client is the hops-th address from the right of
// X-Forwarded-For: everything left of that was written by the client and proves nothing.
function clientIp(req, trustProxy) {
  const hops = trustProxy === true ? 1 : Math.max(0, Math.floor(+trustProxy) || 0);
  const list = hops ? String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean) : [];
  return (list.length >= hops && list[list.length - hops]) || req.socket.remoteAddress || 'unknown';
}

// Rate-limit buckets: an IPv4 address each, but IPv6 by its /64, the block one household or one
// machine gets, so changing the last half of an address doesn't buy a fresh budget.
function bucketOf(ip) {
  ip = String(ip || '');
  if (!ip.includes(':') || /^::ffff:\d/i.test(ip)) return ip.replace(/^::ffff:/i, '');
  const [head, tail] = ip.split('%')[0].split('::');
  const a = head ? head.split(':') : [], b = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail !== undefined ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}

module.exports = { HttpError, router, readJSON, readBody, send, limiter, clientIp, bucketOf };
