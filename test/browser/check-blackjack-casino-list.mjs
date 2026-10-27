import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gogame-blackjack-list-'));
const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run',
  '--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,
  '--window-size=1280,900','about:blank',
],{windowsHide:true,stdio:['ignore','ignore','pipe']});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let ws;
try{
  let port;for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{}await delay(100);}
  const target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page');
  ws=new WebSocket(target.webSocketDebuggerUrl.replace('localhost','127.0.0.1'));
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  let id=0;const pending=new Map();
  ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}});
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(new Error('CDP timeout '+method));},15000);
    pending.set(n,m=>{clearTimeout(timer);resolve(m);});ws.send(JSON.stringify({id:n,method,params}));
  });
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.ok(!r.result?.exceptionDetails,JSON.stringify(r.result?.exceptionDetails));return r.result?.result?.value;};
  await send('Page.enable');await send('Runtime.enable');
  const uid=88000690;
  await send('Page.navigate',{url:`http://lobby.localhost:11042/21/0?userId=${uid}&userToken=dev-${uid}&openId=${uid}&v=2.0.1279`});
  await delay(13000);
  await evaluate(`Array.from(document.querySelectorAll('span,p,div,a')).find(e=>e.textContent==='二十一点'&&e.children.length===0)?.click()`);
  await delay(3000);
  const rooms=await evaluate(`Array.from(document.querySelectorAll('[class*=roomList] li')).map(e=>e.innerText)`);
  console.log('BLACKJACK_ROOMS',JSON.stringify(rooms));
  assert.equal(rooms.length,5,'four ordinary tiers plus casino mode');
  assert.equal(rooms.filter(text=>text.includes('/')).length,4,'four ordinary bet/carry cards');
  assert.equal(rooms.filter(text=>!text.includes('/')).length,1,'native casino card has its own display');
  console.log('CASINO_CARD',await evaluate(`document.querySelector('[class*=roomList] li').outerHTML`));
  const shot=await send('Page.captureScreenshot');
  fs.writeFileSync('test/browser/blackjack-casino-list.png',Buffer.from(shot.result.data,'base64'));
}finally{ws?.close();browser.kill();}
