import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import express from 'express';
import {spawnSync} from 'node:child_process';
import {hallWebFixture} from '../fixtures/hot-hall-web.mjs';

function get(server,url){return new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:server.address().port,path:url,headers:{host:'lobby.localhost'}},res=>{let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));}).on('error',reject));}

test('hall web replacement serves new markup on the resident listener while old mounted requests remain valid',async()=>{
  const f=hallWebFixture(),runtime={config:{server_port:11042}},servers=[];
  let app;
  const server=http.createServer((req,res)=>app(req,res));
  try{
    const web=f.sources.find(item=>item.file.endsWith('web.js'));
    web.source=web.source.replace('.send(html);',".send(html+'<!--hot-web-'+hotTestRevision+'-->');");
    f.write(0);const old=await f.load('web.js',0),first=express();old.mountWeb(first,runtime);app=first;
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));servers.push(server);
    const url='/21/0?userId=42&userToken=token&openId=42&v=2.0.1279';
    const before=await get(server,url);assert.equal(before.status,200);assert.match(before.body,/<!--hot-web-0-->/);assert.equal(before.headers['cache-control'],'no-store');
    f.write(1);const next=await f.load('web.js',1),second=express();next.mountWeb(second,runtime);app=second;
    const after=await get(server,url);assert.equal(after.status,200);assert.match(after.body,/<!--hot-web-1-->/);
    app=first;assert.match((await get(server,url)).body,/<!--hot-web-0-->/);app=second;
    const redirect=await get(server,'/19/0?userId=42&userToken=token&openId=42&v=2.0.1279');assert.equal(redirect.status,302);assert.match(redirect.headers.location,/^\/21\/0\?/);
    const chunks=fs.readdirSync(new URL('../../static/hall/_next/static/chunks/',import.meta.url));
    const chunk=chunks.find(name=>/^434[.-][a-f0-9]+\.js$/.test(name));assert.ok(chunk);
    const bundle=await get(server,'/_next/static/chunks/'+chunk);assert.equal(bundle.status,200);assert.match(bundle.body,/silent:!0/);
    assert.equal(next.clientVersion(),'2.0.1279');assert.equal(old.clientVersion(),next.clientVersion());
  }finally{for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}f.close();}
});

test('web replacements preserve login parameters and distinct primary and hundred socket endpoints',async()=>{
  const f=hallWebFixture();
  try{
    f.write(0);const old=await f.load('web.js',0);f.write(1);const next=await f.load('web.js',1);
    for(const web of [old,next]){
      const url=new URL(web.withLoginQuery('/21/0?userId=42&userToken=original&openId=42','2.0.1279'),'http://lobby.localhost');
      assert.equal(url.searchParams.get('userToken'),'original');assert.equal(url.searchParams.get('openId'),'42');
      assert.equal(url.searchParams.get('v'),'2.0.1279');
      const req={headers:{host:'lobby.localhost:11042'}};
      assert.equal(web.publicWsHost(req,{},'dev'),'www.localhost:11042');assert.equal(web.publicHundredWsHost(req,{},'dev'),'hundred.localhost:11042');
      assert.equal(web.publicWsHost(req,{game_server:'game.example'},'prod'),'game.example');
    }
  }finally{f.close();}
});

test('released web namespaces, route closures and applications can be collected',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hot-hall-web.mjs','--hall-web-gc'],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_HALL_WEB_GC/);
});
