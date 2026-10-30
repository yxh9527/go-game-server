import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const stage=path.dirname(fileURLToPath(import.meta.url)),target='D:/project/gogames';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function copy(relative,change=value=>value){
  const source=await fs.readFile(path.join(target,relative),'utf8');
  const output=path.join(stage,relative);await fs.mkdir(path.dirname(output),{recursive:true});
  await fs.writeFile(output,change(source));
}
await fs.rm(path.join(stage,'data-center/rpc/service.go'),{force:true});
await copy('data-center/rpc/server.go',s=>s.replace('services.RegisterDataCenterServiceServer(ss, s.handler)','services.RegisterDataCenterServiceServer(ss, s.handler)\n\tservices.RegisterGogameStorageServiceServer(ss, newGogameStorageService(s.handler.db))'));
await copy('app/tables/gogame/match.go');await copy('app/tables/gogame/seed.go');
await fs.rm(path.join(stage,'app/tables/gogame/tournament.go'),{force:true});
execFileSync('git',['apply','--check',path.join(stage,'../比赛持久化表结构.patch')],{cwd:stage,stdio:'pipe'});
execFileSync('git',['apply',path.join(stage,'../比赛持久化表结构.patch')],{cwd:stage,stdio:'pipe'});
await fs.mkdir(path.join(stage,'micro_service/proto'),{recursive:true});
await fs.mkdir(path.join(stage,'micro_service/services'),{recursive:true});
await fs.copyFile(path.resolve(stage,'../../../shared/rpc/proto/gogame.proto'),path.join(stage,'micro_service/proto/gogame.proto'));
execFileSync('protoc',['--proto_path=micro_service/proto','--go_out=micro_service','--go-grpc_out=micro_service','gogame.proto'],{cwd:stage,stdio:'pipe'});
const files=(await fs.readdir(stage,{recursive:true})).filter(f=>/\.(go|proto)$/.test(f));
execFileSync('gofmt',['-w',...files.filter(f=>f.endsWith('.go')).map(f=>path.join(stage,f))],{cwd:stage,stdio:'pipe'});
const manifest=[],Replace={};
for(const relative of files){
  const destination=path.join(target,relative),source=path.join(stage,relative);
  const original=await fs.readFile(destination).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  manifest.push({relative:relative.replaceAll('\\','/'),originalHash:original?hash(original):null,stagedHash:hash(await fs.readFile(source))});
  Replace[destination]=source;
}
await fs.writeFile(path.join(stage,'manifest.json'),JSON.stringify(manifest,null,2));
await fs.writeFile(path.join(stage,'overlay.json'),JSON.stringify({Replace},null,2));
console.log(JSON.stringify({files:manifest.map(f=>f.relative),overlay:path.join(stage,'overlay.json')}));
