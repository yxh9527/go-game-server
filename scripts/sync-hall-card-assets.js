import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Matches the original hall's card preloader (module 2127), including jokers
// and alternative ranks. -1 is the existing PNG back, never a numbered face.
export const hallCardAssets = Object.freeze([
  ...Array.from({ length: 55 }, (_, i) => i + '.webp'),
  ...Array.from({ length: 13 }, (_, i) => (60 + i) + '.webp'),
  'card-back-blue.png',
]);

// Native hundred-room list: 60 renders showdownTypes; 62 renders tile IDs.
// Keep the list scoped to the actual missing URLs captured in the hall log.
export const hallRoomTileAssets = Object.freeze([
  ...[1, 2, 3, 4].map(id => 'room/type/1000/60/' + id + '.png'),
  ...[-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 29].map(id => 'room/type/1000/62/' + id + '.png'),
]);

function validateImage(bytes, name) {
  const valid = name.endsWith('.png')
    ? bytes.length >= 33 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
      && bytes.subarray(12, 16).toString() === 'IHDR'
    : bytes.length >= 20 && bytes.subarray(0, 4).toString() === 'RIFF'
      && bytes.readUInt32LE(4) + 8 === bytes.length
      && bytes.subarray(8, 12).toString() === 'WEBP'
      && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.subarray(12, 16).toString());
  if (!valid) throw new Error('Invalid original image: ' + name);
}

export async function syncHallCardAssets({ root = path.join(repository, 'static/hall'), source,
  audit = false, includeRoomTiles = false, fetcher = fetch, onProgress = () => {} } = {}) {
  let base;
  if (source) {
    base = new URL(source);
    if (!['http:', 'https:'].includes(base.protocol) || base.search || base.hash
      || base.username || base.password || base.pathname !== '/') {
      throw new Error('--source must be the public hall origin, without login parameters or a client version path');
    }
  }
  if (!audit && !base) throw new Error('Specify --source <public hall origin> or --audit');
  const directory = path.resolve(root, includeRoomTiles ? 'l01/img' : 'l01/img/cards/small');
  const assets = includeRoomTiles
    ? [...hallCardAssets.map(name => 'cards/small/' + name), ...hallRoomTileAssets] : [...hallCardAssets];
  const report = { outputDirectory: directory, expected: assets.length,
    existing: 0, downloaded: [], missing: [], errors: [] };
  const queue = [...assets];
  async function syncOne(name) {
    const destination = path.join(directory, name);
    try {
      const bytes = await fs.readFile(destination);
      validateImage(bytes, name); report.existing++; return;
    } catch (error) {
      // An invalid existing file must be reviewed, not silently replaced.
      if (error.code !== 'ENOENT') throw error;
    }
    if (audit) { report.missing.push(name); return; }
    const response = await fetcher(new URL((includeRoomTiles ? 'l01/img/' : 'l01/img/cards/small/') + name, base), {
      redirect: 'follow', signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + name);
    const bytes = Buffer.from(await response.arrayBuffer());
    validateImage(bytes, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
      await fs.writeFile(destination, bytes, { flag: 'wx' });
      report.downloaded.push(name); onProgress(name);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      validateImage(await fs.readFile(destination), name); report.existing++;
    }
  }
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const name = queue.shift();
      try { await syncOne(name); }
      catch (error) { report.errors.push(name + ': ' + error.message); }
    }
  }));
  report.downloaded.sort(); report.missing.sort(); report.errors.sort();
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--audit') options.audit = true;
      else if (args[i] === '--all') options.includeRoomTiles = true;
      else if (args[i] === '--source' && args[i + 1] && !args[i + 1].startsWith('--')) options.source = args[++i];
      else throw new Error('Unknown or incomplete argument: ' + args[i]);
    }
    const report = await syncHallCardAssets({ ...options, onProgress: name => console.log('Downloaded ' + name) });
    console.log(JSON.stringify(report, null, 2));
    if (report.errors.length || report.missing.length) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
