import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import yaml from 'js-yaml';

export const backendServices=['lottery','data-center','web-api','open-api','client-api','game-data-summary'];
const desired={manager:'go_manager',player:'go_player'};
const oldNames={manager:new Set(['fg_web_manager','fg_manager','go_web_manager','go_manager']),player:new Set(['fg_player','go_player'])};
const digest=buffer=>createHash('sha256').update(buffer).digest('hex');

// Patch the two reviewed scalar lines in place. Never reserialize the YAML:
// connection credentials, comments, formatting and unrelated edits are retained.
export function databaseConfigPatch(source){
  const old=yaml.load(source);
  if(!old?.mysql||Object.keys(old.mysql).sort().join(',')!=='manager,player')throw Error('Unexpected MySQL configuration shape');
  for(const role of ['manager','player'])if(!oldNames[role].has(old.mysql[role]?.database))throw Error('Unexpected '+role+' database name; review it before changing');
  let inMysql=false,role=null,count=0;
  const next=source.split(/(?<=\n)/).map(line=>{
    if(/^mysql\s*:/.test(line)){inMysql=true;role=null;return line}
    if(inMysql&&/^[^\s#][^:]*:/.test(line)){inMysql=false;role=null}
    if(!inMysql)return line;
    const section=/^  (manager|player)\s*:/.exec(line);if(section){role=section[1];return line}
    if(!role||!/^    database\s*:/.test(line))return line;
    count++;return line.replace(/^(    database\s*:\s*)(["']?)[A-Za-z0-9_]+\2/,(_all,start,quote)=>start+quote+desired[role]+quote);
  }).join('');
  if(count!==2)throw Error('Expected exactly two database scalar lines');
  const parsed=yaml.load(next);
  for(const role of ['manager','player'])if(parsed.mysql[role].database!==desired[role])throw Error('Database replacement verification failed');
  const expected=structuredClone(old);expected.mysql.manager.database=desired.manager;expected.mysql.player.database=desired.player;
  if(JSON.stringify(expected)!==JSON.stringify(parsed))throw Error('Unrelated YAML data changed');
  return {content:next,before:{manager:old.mysql.manager.database,player:old.mysql.player.database},after:desired};
}

export function renameBackendDatabases(root,{apply=false}={}){
  root=fs.realpathSync(root);
  const changes=backendServices.map(service=>{
    const file=path.join(root,service,'config.yaml'),resolved=fs.realpathSync(file);
    if(path.relative(root,resolved).startsWith('..')||resolved.toLowerCase()!==file.toLowerCase())throw Error('Configuration path is outside reviewed backend');
    const original=fs.readFileSync(file),patch=databaseConfigPatch(original.toString('utf8'));
    return {file,service,original,content:Buffer.from(patch.content),before:patch.before,after:patch.after};
  }).filter(change=>!change.original.equals(change.content));
  const report={target:root,apply,changes:changes.map(({service,before,after})=>({file:service+'/config.yaml',before,after}))};
  if(!apply||!changes.length)return report;
  for(const change of changes)if(digest(fs.readFileSync(change.file))!==digest(change.original))throw Error('Configuration changed since review');
  const backup=path.join(root,'backups','database-names-'+new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(backup,{recursive:true});
  const written=[];
  try{
    for(const change of changes){
      const saved=path.join(backup,change.service,'config.yaml');fs.mkdirSync(path.dirname(saved),{recursive:true});fs.writeFileSync(saved,change.original);
      if(digest(fs.readFileSync(change.file))!==digest(change.original))throw Error('Concurrent configuration change; refusing overwrite');
      fs.writeFileSync(change.file,change.content);written.push(change);
    }
  }catch(error){for(const change of written.reverse())if(digest(fs.readFileSync(change.file))===digest(change.content))fs.writeFileSync(change.file,change.original);throw error}
  return {...report,backup};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=process.argv.find((value,index)=>index>=2&&!value.startsWith('--'))||'D:/project/gogames';
  try{console.log(JSON.stringify(renameBackendDatabases(root,{apply:process.argv.includes('--apply')}),null,2))}
  catch{console.error('Backend database configuration validation or write failed; credentials were not printed.');process.exitCode=1}
}
