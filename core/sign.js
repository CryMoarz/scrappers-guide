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

  async function signBytes(bytes, identity) {
    const k = await subtle().importKey('jwk', identity.jwk, ALG, false, ['sign']);
    return b64u(await subtle().sign(ALG, k, bytes));
  }
  async function verifyBytes(bytes, key, sig) {
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

  SDG.sign = { supported, createIdentity, fingerprint, sign, verify, signBytes, verifyBytes, stamp, checkStamp, strip };
};
