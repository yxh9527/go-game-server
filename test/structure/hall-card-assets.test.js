import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hallCardAssets, hallRoomTileAssets, syncHallCardAssets } from '../../scripts/sync-hall-card-assets.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB9kAAAAASUVORK5CYII=', 'base64');
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
async function temporaryHall(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gogame-hall-cards-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('offline audit reports the original 69 card resources without fetching or writing', async t => {
  const root = await temporaryHall(t);
  const report = await syncHallCardAssets({ root, audit: true, fetcher() { assert.fail('audit must be offline'); } });
  assert.equal(report.expected, 69);
  assert.equal(new Set(hallCardAssets).size, 69);
  assert.equal(report.missing.length, 69);
  assert.ok(!report.missing.includes('-1.webp'));
  assert.deepEqual(await fs.readdir(root), []);
});

test('original images are saved under the nginx static root and never downloaded twice', async t => {
  const root = await temporaryHall(t), requested = [];
  const fetcher = async url => {
    requested.push(url.href);
    assert.equal(url.origin, 'https://hall.example');
    assert.ok(url.pathname.startsWith('/l01/img/cards/small/'));
    return new Response(url.pathname.endsWith('.png') ? png : webp);
  };
  const result = await syncHallCardAssets({ root, source: 'https://hall.example/', fetcher });
  assert.deepEqual(result.errors, []);
  assert.equal(result.downloaded.length, 69);
  assert.equal(requested.length, 69);
  assert.deepEqual(await fs.readFile(path.join(result.outputDirectory, '0.webp')), webp);
  const again = await syncHallCardAssets({ root, source: 'https://hall.example/', fetcher() { assert.fail('existing image fetched'); } });
  assert.equal(again.existing, 69);
  assert.deepEqual(again.errors, []);
  const audit = await syncHallCardAssets({ root, audit: true });
  assert.equal(audit.existing, 69);
  assert.deepEqual(audit.missing, []);
});

test('HTML, truncated images and failed HTTP responses are not saved as card images', async t => {
  const root = await temporaryHall(t);
  const result = await syncHallCardAssets({ root, source: 'https://hall.example/', fetcher: async url => {
    if (url.pathname.endsWith('/0.webp')) return new Response(webp.subarray(0, 25));
    if (url.pathname.endsWith('/1.webp')) return new Response('not found', { status: 404 });
    return new Response('<html>upstream error</html>');
  } });
  assert.equal(result.errors.length, 69);
  assert.equal(result.downloaded.length, 0);
  assert.ok(result.errors.some(message => message.includes('HTTP 404')));
  assert.deepEqual(await fs.readdir(root), []);
});

test('invalid existing images are reported and preserved for review', async t => {
  const root = await temporaryHall(t), directory = path.join(root, 'l01/img/cards/small');
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, '16.webp');
  await fs.writeFile(filename, '<html>old error page</html>');
  const result = await syncHallCardAssets({ root, audit: true });
  assert.equal(result.errors.length, 1);
  assert.equal(result.missing.length, 68);
  assert.equal(await fs.readFile(filename, 'utf8'), '<html>old error page</html>');
});

test('login URLs and Cocos version directories are rejected as hall sources', async t => {
  const root = await temporaryHall(t);
  for (const source of ['https://hall.example/?userToken=secret', 'https://hall.example/2.0.1392/', 'file:///tmp/', 'https://user:password@hall.example/']) {
    await assert.rejects(syncHallCardAssets({ root, source, fetcher() { assert.fail('unsafe source fetched'); } }), /public hall origin/);
  }
});

test('all-room audit includes native Blackjack types and Mahjong tiles without inventing a minus-one face', async t => {
  const root = await temporaryHall(t);
  const report = await syncHallCardAssets({ root, audit: true, includeRoomTiles: true,
    fetcher() { assert.fail('audit must be offline'); } });
  assert.equal(hallRoomTileAssets.length, 15);
  assert.equal(report.expected, 84);
  assert.equal(report.missing.length, 84);
  assert.ok(report.missing.includes('room/type/1000/60/4.png'));
  assert.ok(report.missing.includes('room/type/1000/62/-1.png'));
  assert.ok(report.missing.includes('room/type/1000/62/29.png'));
  assert.ok(report.missing.includes('cards/small/card-back-blue.png'));
  assert.ok(!report.missing.includes('cards/small/-1.webp'));
  assert.deepEqual(await fs.readdir(root), []);
});

test('all-room download keeps nginx paths, validates image bytes and skips existing files', async t => {
  const root = await temporaryHall(t), requested = [];
  const fetcher = async url => {
    requested.push(url.pathname);
    assert.equal(url.origin, 'https://hall.example');
    return new Response(url.pathname.endsWith('.png') ? png : webp);
  };
  const report = await syncHallCardAssets({ root, source: 'https://hall.example/', includeRoomTiles: true, fetcher });
  assert.deepEqual(report.errors, []);
  assert.equal(report.downloaded.length, 84);
  assert.equal(new Set(requested).size, 84);
  for (const file of ['cards/small/0.webp', 'cards/small/card-back-blue.png',
    'room/type/1000/60/1.png', 'room/type/1000/62/-1.png', 'room/type/1000/62/29.png']) {
    assert.deepEqual(await fs.readFile(path.join(report.outputDirectory, file)), file.endsWith('.png') ? png : webp);
  }
  const again = await syncHallCardAssets({ root, source: 'https://hall.example/', includeRoomTiles: true,
    fetcher() { assert.fail('must not refetch existing original assets'); } });
  assert.equal(again.existing, 84); assert.deepEqual(again.errors, []);
});
