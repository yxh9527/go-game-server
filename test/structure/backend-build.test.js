import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const source=fileURLToPath(new URL('../../scripts/build-backend-integration.mjs',import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gogame-build-')),target=path.join(root,'backend');
 const project=path.join(root,'project'),staged=path.join(project,'cache/backend-integration/gogames');
 for(const name of ['app','data-center','lottery','micro_service','web-api'])fs.mkdirSync(path.join(staged,name),{recursive:true});
 fs.mkdirSync(path.join(target,'app'),{recursive:true});fs.mkdirSync(path.join(project,'scripts'));
 fs.copyFileSync(source,path.join(project,'scripts/build-backend-integration.mjs'));
 fs.writeFileSync(path.join(target,'app/removed.go'),'retired source');
 fs.writeFileSync(path.join(target,'app/unrelated.go'),'keep user file');
 const snapshot={target:target.replaceAll('\\','/'),files:[{path:'app/removed.go',sha256:hash('retired source')}],deletions:['app/removed.go']};
 const save=()=>fs.writeFileSync(path.join(project,'cache/backend-integration/reviewed-baseline.json'),JSON.stringify(snapshot));save();
 const bundle=path.join(project,'doc/待应用/线上后端对接');
 fs.mkdirSync(path.join(bundle,'files/app'),{recursive:true});
 fs.writeFileSync(path.join(bundle,'files/app/removed.go'),'old bundle payload');
 const run=()=>spawnSync(process.execPath,[path.join(project,'scripts/build-backend-integration.mjs'),target],{encoding:'utf8',windowsHide:true});
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {target,staged,bundle,snapshot,save,run};
}

test('builder packages only explicit reviewed removals and removes obsolete payloads',t=>{
 const f=fixture(t),result=f.run();assert.equal(result.status,0,result.stderr);
 const manifest=JSON.parse(fs.readFileSync(path.join(f.bundle,'manifest.json'),'utf8'));
 assert.deepEqual(manifest.files,[{path:'app/removed.go',before:hash('retired source'),after:null}]);
 assert.equal(fs.existsSync(path.join(f.bundle,'files/app/removed.go')),false);
 assert.equal(fs.readFileSync(path.join(f.target,'app/removed.go'),'utf8'),'retired source');
 assert.equal(fs.readFileSync(path.join(f.target,'app/unrelated.go'),'utf8'),'keep user file');
});

test('unreviewed removal and conflicting staged replacement leave the previous bundle intact',t=>{
 const f=fixture(t);
 fs.writeFileSync(path.join(f.target,'app/removed.go'),'user changes');
 assert.notEqual(f.run().status,0);
 assert.equal(fs.readFileSync(path.join(f.bundle,'files/app/removed.go'),'utf8'),'old bundle payload');
 fs.writeFileSync(path.join(f.target,'app/removed.go'),'retired source');
 fs.writeFileSync(path.join(f.staged,'app/removed.go'),'replacement contradicts removal');
 assert.notEqual(f.run().status,0);
 assert.equal(fs.readFileSync(path.join(f.bundle,'files/app/removed.go'),'utf8'),'old bundle payload');
});
