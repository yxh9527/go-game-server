import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const stage=path.dirname(fileURLToPath(import.meta.url)),target=path.resolve('D:/project/gogames');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest=JSON.parse(await fs.readFile(path.join(stage,'manifest.json'),'utf8'));
const writes=[];
for(const item of manifest){
  const destination=path.resolve(target,item.relative),source=path.resolve(stage,item.relative);
  for(const [base,file] of [[target,destination],[stage,source]]){
    const rel=path.relative(base,file);if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw new Error('Path escapes intended repository');
  }
  const staged=await fs.readFile(source);if(hash(staged)!==item.stagedHash)throw new Error('Staged file changed: '+item.relative);
  const current=await fs.readFile(destination).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  const currentHash=current?hash(current):null;
  if(currentHash===item.stagedHash)continue;
  if(currentHash!==item.originalHash)throw new Error('Target changed; refusing to overwrite: '+item.relative);
  writes.push({destination,staged,relative:item.relative});
}
for(const item of writes){await fs.mkdir(path.dirname(item.destination),{recursive:true});await fs.writeFile(item.destination,item.staged);}
console.log(JSON.stringify({written:writes.map(f=>f.relative),verified:manifest.length}));
