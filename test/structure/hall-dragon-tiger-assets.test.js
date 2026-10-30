import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeUuid } from '../../scripts/sync-client-assets.js';

test('Hall Dragon Tiger dealer 301 is the matching original client texture', () => {
  const root = new URL('../../static/client/2.0.1279/assets/Hundred/', import.meta.url);
  const configFile = fs.readdirSync(root).find(name => /^config\.[a-z0-9]+\.json$/.test(name));
  const config = JSON.parse(fs.readFileSync(new URL(configFile, root), 'utf8'));
  const [index] = Object.entries(config.paths).find(([, value]) =>
    value[0] === 'layout/skin/textures/common/dealers/lhd/301' && config.types[value[1]] === 'cc.Texture2D');
  const uuid = decodeUuid(config.uuids[index]);
  const versionIndex = config.versions.native.findIndex((value, i) => i % 2 === 0 && Number(value) === Number(index));
  assert.ok(versionIndex >= 0);
  const source = fs.readFileSync(new URL('native/' + uuid.slice(0, 2) + '/' + uuid + '.' + config.versions.native[versionIndex + 1] + '.png', root));
  const image = fs.readFileSync(new URL('../../static/hall/l01/img/room/type/1003/characters/301.png', import.meta.url));
  assert.deepEqual(image.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
  assert.ok(image.readUInt32BE(16) > 0 && image.readUInt32BE(20) > 0);
  assert.deepEqual(image, source);
});
