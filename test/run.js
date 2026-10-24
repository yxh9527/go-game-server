import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const scopes = new Set(['shared', 'hall', 'client-web', 'game-server', 'match', 'structure']);
const args = process.argv.slice(2);
const scope = args[0] && !args[0].startsWith('-') ? args.shift() : null;
if (scope && !scopes.has(scope)) throw new Error('Unknown test scope: ' + scope);
const files = fs.readdirSync(here, { recursive: true })
  .filter(file => file.endsWith('.test.js') && (!scope || file.split(path.sep)[0] === scope))
  .sort().map(file => path.join(here, file));
if (!files.length) throw new Error('No tests found');
const result = spawnSync(process.execPath, ['--test', ...args, ...files], { cwd: root, stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
