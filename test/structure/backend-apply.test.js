import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const script=fileURLToPath(new URL('../../scripts/apply-backend-integration.mjs',import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gogame-integration-')),target=path.join(root,'backend'),bundle=path.join(root,'bundle');
 fs.mkdirSync(path.join(target,'app'),{recursive:true});fs.mkdirSync(path.join(bundle,'files/app'),{recursive:true});
 fs.writeFileSync(path.join(target,'app/existing.go'),'old source');
 fs.writeFileSync(path.join(bundle,'files/app/existing.go'),'new source');fs.writeFileSync(path.join(bundle,'files/app/added.go'),'added source');
 const manifest={format:1,files:[{path:'app/existing.go',before:hash('old source'),after:hash('new source')},{path:'app/added.go',before:null,after:hash('added source')}]};
 const save=()=>fs.writeFileSync(path.join(bundle,'manifest.json'),JSON.stringify(manifest));save();
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,target,bundle,manifest,save,run:(...args)=>spawnSync(process.execPath,[script,target,'--bundle',bundle,...args],{encoding:'utf8',windowsHide:true})};
}
test('backend application validates before writing, preserves backups and is repeatable',t=>{
 const f=fixture(t);assert.equal(f.run().status,0);assert.equal(fs.readFileSync(path.join(f.target,'app/existing.go'),'utf8'),'old source');
 assert.equal(fs.existsSync(path.join(f.target,'app/added.go')),false);
 const applied=f.run('--apply');assert.equal(applied.status,0,applied.stderr);
 const backup=fs.readdirSync(path.join(f.target,'backups'))[0];
 assert.equal(fs.readFileSync(path.join(f.target,'backups',backup,'app/existing.go'),'utf8'),'old source');
 assert.equal(fs.readFileSync(path.join(f.target,'app/added.go'),'utf8'),'added source');
 assert.equal(f.run('--apply').status,0);assert.equal(fs.readdirSync(path.join(f.target,'backups')).length,1);
});
test('concurrent backend edits and damaged payloads abort the entire application before its first write',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.target,'app/added.go'),'someone else');
 assert.notEqual(f.run('--apply').status,0);assert.equal(fs.readFileSync(path.join(f.target,'app/existing.go'),'utf8'),'old source');
 fs.unlinkSync(path.join(f.target,'app/added.go'));fs.writeFileSync(path.join(f.bundle,'files/app/added.go'),'damaged');
 assert.notEqual(f.run('--apply').status,0);assert.equal(fs.readFileSync(path.join(f.target,'app/existing.go'),'utf8'),'old source');
});
test('manifest path traversal cannot write outside the backend root',t=>{
 const f=fixture(t);f.manifest.files[0].path='app/../../outside.go';f.save();
 assert.notEqual(f.run('--apply').status,0);assert.equal(fs.readFileSync(path.join(f.target,'app/existing.go'),'utf8'),'old source');
});

function addDeletion(f){
 fs.writeFileSync(path.join(f.target,'app/removed.go'),'retired source');
 f.manifest.files.unshift({path:'app/removed.go',before:hash('retired source'),after:null});f.save();
}

test('explicit file removal is backed up, validated without mutation, and repeatable',t=>{
 const f=fixture(t);addDeletion(f);
 assert.equal(f.run().status,0);assert.equal(fs.existsSync(path.join(f.target,'app/removed.go')),true);
 const applied=f.run('--apply');assert.equal(applied.status,0,applied.stderr);
 assert.equal(fs.existsSync(path.join(f.target,'app/removed.go')),false);
 const backup=fs.readdirSync(path.join(f.target,'backups'))[0];
 assert.equal(fs.readFileSync(path.join(f.target,'backups',backup,'app/removed.go'),'utf8'),'retired source');
 assert.equal(f.run('--apply').status,0);assert.equal(fs.readdirSync(path.join(f.target,'backups')).length,1);
});

test('concurrent changes and unexpected deletion payloads prevent all mutations',t=>{
 const f=fixture(t);addDeletion(f);
 fs.writeFileSync(path.join(f.target,'app/removed.go'),'user changes');
 assert.notEqual(f.run('--apply').status,0);
 assert.equal(fs.readFileSync(path.join(f.target,'app/removed.go'),'utf8'),'user changes');
 assert.equal(fs.readFileSync(path.join(f.target,'app/existing.go'),'utf8'),'old source');
 fs.writeFileSync(path.join(f.target,'app/removed.go'),'retired source');
 fs.writeFileSync(path.join(f.bundle,'files/app/removed.go'),'stale replacement');
 assert.notEqual(f.run('--apply').status,0);
 assert.equal(fs.existsSync(path.join(f.target,'app/removed.go')),true);
 assert.equal(fs.readFileSync(path.join(f.target,'app/existing.go'),'utf8'),'old source');
});

test('a later write failure restores previously deleted and replaced files',t=>{
 const f=fixture(t);addDeletion(f);
 const hook=path.join(f.root,'fail-copy.mjs');
 fs.writeFileSync(hook,`import fs from 'node:fs';
const original=fs.copyFileSync;
fs.copyFileSync=function(source,...args){if(String(source).endsWith('added.go'))throw Error('simulated write failure');return original.call(this,source,...args);};`);
 const result=spawnSync(process.execPath,['--import',pathToFileURL(hook).href,script,f.target,'--bundle',f.bundle,'--apply'],{encoding:'utf8',windowsHide:true});
 assert.notEqual(result.status,0);assert.match(result.stderr,/simulated write failure/);
 assert.equal(fs.readFileSync(path.join(f.target,'app/removed.go'),'utf8'),'retired source');
 assert.equal(fs.readFileSync(path.join(f.target,'app/existing.go'),'utf8'),'old source');
 assert.equal(fs.existsSync(path.join(f.target,'app/added.go')),false);
});
