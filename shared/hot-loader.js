import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
import {env} from './rpc/env.js';

const projectRoot=fileURLToPath(new URL('../',import.meta.url));
const residentPaths=[
  'shared/hot-loader.js','shared/hot-import.js','shared/rpc/env.js','shared/rpc/index.js',
  'shared/rpc/utils/dataCenterGrpc.js','shared/rpc/utils/gogameStorageGrpc.js',
  'game-server/src/registry.js','game-server/src/rel.js','game-server/src/hot.js',
  'hall/src/rel.js','hall/src/hot.js','match/src/rel.js','match/src/hot.js',
].map(file=>path.resolve(projectRoot,file).toLowerCase());
const roots=['game-server/src','hall/src','client-web/src','match/src','shared','cache']
  .map(file=>path.resolve(projectRoot,file));
const under=(file,root)=>{const rel=path.relative(root,file);return rel===''||!rel.startsWith('..')&&!path.isAbsolute(rel);};

export function createHotResolver({directories=roots,residentFiles=residentPaths,mode=()=>env.isDev?'dev':'prod'}={}){
  const files=new Map(),versions=new Map(),recentTokens=new Map(),residents=new Set(residentFiles.map(f=>path.resolve(f).toLowerCase()));
  let fingerprintMode,epoch=0;
  function record(file){
    const previous=files.get(file);if(previous?.epoch===epoch)return previous;
    const stat=fs.statSync(file),stamp=stat.size+':'+stat.mtimeMs+':'+stat.ctimeMs;
    const cached=files.get(file);if(cached?.stamp===stamp){cached.epoch=epoch;return cached;}
    const source=fs.readFileSync(file,'utf8'),dependencies=[];
    for(const match of source.matchAll(/['"](\.{1,2}\/[^'"\r\n]+\.m?js)['"]/g)){
      const dependency=path.resolve(path.dirname(file),match[1]);
      if(dependency!==file&&directories.some(root=>under(dependency,root))&&fs.existsSync(dependency))dependencies.push(dependency);
    }
    const next={stamp,epoch,hash:createHash('sha256').update(source).digest('hex'),dependencies};
    if(files.size>=4096)files.clear();
    files.set(file,next);return next;
  }
  function version(file){
    if(versions.has(file))return versions.get(file);
    const visited=new Set(),pending=[file];
    while(pending.length){
      const next=pending.pop();if(visited.has(next))continue;visited.add(next);
      for(const dependency of record(next).dependencies)if(!residents.has(dependency.toLowerCase()))pending.push(dependency);
    }
    const hash=createHash('sha256').update(fingerprintMode);
    for(const dependency of [...visited].sort())hash.update(dependency).update(record(dependency).hash);
    const value='hot-'+hash.digest('hex').slice(0,24);versions.set(file,value);return value;
  }
  function invalidate(token){
    const currentMode=String(mode());
    if(fingerprintMode!==currentMode||token&&!token.startsWith('hot-')&&!recentTokens.has(token)){
      versions.clear();epoch++;fingerprintMode=currentMode;
      if(token){recentTokens.set(token,true);if(recentTokens.size>64)recentTokens.delete(recentTokens.keys().next().value);}
    }
  }
  return {
    resolve(specifier,context,nextResolve){
      const resolved=nextResolve(specifier,context);
      if(!resolved.url?.startsWith('file:'))return resolved;
      const url=new URL(resolved.url),file=fileURLToPath(url);
      if(!/\.m?js$/.test(file)||!directories.some(root=>under(file,root)))return resolved;
      const token=url.searchParams.get('v'),parent=context.parentURL&&new URL(context.parentURL);
      if(!token&&!parent?.searchParams.get('v'))return resolved;
      if(residents.has(file.toLowerCase())){
        url.searchParams.delete('v');url.searchParams.delete('_hot_source');return {...resolved,url:url.href};
      }
      const requestedSource=url.searchParams.has('_hot_source');url.searchParams.delete('_hot_source');
      // A previously linked canonical URL is immutable. Re-resolving it as
      // current disk content would change dependencies of an old running task.
      if(token?.startsWith('hot-')&&!requestedSource)return {...resolved,url:url.href};
      invalidate(token||parent?.searchParams.get('v'));
      url.searchParams.set('v',version(file));
      return {...resolved,url:url.href};
    },
    invalidate(){versions.clear();epoch++;},
    stats(){return {sourceFiles:files.size,versionEntries:versions.size,recentTokens:recentTokens.size};},
  };
}

const stateKey=Symbol.for('gogame.hot.content-resolver.v1');
export function installHotResolver(){
  if(!globalThis[stateKey]){
    const resolver=createHotResolver();
    globalThis[stateKey]={resolver,hook:registerHooks({resolve:resolver.resolve})};
  }
  return globalThis[stateKey].resolver;
}
