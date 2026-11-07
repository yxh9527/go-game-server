import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gogame-user-center-'));
const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run',
  '--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1440,1000','about:blank',
],{windowsHide:true,stdio:'ignore'});
const failures=[],errors=[],api=[],pending=new Map();let socket,sequence=0;
const fixture=process.argv.includes('--settled-hand')?await(await import('../fixtures/user-center-browser.mjs')).settledUserCenter():null;
const origin=fixture?.origin||'http://lobby.localhost:11042';
const zjh=process.argv.includes('--zjh'),openHistory=fixture||process.argv.includes('--history');
const reportName=zjh?'zjh-user-center-browser':'user-center-browser';
try{
  let port;for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{}await delay(100);}
  assert.ok(port,'Chrome debugging port');
  const targets=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl.replace('localhost','127.0.0.1'));
  await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method));},20000);
    pending.set(id,m=>{clearTimeout(timer);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);});socket.send(JSON.stringify({id,method,params}));});
  socket.on('message',raw=>{const m=JSON.parse(raw);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}
    else if(m.method==='Network.responseReceived'){const r=m.params.response;if(r.status>=400)failures.push({url:r.url,status:r.status});if(r.url.includes('/internal/v1/do'))api.push({requestId:m.params.requestId});}
    else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);});
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result?.value;};
  const click=async text=>{const clicked=await evaluate(`(()=>{const el=Array.from(document.querySelectorAll('*')).filter(e=>e.textContent.trim()===${JSON.stringify(text)}).sort((a,b)=>a.querySelectorAll('*').length-b.querySelectorAll('*').length)[0];el?.click();return !!el;})()`);assert.ok(clicked,'button '+text);await delay(1500);};
  await Promise.all([send('Page.enable'),send('Runtime.enable'),send('Network.enable')]);
  if(zjh)await send('Emulation.setDeviceMetricsOverride',{width:590,height:910,deviceScaleFactor:1,mobile:false});
  const uid=fixture?.uid||process.env.USER_CENTER_UID||'10001',token=fixture?.token||'dev';
  await send('Page.navigate',{url:origin+'/21/0?userId='+uid+'&userToken='+token+'&openId='+uid+'&v=2.0.1279'});await delay(5000);
  await evaluate(`window.next.router.push('/user-center')`);await delay(2000);
  await click('战绩');await click(zjh?'传统金花':'德州扑克');
  const avatar=await evaluate(`(()=>{const img=document.querySelector('[class*=userCenter] [class*=avatar] img');return img?{src:img.getAttribute('src'),loaded:img.complete&&img.naturalWidth>0}:null;})()`);
  console.log('AVATAR',JSON.stringify(avatar));assert.ok(avatar?.loaded,'user-center avatar decodes');
  console.log('BATTLE_PAGE',await evaluate('document.body.innerText'));
  // Open a real room entry if this player has settled hands in the running dev server.
  const entry=await evaluate(`(()=>{const list=document.querySelector('[class*=recordList]');return list?.outerHTML||Array.from(document.querySelectorAll('[class*=record]')).map(e=>e.outerHTML.slice(0,250)).slice(-10);})()`);
  console.log('BATTLE_ENTRIES',JSON.stringify(entry));
  if(openHistory){
    assert.equal(await evaluate(`(()=>{const el=document.querySelector('[class^="record_list"] > ul > li > div');el?.click();return !!el;})()`),true,'real settled room entry');
    await delay(1600);
    console.log('ROOM_DETAIL',await evaluate('document.body.innerText'));
    await click('查看详情');
    console.log('HAND_DETAIL',await evaluate('document.body.innerText'));
    const cards=await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(zjh?'[class*=mahjongHandCard] img':'[class*=texasHandCard] img')})).map(img=>({src:img.getAttribute('src'),loaded:img.complete&&img.naturalWidth>0}))`);
    console.log('HAND_CARDS',JSON.stringify(cards));
    assert.ok(cards.length>=(zjh?6:2)&&cards.every(img=>img.loaded),'native hand card faces decode');
  }
  const shot=await send('Page.captureScreenshot');fs.writeFileSync('cache/'+reportName+'.png',Buffer.from(shot.data,'base64'));
  await click('资金明细');console.log('FUNDS_PAGE',await evaluate('document.body.innerText'));
  const responses=[];for(const item of api){try{const r=await send('Network.getResponseBody',{requestId:item.requestId});responses.push(JSON.parse(r.body));}catch{}}
  const report={localURL:origin+'/user-center',failures,errors,responses};
  fs.writeFileSync('cache/'+reportName+'.json',JSON.stringify(report,null,2));
  console.log('NETWORK',JSON.stringify({failures,scriptErrors:errors.length,report:'cache/'+reportName+'.json'}));
  assert.equal(errors.length,0,'native page has no JavaScript exceptions');
}finally{socket?.close();browser.kill();await fixture?.close();}
