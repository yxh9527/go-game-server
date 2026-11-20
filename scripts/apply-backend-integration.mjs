import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

let bundle=fileURLToPath(new URL('../doc/待应用/线上后端对接/',import.meta.url));
let targetArgument='D:/project/gogames',apply=false,hasTarget=false;
const args=process.argv.slice(2);
for(let i=0;i<args.length;i++){
 const arg=args[i];
 if(arg==='--apply')apply=true;
 else if(arg==='--bundle'){if(!args[++i])throw Error('Bundle path is missing');bundle=path.resolve(args[i]);}
 else if(!arg.startsWith('--')&&!hasTarget){targetArgument=arg;hasTarget=true;}
 else throw Error('Unexpected integration argument: '+arg);
}
const target=fs.realpathSync(targetArgument);
const manifest=JSON.parse(fs.readFileSync(path.join(bundle,'manifest.json'),'utf8'));
if(manifest.format!==1||!Array.isArray(manifest.files))throw Error('Unsupported integration manifest');
const digest=file=>fs.existsSync(file)?createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null;
const seen=new Set(),pending=[];
for(const item of manifest.files){
 if(typeof item.path!=='string'||! /^(app|data-center|lottery|micro_service|web-api)\//.test(item.path)
   ||item.path.split('/').some(part=>!part||part==='.'||part==='..')||item.path.includes('\\')||item.path.includes(':')
   ||! /\.(go|proto)$/.test(item.path)||seen.has(item.path))throw Error('Invalid integration path');
 if(![item.before,item.after].every(value=>value===null||typeof value==='string'&&/^[a-f0-9]{64}$/.test(value))
   ||item.before===null&&item.after===null)throw Error('Invalid integration hashes');
 seen.add(item.path);
 const destination=path.join(target,item.path),source=path.join(bundle,'files',item.path);
 let directory=path.dirname(destination);
 while(directory!==target){if(fs.existsSync(directory)&&fs.lstatSync(directory).isSymbolicLink())throw Error('Symbolic link in backend target');directory=path.dirname(directory);}
 if(fs.existsSync(destination)&&fs.lstatSync(destination).isSymbolicLink())throw Error('Symbolic link in backend source');
 if(item.after===null&&fs.existsSync(source)||digest(source)!==item.after)throw Error('Damaged integration payload: '+item.path);
 const current=digest(destination);
 if(current===item.after)continue;
 if(current!==item.before)throw Error('Backend changed since preparation; refusing overwrite: '+item.path);
 pending.push({item,source,destination});
}
if(!apply){console.log('Validated '+manifest.files.length+' files; '+pending.length+' changes pending. Add --apply to write.');process.exit(0);}
if(!pending.length){console.log('All backend files already match; no changes.');process.exit(0);}
const backup=path.join(target,'backups','gogame-integration-'+new Date().toISOString().replace(/[:.]/g,'-'));
const written=[];
try{
 for(const change of pending){
  const {item,source,destination}=change;
  if(digest(destination)!==item.before||digest(source)!==item.after)throw Error('Integration input changed during apply: '+item.path);
  if(item.before!==null){const saved=path.join(backup,item.path);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(destination,saved);}
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  // Record before mutation so a failed write also participates in rollback.
  written.push(change);
  if(item.after===null)fs.unlinkSync(destination);
  else fs.copyFileSync(source,destination);
 }
}catch(error){
 for(const {item,destination}of written.reverse()){
  if(item.before!==null)fs.copyFileSync(path.join(backup,item.path),destination);
  else if(fs.existsSync(destination))fs.unlinkSync(destination);
 }
 throw error;
}
fs.mkdirSync(backup,{recursive:true});fs.writeFileSync(path.join(backup,'manifest.json'),JSON.stringify(manifest,null,2));
console.log('Applied '+written.length+' backend files. Backup: '+backup);
console.log('No services restarted. No database migration or game/pool configuration was executed.');
