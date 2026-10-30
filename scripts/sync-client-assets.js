import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const safeName = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
export function decodeUuid(value) {
  if (typeof value !== 'string') throw new Error('Invalid asset UUID');
  if (value.length !== 22) {
    if (!/^[a-f0-9-]+$/i.test(value)) throw new Error('Invalid asset UUID: ' + value);
    return value;
  }
  if (!/^[a-f0-9]{2}[A-Za-z0-9+/]{20}$/i.test(value)) throw new Error('Invalid compressed UUID');
  let hex = value.slice(0, 2);
  for (let i = 2; i < value.length; i += 2) {
    const a = alphabet.indexOf(value[i]), b = alphabet.indexOf(value[i + 1]);
    hex += (a >> 2).toString(16) + (((a & 3) << 2) | (b >> 4)).toString(16) + (b & 15).toString(16);
  }
  return [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20)].join('-');
}

export async function readVersions(root) {
  const names = (await fs.readdir(path.join(root, 'src'))).filter(n => /^settings\.[a-f0-9]+\.js$/i.test(n));
  if (names.length !== 1) throw new Error('Expected exactly one original settings.<hash>.js');
  const sandbox = { window: {} };
  vm.runInNewContext(await fs.readFile(path.join(root, 'src', names[0]), 'utf8'), sandbox, { timeout: 1000 });
  const versions = sandbox.window._CCSettings?.bundleVers;
  if (!versions || Object.entries(versions).some(([name,hash]) => !safeName(name) || !safeName(hash))) {
    throw new Error('Invalid original bundle version manifest');
  }
  return { ...versions };
}

function assetId(config, id) { return decodeUuid(typeof id === 'number' ? config.uuids[id] : id); }
export function importFiles(config) {
  const versions = config.versions?.import || [];
  if (versions.length % 2) throw new Error('Invalid import version manifest');
  const result = new Map();
  for (let i = 0; i < versions.length; i += 2) {
    const uuid = assetId(config, versions[i]), hash = versions[i + 1];
    if (!safeName(hash)) throw new Error('Invalid asset version');
    result.set(versions[i], 'import/' + uuid.slice(0,2) + '/' + uuid + '.' + hash + '.json');
  }
  return result;
}

function extensionStrings(data, found = new Set()) {
  if (typeof data === 'string' && /^\.[a-z0-9]{1,8}$/i.test(data)) found.add(data);
  else if (Array.isArray(data)) for (const item of data) extensionStrings(item, found);
  else if (data && typeof data === 'object') for (const item of Object.values(data)) extensionStrings(item, found);
  return found;
}

export function nativeExtension(config, id, imports) {
  let data = imports.get(id);
  if (!data) {
    const pack = Object.entries(config.packs || {}).find(([,ids]) => ids.includes(id));
    const packed = pack && imports.get(pack[0]);
    if (packed?.type === 'cc.Texture2D') {
      const serialized = packed.data.split('|')[pack[1].indexOf(id)];
      // Original Texture2D pack uses format 0 for PNG. Other native formats
      // require their original metadata; never guess and save a wrong file.
      if (serialized?.split(',')[0] === '0') return '.png';
    }
    if (Array.isArray(packed) && Array.isArray(packed[5])) {
      data = packed[5][pack[1].indexOf(id)];
      // Mixed compiled packs identify custom texture objects by their shared
      // class index, rather than the top-level {type,data} texture-only format.
      if (packed[3]?.[data?.[1]?.[0]] === 'cc.Texture2D'
        && typeof data?.[0]?.[0] === 'string' && data[0][0].split(',')[0] === '0') return '.png';
    }
  }
  const extensions = [...extensionStrings(data)];
  if (extensions.length === 1) return extensions[0];
  if (Array.isArray(data?.[3]) && data[3].some(type => Array.isArray(type) && type[0] === 'cc.TTFFont')) {
    const filenames = JSON.stringify(data[5]).match(/[A-Za-z0-9_ -]+\.(?:ttf|otf|woff2?)/g) || [];
    if (new Set(filenames).size === 1) return '/' + filenames[0];
  }
  if (data?.__type__ === 'cc.Texture2D' && !data._native) return '.png';
  throw new Error('Cannot determine original native extension for ' + assetId(config, id));
}

function validate(bytes, relative) {
  if (!bytes.length || /^\s*(?:<!doctype\s+html|<html)/i.test(bytes.subarray(0,512).toString())) {
    throw new Error('Empty or HTML response for ' + relative);
  }
  if (relative.endsWith('.json')) {
    const value = JSON.parse(bytes.toString('utf8'));
    const configMatch = /^assets\/([^/]+)\/config\.[^/]+\.json$/.exec(relative);
    if (configMatch && (value.name !== configMatch[1] || value.importBase !== 'import'
      || value.nativeBase !== 'native' || value.isZip || value.encrypted)) {
      throw new Error('Unsupported or mismatched original bundle ' + configMatch[1]);
    }
  }
  if (relative.endsWith('.png') && bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('Invalid PNG response for ' + relative);
  }
}

export async function syncAssets({ root, source, bundles, all = false, audit = false, fetcher = fetch, onProgress = () => {} }) {
  const versions = await readVersions(root);
  const chosen = all ? Object.keys(versions) : bundles || ['Turntable', 'holdemGame_zh_cn_Turntable'];
  const sourceUrl = source && new URL(source);
  if (!audit && (!sourceUrl || !['https:', 'http:'].includes(sourceUrl.protocol) || sourceUrl.search
    || sourceUrl.hash || sourceUrl.username || sourceUrl.password)) {
    throw new Error('--source must be the public static base URL without login parameters');
  }
  const base = sourceUrl && new URL(sourceUrl.href.replace(/\/?$/, '/'));
  const report = { outputDirectory: path.resolve(root), checkedBundles: [], downloaded: [], existing: 0, missing: [], errors: [] };
  const pending = [...chosen], done = new Set();
  const read = async (relative) => {
    const destination = path.resolve(root, relative);
    if (!destination.startsWith(path.resolve(root) + path.sep)) throw new Error('Unsafe destination');
    try {
      const bytes = await fs.readFile(destination);
      validate(bytes, relative); report.existing++; return bytes;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error; // Never overwrite an invalid existing original.
    }
    if (audit) { report.missing.push(relative); return null; }
    const url = new URL(relative, base);
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + relative);
        const bytes = Buffer.from(await response.arrayBuffer());
        validate(bytes, relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        // Exclusive create protects original files even during concurrent runs.
        await fs.writeFile(destination, bytes, { flag: 'wx' });
        report.downloaded.push(relative); onProgress(relative); return bytes;
      } catch (error) {
        lastError = error;
        if (error.code === 'EEXIST') return fs.readFile(destination);
        if (/HTTP 40[134]/.test(error.message)) break;
      }
    }
    throw lastError;
  };
  while (pending.length) {
    const name = pending.shift();
    if (done.has(name)) continue;
    done.add(name);
    try {
      const hash = versions[name];
      if (!safeName(name) || !hash) throw new Error('Bundle is not declared in this client version: ' + name);
      const prefix = 'assets/' + name + '/';
      const bytes = await read(prefix + 'config.' + hash + '.json');
      if (!bytes) continue;
      const config = JSON.parse(bytes.toString('utf8'));
      if (config.name !== name || config.importBase !== 'import' || config.nativeBase !== 'native'
        || config.isZip || config.encrypted) throw new Error('Unsupported or mismatched original bundle ' + name);
      report.checkedBundles.push(name);
      pending.push(...(config.deps || []));
      await read(prefix + 'index.' + hash + '.js');
      const imports = new Map();
      for (const [id, relative] of importFiles(config)) {
        const content = await read(prefix + relative);
        if (content) imports.set(id, JSON.parse(content.toString('utf8')));
      }
      const natives = config.versions?.native || [];
      if (natives.length % 2) throw new Error('Invalid native version manifest');
      for (let i = 0; i < natives.length; i += 2) {
        const id = natives[i], uuid = assetId(config, id), nativeHash = natives[i + 1];
        if (!safeName(nativeHash)) throw new Error('Invalid native version');
        const directory = prefix + 'native/' + uuid.slice(0,2) + '/';
        const stem = uuid + '.' + nativeHash;
        const existing = await fs.readdir(path.join(root, directory)).catch(error => {
          if (error.code !== 'ENOENT') throw error; return [];
        });
        const matches = existing.filter(file => file.startsWith(stem + '.') && /^\.[a-z0-9]{1,8}$/i.test(file.slice(stem.length)));
        if (matches.length) { for (const file of matches) await read(directory + file); continue; }
        try {
          await read(directory + stem + nativeExtension(config, id, imports));
        } catch (error) { report.errors.push(name + ': ' + error.message); }
      }
    } catch (error) { report.errors.push(name + ': ' + error.message); }
  }
  return report;
}

export function cliOptions(args) {
  const options = { version: '2.0.1279', bundles: [] };
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--all') options.all = true;
    else if (name === '--audit') options.audit = true;
    else if (['--source','--version','--bundle'].includes(name)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing value for ' + name);
      if (name === '--bundle') options.bundles.push(value); else options[name.slice(2)] = value;
    } else throw new Error('Unknown argument ' + name);
  }
  if (!/^\d+\.\d+\.\d+$/.test(options.version)) throw new Error('Invalid client version');
  options.root = path.join(repository, 'static/client', options.version);
  // --source is the version directory, for example https://www.example/2.0.1279/.
  // A different online version is never merged into the local 2.0.1279 tree.
  if (options.source && !new URL(options.source).pathname.replace(/\/$/,'').endsWith('/' + options.version)) {
    throw new Error('--source must end with the matching /' + options.version + '/ version directory');
  }
  if (!options.bundles.length) delete options.bundles;
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await syncAssets({ ...cliOptions(process.argv.slice(2)), onProgress: file => console.log('Downloaded ' + file) });
    console.log(JSON.stringify(report, null, 2));
    if (report.errors.length || report.missing.length) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
