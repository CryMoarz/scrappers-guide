// The container: data bundled in the image goes in on first start and on updates, but never over
// a copy that has changed on its own (synced from a hub or moderated there).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../lib/fsdata');

test('bundled data: installed, updated, and local changes kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-seed-'));
  const image = path.join(dir, 'image'), data = path.join(dir, 'data');
  fs.cpSync(F.DATA, image, { recursive: true });
  const part = (d, id) => JSON.parse(fs.readFileSync(path.join(d, 'parts', id + '.json'), 'utf8'));
  const setPart = (d, id, change) => fs.writeFileSync(path.join(d, 'parts', id + '.json'), JSON.stringify(Object.assign(part(d, id), change), null, 2) + '\n');
  const id = fs.readdirSync(path.join(image, 'parts'))[0].replace('.json', '');

  assert.equal(F.seed(image, data), 'copied');
  assert.equal(F.seed(image, data), 'current');
  // The hub rewrites meta.json as it runs; that alone is not a local change.
  F.writeMeta(data, { seq: 7 });
  assert.equal(F.seed(image, data), 'current');

  // A new version brings a changed record and drops another.
  setPart(image, id, { summary: 'Newer summary' });
  const gone = fs.readdirSync(path.join(image, 'parts'))[1];
  fs.rmSync(path.join(image, 'parts', gone));
  assert.equal(F.seed(image, data), 'updated');
  assert.equal(part(data, id).summary, 'Newer summary');
  assert.ok(!fs.existsSync(path.join(data, 'parts', gone)), 'records the new version dropped are gone');
  assert.equal(F.readJSON(path.join(data, 'meta.json')).seq, 7, 'the hub keeps its own sequence');

  // Changed here, then another version: this copy is kept.
  setPart(data, id, { summary: 'Fixed by our moderator' });
  setPart(image, id, { summary: 'Even newer' });
  assert.equal(F.seed(image, data), 'kept');
  assert.equal(part(data, id).summary, 'Fixed by our moderator');
});
