import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(repository, 'static/hall');

// Discover exact image references in the shipped client, including CSS backgrounds.
export async function userCenterAssets() {
  const files = ['_next/static/chunks/pages/user-center-a49803c295170ddd.js',
    '_next/static/chunks/832-7498b6b2aa7730de.js', '_next/static/chunks/725-7aca9f45a6dd3f1d.js',
    '_next/static/chunks/903-32a74abc84f530c1.js'];
  files.push(...(await fs.readdir(path.join(root, '_next/static/css'))).map(name => '_next/static/css/' + name));
  const assets = new Set();
  // Values used by the native fund renderer's sourceType mapping and boolean ticket state.
  for(let i=0;i<=9;i++)assets.add('/l01/img/fund-details/point_'+i+'.png');
  for(let i=0;i<=1;i++)assets.add('/l01/img/fund-details/ticket_'+i+'.png');
  for (const file of files) {
    const text = await fs.readFile(path.join(root, file), 'utf8');
    for (const match of text.matchAll(/(?:["']|url\(["']?)(\/l01\/[^\s"'()]+\.(?:png|webp|svg|jpg|gif))(?:["']|\))/g)) {
      if (!file.endsWith('.css') || /record|user-center|majiang|fund-detail/.test(match[1])) assets.add(match[1]);
    }
  }
  return [...assets].sort();
}

function validate(bytes, name) {
  const ext = path.extname(name);
  const valid = ext === '.png' ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    : ext === '.webp' ? bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length
    : ext === '.svg' ? /^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(bytes.toString('utf8'))
    : ext === '.jpg' ? bytes.subarray(0, 3).toString('hex') === 'ffd8ff'
    : ext === '.gif' && /^GIF8[79]a/.test(bytes.toString('ascii', 0, 6));
  if (bytes.length < 20 || !valid) throw new Error('Invalid image: ' + name);
}

export async function syncUserCenterAssets({ source, audit = false } = {}) {
  const base = source ? new URL(source) : null;
  if (!audit && (!base || !['https:', 'http:'].includes(base.protocol) || base.pathname !== '/' || base.search || base.hash || base.username || base.password)) {
    throw new Error('Specify --source with the public hall origin only');
  }
  const assets = await userCenterAssets(), queue = [...assets];
  const report = { expected: assets.length, existing: 0, downloaded: [], missing: [], errors: [] };
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const name = queue.shift(), destination = path.join(root, name.slice(1));
      try {
        try { validate(await fs.readFile(destination), name); report.existing++; continue; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (audit) { report.missing.push(name); continue; }
        const response = await fetch(new URL(name, base), { signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const bytes = Buffer.from(await response.arrayBuffer()); validate(bytes, name);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        try { await fs.writeFile(destination, bytes, { flag: 'wx' }); report.downloaded.push(name); }
        catch (error) { if (error.code !== 'EEXIST') throw error; validate(await fs.readFile(destination), name); report.existing++; }
      } catch (error) { report.errors.push({ path: name, error: error.message }); }
    }
  }));
  report.downloaded.sort(); report.missing.sort(); report.errors.sort((a, b) => a.path.localeCompare(b.path));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options={},args=process.argv.slice(2);
  for(let i=0;i<args.length;i++){
    if(args[i]==='--audit')options.audit=true;
    else if(args[i]==='--source'&&args[i+1]&&!args[i+1].startsWith('--'))options.source=args[++i];
    else throw new Error('Unknown or incomplete argument: '+args[i]);
  }
  const report = await syncUserCenterAssets(options);
  console.log(JSON.stringify(report, null, 2));
  if (report.missing.length || report.errors.length) process.exitCode = 1;
}
