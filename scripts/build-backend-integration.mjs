import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const staged=path.join(root,'cache/backend-integration/gogames');
const baseline=path.resolve(process.argv[2]||'D:/project/gogames');
const output=path.join(root,'doc/待应用/线上后端对接');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const validPath=item=>typeof item==='string'&&/^(app|data-center|lottery|micro_service|web-api)\/[a-zA-Z0-9_./-]+\.(go|proto)$/.test(item)
 &&!item.split('/').some(part=>!part||part==='.'||part==='..');
// Applied-package manifests are our reviewed baseline. Never silently make a
// concurrent user edit the "before" hash of an older staged replacement.
const reviewed=new Map(),backups=path.join(baseline,'backups');
if(fs.existsSync(backups))for(const directory of fs.readdirSync(backups).sort()){
  const manifestFile=path.join(backups,directory,'manifest.json');if(!fs.existsSync(manifestFile))continue;
  const previous=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  if(previous.format===1&&Array.isArray(previous.files))for(const entry of previous.files)reviewed.set(entry.path,entry.after);
}
// Existing backend files first touched by this batch can have an explicitly
// reviewed source snapshot; later user edits still fail the same digest check.
const snapshotFile=path.join(root,'cache/backend-integration/reviewed-baseline.json');
let deletions=[];
if(fs.existsSync(snapshotFile)){
 const snapshot=JSON.parse(fs.readFileSync(snapshotFile,'utf8'));
 if(snapshot.target!==baseline.replaceAll('\\','/'))throw Error('Reviewed snapshot belongs to another backend');
 for(const entry of snapshot.files){
  if(!validPath(entry.path)||! /^[a-f0-9]{64}$/.test(entry.sha256))throw Error('Invalid reviewed snapshot');
  if(!reviewed.has(entry.path))reviewed.set(entry.path,entry.sha256);
 }
 deletions=snapshot.deletions??[];
 if(!Array.isArray(deletions)||deletions.some(item=>!validPath(item))||new Set(deletions).size!==deletions.length)throw Error('Invalid explicit backend deletions');
}
const files=[];
function visit(relative){
 for(const entry of fs.readdirSync(path.join(staged,relative),{withFileTypes:true})){
  const item=relative+'/'+entry.name;
  if(entry.isDirectory())visit(item);
  else if(/\.(go|proto)$/.test(item)){
   const content=fs.readFileSync(path.join(staged,item)),target=path.join(baseline,item);
   const old=fs.existsSync(target)?fs.readFileSync(target):null;
   if(old&&digest(old)===digest(content))continue;
   if(old&&reviewed.get(item)!==digest(old))throw Error('Backend file differs from reviewed baseline; merge it before packaging: '+item);
   files.push({path:item,before:old?digest(old):null,after:digest(content)});
  }
 }
}
for(const module of ['app','data-center','lottery','micro_service','web-api'])visit(module);
// Missing staged files alone never imply deletion: this is a partial checkout.
// Only explicitly reviewed removals may delete an existing backend file.
for(const item of deletions){
 if(fs.existsSync(path.join(staged,item)))throw Error('Deleted backend file still exists in staging: '+item);
 const target=path.join(baseline,item);
 if(!fs.existsSync(target))continue;
 const before=digest(fs.readFileSync(target));
 if(reviewed.get(item)!==before)throw Error('Backend deletion differs from reviewed baseline: '+item);
 files.push({path:item,before,after:null});
}
files.sort((a,b)=>a.path.localeCompare(b.path));
// Validate the complete source set before changing any existing package file.
// A failed baseline check must leave the previous manifest and payload intact.
for(const entry of files){
 const stagedFile=path.join(staged,entry.path);
 const after=fs.existsSync(stagedFile)?digest(fs.readFileSync(stagedFile)):null;
 const target=path.join(baseline,entry.path);
 if(after!==entry.after||(fs.existsSync(target)?digest(fs.readFileSync(target)):null)!==entry.before)throw Error('Integration sources changed during review: '+entry.path);
}
const payloadRoot=path.join(output,'files'),payloads=new Set(files.filter(entry=>entry.after!==null).map(entry=>entry.path));
function obsoletePayloads(directory){
 if(!fs.existsSync(directory))return [];
 const obsolete=[];
 for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  const file=path.join(directory,entry.name);
  if(entry.isSymbolicLink())throw Error('Symbolic link in integration payload');
  if(entry.isDirectory())obsolete.push(...obsoletePayloads(file));
  else if(!payloads.has(path.relative(payloadRoot,file).replaceAll('\\','/')))obsolete.push(file);
 }
 return obsolete;
}
const obsolete=obsoletePayloads(payloadRoot);
for(const entry of files){if(entry.after===null)continue;const destination=path.join(payloadRoot,entry.path);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(staged,entry.path),destination);}
for(const file of obsolete)fs.unlinkSync(file);
fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify({format:1,date:'2026-11-12',files},null,2)+'\n');
console.log('Prepared '+files.length+' source files; no backend or database was changed.');
