import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createCollectibleEntryLoader} from '../../shared/hot-entry-factory.js';
import {createHotResolver} from '../../shared/hot-loader.js';

export function hallUserCenterFixture(){
  const cacheRoot=fileURLToPath(new URL('../../cache/',import.meta.url)),root=fs.mkdtempSync(path.join(cacheRoot,'hall-user-center-'));
  for(const name of ['hall/src','shared','game-server/src/core'])fs.mkdirSync(path.join(root,name),{recursive:true});
  fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
  const entry=path.join(root,'hall/src/user-center.js'),projection=path.join(root,'shared/user-center.js'),watch=path.join(root,'hall/src/projection-watch.js');
  let source=fs.readFileSync(new URL('../../hall/src/user-center.js',import.meta.url),'utf8');
  source=source.replace("from './rel.js'",'from '+JSON.stringify(new URL('../../shared/hot-import.js',import.meta.url).href))
    .replace("from '../../shared/hot-import.js'","from 'test:projection-loader'");
  fs.writeFileSync(entry,source);
  const watchSource=new URL('../../hall/src/projection-watch.js',import.meta.url);if(fs.existsSync(watchSource))fs.copyFileSync(watchSource,watch);
  fs.copyFileSync(new URL('../../shared/history-query.js',import.meta.url),path.join(root,'shared/history-query.js'));
  fs.writeFileSync(path.join(root,'hall/src/room-pool.js'),'export const requestRoomPool=()=>{throw Error("production query must use gateway")};');
  fs.writeFileSync(path.join(root,'game-server/src/core/member.js'),'export const userInfoOf=member=>({name:member.name,icon:member.icon});');
  const resolver=createHotResolver({directories:[root],residentFiles:[watch],mode:()=> 'test'});
  let loader,revision=0,reloadHook;
  const load=file=>{
    const url=pathToFileURL(file);url.searchParams.set('v','hall-fixture-'+path.basename(root)+'-'+(++revision));url.searchParams.set('link','2');url.searchParams.set('_hot_source','1');
    return loader.load(resolver.resolve(url.href,{},value=>({url:value})).url);
  };
  loader=createCollectibleEntryLoader({entries:[entry,projection],resolver,importModule:async location=>{
    if(location==='test:projection-loader')return {importHotModule:async()=>{const module=await load(projection);if(reloadHook)await reloadHook(module);return module;}};
    return import(location);
  }});
  const runtimes=new Set();
  return {root,entry,projection,source,loader,
    write(value){fs.writeFileSync(projection,'export const projectUserCenter=()=>({revision:'+value+'});');},
    load(){return load(entry);},
    onReload(hook){reloadHook=hook;},
    runtime(){const runtime={env:'prod',log:{error(){}},gateway:{authenticate:async()=>({success:true,userId:42}),getLoginData:async()=>({userId:42,agentId:7,currency:{symbol:'CNY'}}),getUserCenter:async()=>({records:[]})}};runtimes.add(runtime);return runtime;},
    params:{userId:42,token:'valid'},
    close(){for(const runtime of runtimes)runtime.userCenterProjection?.watcher?.close();fs.rmSync(root,{recursive:true,force:true});},
  };
}
