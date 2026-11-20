import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const allowed=new Set(['NewAdminclient/src/router/routes.js','NewAdminclient/src/views/gogame-match/MatchManagement.vue','NewAdminclient/vue.config.js','adminagent/src/router/routers.js','adminagent/src/view/gogame-match/MatchManagement.vue','adminagent/vue.config.js']);
const digest=file=>fs.existsSync(file)?createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null;
function regularParents(file,base){
  let current=file;
  while(current!==base){
    if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('Symbolic link in frontend integration path');
    const parent=path.dirname(current);if(parent===current)throw Error('Frontend path escapes target');current=parent;
  }
}
export function applyAdminIntegration({target='D:/project/gogames',bundle=path.join(root,'doc/待应用/比赛后台菜单'),apply=false}={}){
  target=fs.realpathSync(target);bundle=fs.realpathSync(bundle);
  const manifest=JSON.parse(fs.readFileSync(path.join(bundle,'manifest.json'),'utf8'));
  if(manifest.format!==1||manifest.kind!=='gogame-admin-menu'||!Array.isArray(manifest.files))throw Error('Invalid admin integration manifest');
  const seen=new Set(),pending=[];
  for(const entry of manifest.files){
    if(!allowed.has(entry.path)||seen.has(entry.path)||entry.after===null||![entry.before,entry.after].every(value=>value===null||typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))throw Error('Invalid frontend integration file');
    seen.add(entry.path);
    const destination=path.join(target,entry.path),source=path.join(bundle,'files',entry.path);
    regularParents(destination,target);regularParents(source,bundle);
    if(digest(source)!==entry.after)throw Error('Damaged frontend payload: '+entry.path);
    const current=digest(destination);if(current===entry.after)continue;
    if(current!==entry.before)throw Error('Frontend changed; refusing overwrite: '+entry.path);
    pending.push({entry,source,destination});
  }
  if(seen.size!==allowed.size)throw Error('Incomplete frontend integration bundle');
  if(!apply||!pending.length)return {files:seen.size,pending:pending.length};
  regularParents(path.join(target,'backups'),target);
  const backup=path.join(target,'backups','gogame-admin-menu-'+new Date().toISOString().replace(/[:.]/g,'-')),written=[];
  try{
    for(const change of pending){
      const {entry,source,destination}=change;
      regularParents(destination,target);
      if(digest(destination)!==entry.before||digest(source)!==entry.after)throw Error('Frontend changed during apply: '+entry.path);
      if(entry.before!==null){const saved=path.join(backup,entry.path);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(destination,saved);}
      fs.mkdirSync(path.dirname(destination),{recursive:true});written.push(change);fs.copyFileSync(source,destination);
    }
  }catch(error){
    for(const {entry,destination}of written.reverse()){
      if(entry.before===null){if(fs.existsSync(destination))fs.unlinkSync(destination);}
      else fs.copyFileSync(path.join(backup,entry.path),destination);
    }
    throw error;
  }
  fs.mkdirSync(backup,{recursive:true});fs.writeFileSync(path.join(backup,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return {files:seen.size,pending:0,applied:pending.length,backup};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  let target,bundle,apply=false;
  for(let i=2;i<process.argv.length;i++){
    const arg=process.argv[i];if(arg==='--apply')apply=true;else if(arg==='--bundle'){bundle=process.argv[++i];if(!bundle)throw Error('Bundle path missing');}
    else if(!arg.startsWith('--')&&!target)target=arg;else throw Error('Unexpected frontend integration argument');
  }
  console.log(JSON.stringify(applyAdminIntegration({target,bundle,apply})));
}
