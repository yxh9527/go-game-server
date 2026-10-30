import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

test('native arcade countdown audio works after onLoad and before start', async () => {
  const source = fs.readFileSync(new URL('../../static/client/2.0.1279/assets/Turntable/index.c5488.js', import.meta.url), 'utf8');
  const marker = "'AudioPart':";
  const from = source.indexOf(marker) + marker.length;
  const to = source.indexOf("'BalancePart':", from);
  assert.ok(from >= marker.length && to > from, 'locate the actual original AudioPart factory');
  const events = [], loads = [], played = [];
  let moduleLookups = 0;
  const module = { skinPath: 'layout/skin', bgmAudioClip: { name: 'bgm' },
    bundle: { load: async asset => { loads.push(asset); return { name: asset }; } },
    on: (...args) => events.push(args), notify: { offContext() {} } };
  const cc = { _RF: { push() {}, pop() {} }, _decorator: { ccclass: Type => Type },
    Component: function Component() {}, AudioClip: function AudioClip() {},
    path: { join: path.posix.join },
    game: { EVENT_SHOW: 'show', EVENT_HIDE: 'hide', on: (...args) => events.push(args), off() {} } };
  const [factory] = vm.runInNewContext(source.slice(from, to).replace(/,\s*$/, ''), { cc });
  const exports = {};
  factory(name => {
    if (name.endsWith('/Facade')) return { default: { getModule(key) {
      assert.equal(key, 'Turntable'); moduleLookups += 1; return module;
    } } };
    if (name.endsWith('/i18n')) return {};
    if (name.endsWith('/TurntableHelper')) return { default: { gameSound: true } };
    if (name.endsWith('/TurntableConfig')) return { TurntableConfig: { Event: {
      ON_TOGGLE_SOUND: 'toggle-sound', ON_TOGGLE_HUMAN: 'toggle-human',
    } } };
    assert.fail('unexpected AudioPart dependency: ' + name);
  }, {}, exports);
  const audio = new exports.default();
  audio.playAudioClip = (...args) => played.push(args);
  audio.unscheduleAllCallbacks = () => {};
  assert.equal(audio._module, null);
  audio.onLoad();
  audio.playSound('count_down');
  await Promise.resolve();
  assert.deepEqual(loads, ['layout/skin/audios/count_down']);
  assert.equal(played.length, 1);
  assert.equal(played[0][0].name, loads[0]);
  assert.equal(events.length, 0, 'onLoad only obtains the module, without starting audio or binding events');
  audio._bgmAudioSource = { play() { played.push('bgm'); } };
  audio.start();
  assert.equal(moduleLookups, 1, 'start preserves the initialization completed in onLoad');
  assert.equal(events.length, 4);
  assert.equal(audio._bgmAudioSource.clip, module.bgmAudioClip);
  assert.equal(played.at(-1), 'bgm');
  audio.onDestroy();
});
