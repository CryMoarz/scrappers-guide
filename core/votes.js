// Votes: one per person per thing, signed like comments so anyone can carry them. "Found it" and
// "Not in mine" on a device's parts, "Helpful" on comments, "Still true" and "Not anymore" on field
// notes. A newer vote from the same key replaces the older one, and a 0 takes it back.
module.exports = function (SDG) {
  // Distinct people who found a part before a generic guess counts as likely.
  const CONFIRM = 3;
  const KINDS = { devices: 'part', comments: 'comment', observations: 'note' };

  async function make(target, value, identity, powBits) {
    const v = { id: SDG.util.newId(), target, value, created: SDG.util.now() };
    const ok = SDG.schema.validate('vote', v);
    if (!ok.ok) throw new Error('Vote: ' + ok.errors.map(x => `${x.path} ${x.msg}`).join('; '));
    if (powBits) v.pow = await SDG.sign.stamp(v, powBits);
    return identity ? SDG.sign.sign(v, identity) : v;
  }

  // The latest vote per person per target, counted: { up, down, last } where `last` is when
  // someone last voted it up. Only votes that name their author count.
  function tally(votes) {
    const latest = new Map();
    (votes || []).forEach(v => {
      const who = v && v.author && v.author.key;
      if (!who || !v.target) return;
      const k = v.target + '\n' + who, cur = latest.get(k);
      if (!cur || String(v.created) > String(cur.created)) latest.set(k, v);
    });
    const out = new Map();
    latest.forEach(v => {
      const t = out.get(v.target) || { up: 0, down: 0, last: '' };
      if (v.value > 0) { t.up++; if (String(v.created) > t.last) t.last = String(v.created); } else if (v.value < 0) t.down++;
      out.set(v.target, t);
    });
    return out;
  }

  // This person's standing vote on a target: 1, -1 or 0.
  function mine(votes, key, target) {
    let best = null;
    (votes || []).forEach(v => { if (v.target === target && v.author && v.author.key === key && (!best || String(v.created) > String(best.created))) best = v; });
    return best ? best.value : 0;
  }

  // What votes say about a part: enough people found it (a generic guess counts as likely), or
  // enough found it missing (disputed).
  function partStatus(t) {
    if (!t) return null;
    return { up: t.up, down: t.down, confirmed: t.up >= CONFIRM && t.up >= 2 * t.down, disputed: t.down >= CONFIRM && t.down > t.up };
  }

  const partTarget = (deviceId, key) => `devices/${deviceId}#${key}`;
  const kindOf = target => KINDS[String(target).split('/')[0]];

  SDG.votes = { CONFIRM, make, tally, mine, partStatus, partTarget, kindOf };
};
