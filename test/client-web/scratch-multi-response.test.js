import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { adaptScratchMultiResponse } from '../../client-web/src/scratch-multi-response.js';

test('native scratch multi response dispatch matches room as well as denomination', () => {
  const raw = fs.readFileSync(new URL('../../static/client/2.0.1279/assets/MultyBet/index.4816c.js', import.meta.url), 'utf8');
  const adapted = adaptScratchMultiResponse(raw);
  assert.notEqual(adapted, raw);
  assert.equal(adaptScratchMultiResponse(adapted), adapted);
  const method = /([\w$]+)\['prototype'\]\['onResponse'\]=function\(([\w$]+)\)\{if\(Number/.exec(adapted);
  assert.ok(method);
  const start = adapted.indexOf('function(', method.index), end = adapted.indexOf('},' + method[1] + "['prototype']['init']", start);
  const response = vm.runInNewContext('(' + adapted.slice(start, end + 1) + ')');
  const seen = [];
  const row = id => ({ roomId: id, log() {}, itemMap: new Map([[1, { onResponse(payload) { seen.push([id, payload]); } }]]) });
  const one = row(61010026), two = row(63010026);
  const payload = { roomId: one.roomId, faceValue: 100, code: 0, winAmount: 200 };
  response.call(one, payload); response.call(two, payload);
  assert.equal(seen.length, 1); assert.equal(seen[0][0], one.roomId);
  response.call(two, { roomId: two.roomId, faceValue: 100, code: 100085 });
  assert.equal(seen.length, 2);
});
