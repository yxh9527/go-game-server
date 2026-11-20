import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import http from 'node:http';
import {parse} from 'acorn';
import {adminPage} from '../../match/src/admin-page.js';
import {createApp} from '../../match/src/create-app.js';
import {createMemoryStore} from '../../cache/rpc/store.js';
import {buildAdminIntegration} from '../../scripts/build-admin-integration.mjs';
import {applyAdminIntegration} from '../../scripts/apply-admin-integration.mjs';

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gogame-admin-menu-')),target=path.join(root,'target'),bundle=path.join(root,'bundle');
  const inputs={
    'NewAdminclient/src/router/routes.js':"import MainLayout from '@/layouts/MainLayout.vue';export default [{path:'/login',name:'login'},{path:'/',component:MainLayout,children:[{path:'old',name:'old',component:()=>import('@/views/old.vue')}]}];",
    'NewAdminclient/vue.config.js':"module.exports={devServer:{port:8088,proxy:{'/global':{target:'http://static.test'}}}};",
    'adminagent/src/router/routers.js':"import Main from '@/components/main';export default [{path:'/old',name:'old',component:Main}];",
    'adminagent/vue.config.js':"module.exports={devServer:{proxy:'http://api.test'},outputDir:'web-agent'};",
  };
  for(const [file,source]of Object.entries(inputs)){const destination=path.join(target,file);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,source);}
  return {root,target,bundle,inputs,close(){fs.rmSync(root,{recursive:true,force:true});}};
}

test('admin page API requests keep the browser proxy prefix for standalone and embedded paths',async()=>{
  for(const pathname of ['/admin','/admin/','/gogame-match/admin','/gogame-match/admin/']){
    const requests=[],source=adminPage.match(/<script>([\s\S]*?)<\/script>/)[1];
    // Execute the actual API function with the same top-level constants. UI
    // initialization below it is unrelated to URL resolution.
    const apiSource=source.slice(0,source.indexOf('async function run('));
    const context=vm.createContext({location:{pathname,search:'?token=must-not-leak'},document:{getElementById(id){return {value:id==='token'?'match-credential':id==='agent'?'12':''};}},
      AbortSignal,AbortController,setTimeout,clearTimeout,fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({code:0,data:{ok:true}})};}});
    await vm.runInContext(apiSource+"\napi('/matches','POST',{championship_name:'test'});",context);
    assert.equal(requests[0].url,pathname.replace(/\/+$/,'')+'/v1/matches');
    assert.equal(requests[0].options.headers['X-Admin-Token'],'match-credential');assert.equal(requests[0].options.headers['X-Agent-Id'],'12');
    assert.equal(requests[0].options.cache,'no-store');assert.ok(!requests[0].url.includes('token='));
  }
});

test('menu packaging retains routes/proxies, creates both frontend entries and applies with hash guards and backups',()=>{
  const f=fixture();
  try{
    const manifest=buildAdminIntegration({target:f.target,output:f.bundle});assert.equal(manifest.files.length,6);
    for(const [file,source]of Object.entries(f.inputs))assert.equal(fs.readFileSync(path.join(f.target,file),'utf8'),source);
    for(const entry of manifest.files){
      const text=fs.readFileSync(path.join(f.bundle,'files',entry.path),'utf8');
      if(entry.path.endsWith('.js'))parse(text,{ecmaVersion:'latest',sourceType:'module'});
      if(entry.path.includes('router/')){assert.match(text,/gogame-match/);assert.match(text,/match-management/);assert.match(text,/old/);}
      if(entry.path.endsWith('vue.config.js')){
        const context=vm.createContext({module:{exports:{}},process:{env:{}}});vm.runInContext(text,context);
        const proxy=context.module.exports.devServer.proxy;assert.equal(proxy['^/gogame-match'].target,'http://127.0.0.1:11040');
        assert.equal(proxy['^/gogame-match'].pathRewrite['^/gogame-match'],'');
        assert.equal(entry.path.startsWith('New')?proxy['/global'].target:proxy['/api'].target,entry.path.startsWith('New')?'http://static.test':'http://api.test');
      }
    }
    assert.deepEqual(applyAdminIntegration(f),{files:6,pending:6});
    const applied=applyAdminIntegration({...f,apply:true});assert.equal(applied.applied,6);
    assert.equal(applyAdminIntegration(f).pending,0);
    for(const [file,source]of Object.entries(f.inputs))assert.equal(fs.readFileSync(path.join(applied.backup,file),'utf8'),source);
    const route=path.join(f.target,'NewAdminclient/src/router/routes.js');fs.appendFileSync(route,'\n// concurrent edit');
    assert.throws(()=>applyAdminIntegration({...f,apply:true}),/Frontend changed/);
    assert.match(fs.readFileSync(route,'utf8'),/concurrent edit/);
  }finally{f.close();}
});

test('invalid frontend bundles are rejected before writes and partial write errors roll back original files',()=>{
  const f=fixture(),originalCopy=fs.copyFileSync;
  try{
    buildAdminIntegration({target:f.target,output:f.bundle});
    let writes=0;
    fs.copyFileSync=function(source,destination,...args){
      if(String(source).startsWith(path.join(f.bundle,'files'))&&++writes===2){fs.writeFileSync(destination,'partial');throw Error('simulated write failure');}
      return Reflect.apply(originalCopy,this,[source,destination,...args]);
    };
    assert.throws(()=>applyAdminIntegration({...f,apply:true}),/simulated write failure/);
    fs.copyFileSync=originalCopy;
    for(const [file,source]of Object.entries(f.inputs))assert.equal(fs.readFileSync(path.join(f.target,file),'utf8'),source);
    assert.equal(fs.existsSync(path.join(f.target,'NewAdminclient/src/views/gogame-match/MatchManagement.vue')),false);
    const manifestFile=path.join(f.bundle,'manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
    manifest.files[0].path='../outside.js';fs.writeFileSync(manifestFile,JSON.stringify(manifest));
    assert.throws(()=>applyAdminIntegration({...f,apply:true}),/Invalid frontend/);
    assert.equal(fs.existsSync(path.join(f.root,'outside.js')),false);
  }finally{fs.copyFileSync=originalCopy;f.close();}
});

test('embedded Vue component uses one fixed same-origin page and does not read or forward parent credentials',()=>{
  const source=fs.readFileSync(new URL('../../admin/integrations/MatchManagement.vue',import.meta.url),'utf8');
  assert.doesNotMatch(source,/localStorage|sessionStorage|postMessage|[?&]token=|getToken|\$store/);
  const script=source.match(/<script>([\s\S]*?)<\/script>/)[1].replace('export default','globalThis.component=');
  const context=vm.createContext({});vm.runInContext(script,context);
  const component=context.component,state=component.data();
  assert.equal(state.managementUrl,'/gogame-match/admin');assert.equal(state.loading,true);
  component.methods.loaded.call(state,{target:{contentDocument:{title:'比赛管理'}}});assert.equal(state.failed,false);
  component.methods.loaded.call(state,{target:{contentDocument:{title:'登录'}}});assert.equal(state.failed,true);
  component.methods.reload.call(state);assert.equal(state.loading,true);assert.equal(state.failed,false);assert.equal(state.frameKey,1);
  component.methods.failedToLoad.call(state);assert.equal(state.failed,true);
});

test('same-origin prefix proxy serves the actual admin page and preserves agent authorization for mutations',async t=>{
  const runtime={env:'dev',hotVersion:'admin-menu-proxy',config:{tournament_scheduler:false,admin_token:'platform',admin_agents:[{agent_id:12,token:'agent-12'}]},
    store:createMemoryStore(),log:{error(){}},bus:{publish:async()=>{}}};
  const app=await createApp(runtime),match=http.createServer(app);await new Promise(resolve=>match.listen(0,'127.0.0.1',resolve));
  const proxy=http.createServer((req,res)=>{
    if(!req.url.startsWith('/gogame-match/')){res.writeHead(404);res.end();return;}
    const upstream=http.request({hostname:'127.0.0.1',port:match.address().port,path:req.url.slice('/gogame-match'.length),method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
    upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{clearInterval(runtime.tournamentIdempotency?.timer);for(const server of [proxy,match])await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});});
  const base='http://127.0.0.1:'+proxy.address().port+'/gogame-match/admin';
  const page=await fetch(base);assert.equal(page.status,200);assert.match(await page.text(),/比赛管理/);
  assert.equal((await fetch(base+'/v1/matches',{headers:{'X-Admin-Token':'bad'}})).status,403);
  const response=await fetch(base+'/v1/matches',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Token':'agent-12'},body:JSON.stringify({championship_name:'proxy draft',init_point:10000,min_player:2,state:0,small_blind:5,big_blind:10})});
  const created=await response.json();assert.equal(created.code,0);assert.equal(created.data.agent_id,12);
  assert.equal((await fetch(base+'/v1/matches?agent_id=13',{headers:{'X-Admin-Token':'agent-12'}})).status,403);
});
