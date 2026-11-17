// Identities, signatures and proof-of-work stamps. Everyone gets an Ed25519 key pair made on
// their own device: no accounts, emails or passwords, and nothing can be forged in transit.
module.exports = function (SDG) {
  const ALG = { name: 'Ed25519' };
  const subtle = () => globalThis.crypto.subtle;
  const { canonical, b64u, unb64u, sha256, sha256hex, enc, now } = SDG.util;

  async function supported() {
    try { await subtle().generateKey(ALG, true, ['sign', 'verify']); return true; } catch (e) { return false; }
  }

  async function createIdentity(name) {
    const kp = await subtle().generateKey(ALG, true, ['sign', 'verify']);
    const jwk = await subtle().exportKey('jwk', kp.privateKey);
    const raw = await subtle().exportKey('raw', kp.publicKey);
    return { name: name || '', key: b64u(raw), jwk, created: now() };
  }

  // 16 hex characters name a key in logs; configs that grant a role use 32 or the whole key.
  async function fingerprint(key, n) { return (await sha256hex(unb64u(key))).slice(0, n || 16); }

  const strip = (o, ...keys) => SDG.util.own(o, keys);

  // One spelling per key and signature: exactly 43 (or 86) base64url characters that decode and
  // encode back to the same text. Decoding alone skips whitespace and the unused low bits of the
  // last character, so the same key or signature could be written several ways, and hubs compare
  // keys and signatures as text (to ban a key, count reviewers once, or use a message once).
  const canon = (s, n) => typeof s === 'string' && s.length === n && /^[A-Za-z0-9_-]+$/.test(s) && b64u(unb64u(s)) === s;
  const isKey = s => canon(s, 43);
  const isSig = s => canon(s, 86);

  async function signBytes(bytes, identity) {
    const k = await subtle().importKey('jwk', identity.jwk, ALG, false, ['sign']);
    return b64u(await subtle().sign(ALG, k, bytes));
  }
  // Every check goes through here: items, moderation messages, checkpoints, releases, app builds.
  async function verifyBytes(bytes, key, sig) {
    if (!isKey(key) || !isSig(sig)) return false;
    try {
      const k = await subtle().importKey('raw', unb64u(key), ALG, false, ['verify']);
      return await subtle().verify(ALG, k, unb64u(sig), bytes);
    } catch (e) { return false; }
  }

  // Signs an object: adds author {key, name} and sig over the canonical JSON of everything else.
  async function sign(obj, identity) {
    const o = strip(obj, 'sig');
    o.author = { key: identity.key };
    if (identity.name) o.author.name = identity.name;
    o.sig = await signBytes(enc.encode(canonical(o)), identity);
    return o;
  }
  async function verify(obj) {
    if (!obj || !obj.sig || !obj.author || !obj.author.key) return false;
    return verifyBytes(enc.encode(canonical(strip(obj, 'sig'))), obj.author.key, obj.sig);
  }

  function zeroBits(bytes) {
    let n = 0;
    for (const b of bytes) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; }
    return n;
  }
  // Hashcash-style stamp: a little CPU work per submission keeps spam expensive without accounts.
  async function stamp(obj, bits) {
    if (!bits) return undefined;
    const base = canonical(strip(obj, 'sig', 'pow', 'author')) + ':';
    for (let n = 0; n < 1e8; n++) {
      const s = n.toString(36);
      if (zeroBits(await sha256(base + s)) >= bits) return s;
    }
    throw new Error('Could not make a proof-of-work stamp');
  }
  async function checkStamp(obj, bits) {
    if (!bits) return true;
    if (!obj || typeof obj.pow !== 'string') return false;
    return zeroBits(await sha256(canonical(strip(obj, 'sig', 'pow', 'author')) + ':' + obj.pow)) >= bits;
  }

  SDG.sign = { supported, createIdentity, fingerprint, sign, verify, signBytes, verifyBytes, isKey, isSig, stamp, checkStamp, strip };
};
