import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
import {env} from './rpc/env.js';

const projectRoot=fileURLToPath(new URL('../',import.meta.url));
const residentPaths=[
  'shared/hot-loader.js','shared/hot-import.js','shared/rpc/env.js','shared/rpc/index.js',
  'shared/hot-source-pins.js','shared/hot-entry-factory.js',
  'shared/tournament-dedup-timer.js',
  'shared/session-revocation-listener.js',
  'shared/rpc/utils/dataCenterGrpc.js','shared/rpc/utils/gogameStorageGrpc.js',
  'shared/rpc/utils/lotteryGrpc.js',
  'shared/rpc/implementations/prod/prodDeps.js',
  'game-server/src/registry.js','game-server/src/rel.js','game-server/src/hot.js',
  'hall/src/rel.js','hall/src/hot.js','hall/src/projection-watch.js','match/src/rel.js','match/src/hot.js',
  'match/src/scheduler-loop.js',
  // These modules own startup listeners, registry/lease state or a singleton
  // transport. Business factories may use their owners, never fork them.
  'shared/resident-tick.js','shared/rpc/cash-carry-store.js','shared/rpc/game-session-store.js',
  'shared/rpc/implementations/prod/busRpcProd.js',
  'game-server/src/boot.js','hall/src/boot.js','match/src/boot.js','client-web/src/boot.js',
  'hall/src/game-proxy.js','hall/src/static-proxy.js','hall/src/store.js',
].map(file=>path.resolve(projectRoot,file).toLowerCase());
export const residentModuleFiles=Object.freeze(residentPaths);
const roots=['game-server/src','hall/src','client-web/src','match/src','shared','cache']
  .map(file=>path.resolve(projectRoot,file));
const under=(file,root)=>{const rel=path.relative(root,file);return rel===''||!rel.startsWith('..')&&!path.isAbsolute(rel);};

export function createHotResolver({directories=roots,residentFiles=residentPaths,mode=()=>env.isDev?'dev':'prod'}={}){
  const files=new Map(),versions=new Map(),recentTokens=new Map(),presence=new Map(),residents=new Set(residentFiles.map(f=>path.resolve(f).toLowerCase()));
  const MAX_PRESENCE_ENTRIES=4096;
  let fingerprintMode,epoch=0;
  function advanceEpoch(){versions.clear();presence.clear();epoch++;}
  function present(file){
    if(presence.has(file))return presence.get(file);
    const exists=fs.existsSync(file);
    if(presence.size>=MAX_PRESENCE_ENTRIES)presence.clear();
    presence.set(file,exists);return exists;
  }
  function record(file){
    const previous=files.get(file);if(previous?.epoch===epoch)return previous;
    // A new reload epoch must check content, even if an equal-size edit has
    // the same coarse filesystem timestamps. Reuse dependency parsing only
    // after hashing the source; each file is read once within an epoch.
    const source=fs.readFileSync(file,'utf8'),hash=createHash('sha256').update(source).digest('hex');
    if(previous?.hash===hash){previous.epoch=epoch;return previous;}
    const dependencies=new Set();
    for(const match of source.matchAll(/['"](\.{1,2}\/[^'"\r\n]+\.m?js)['"]/g)){
      const dependency=path.resolve(path.dirname(file),match[1]);
      if(dependency!==file&&directories.some(root=>under(dependency,root)))dependencies.add(dependency);
    }
    const next={epoch,hash,dependencies:[...dependencies]};
    if(files.size>=4096)files.clear();
    files.set(file,next);return next;
  }
  function version(file){
    if(versions.has(file))return versions.get(file);
    const visited=new Set(),pending=[file];
    while(pending.length){
      const next=pending.pop();if(visited.has(next))continue;visited.add(next);
      for(const dependency of record(next).dependencies)if(!residents.has(dependency.toLowerCase())&&present(dependency))pending.push(dependency);
    }
    const hash=createHash('sha256').update(fingerprintMode);
    for(const dependency of [...visited].sort())hash.update(dependency).update(record(dependency).hash);
    const value='hot-'+hash.digest('hex').slice(0,24);versions.set(file,value);return value;
  }
  function invalidate(token){
    const currentMode=String(mode());
    if(fingerprintMode!==currentMode||token&&!token.startsWith('hot-')&&!recentTokens.has(token)){
      advanceEpoch();fingerprintMode=currentMode;
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
      if(residents.has(file.toLowerCase())){
        url.searchParams.delete('v');url.searchParams.delete('_hot_source');url.searchParams.delete('link');return {...resolved,url:url.href};
      }
      if(!token&&!parent?.searchParams.get('v'))return resolved;
      const requestedSource=url.searchParams.has('_hot_source');url.searchParams.delete('_hot_source');
      // A previously linked canonical URL is immutable. Re-resolving it as
      // current disk content would change dependencies of an old running task.
      if(token?.startsWith('hot-')&&!requestedSource)return {...resolved,url:url.href};
      invalidate(token||parent?.searchParams.get('v'));
      url.searchParams.set('v',version(file));
      return {...resolved,url:url.href};
    },
    readSource(location){
      const url=new URL(location),file=fileURLToPath(url),requested=url.searchParams.get('v');
      if(!requested?.startsWith('hot-')||!directories.some(root=>under(file,root))||residents.has(file.toLowerCase())){
        throw TypeError('Expected a versioned hot business source');
      }
      // A weak namespace may already have been collected, or a deployment may
      // have edited this graph after resolution. Never compile today's source
      // under an old graph's URL. Already loaded namespaces bypass this read.
      advanceEpoch();fingerprintMode=String(mode());
      const current=version(file),expectedHash=record(file).hash;
      const source=fs.readFileSync(file,'utf8');
      if(current!==requested||createHash('sha256').update(source).digest('hex')!==expectedHash){
        const error=new Error('Hot source changed before module evaluation');
        error.code='ERR_HOT_SOURCE_CHANGED';throw error;
      }
      return source;
    },
    invalidate(){advanceEpoch();},
    stats(){return {sourceFiles:files.size,versionEntries:versions.size,recentTokens:recentTokens.size,presenceEntries:presence.size,maxPresenceEntries:MAX_PRESENCE_ENTRIES};},
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
