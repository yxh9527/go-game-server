import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const clientRoot=fileURLToPath(new URL('../static/client/',import.meta.url));

// Shared asset lookup must not load the entire client HTTP application into
// each hall business version. No server or process-wide cache is owned here.
export function clientVersion(){
  if(!fs.existsSync(clientRoot))return '2.0.1279';
  const names=fs.readdirSync(clientRoot).filter(name=>/^\d+\.\d/.test(name)).sort();
  return names.at(-1)||'2.0.1279';
}
