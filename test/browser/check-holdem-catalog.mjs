import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gogame-holdem-list-'));
const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run',
  '--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,
  '--window-size=1280,900','about:blank',
],{windowsHide:true,stdio:['ignore','ignore','pipe']});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let ws;
try{
  let port;for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{}await delay(100);}
  const target=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(t=>t.type==='page');
  ws=new WebSocket(target.webSocketDebuggerUrl.replace('localhost','127.0.0.1'));
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  let id=0;const pending=new Map(),errors=[];
  ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);});
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(new Error('CDP timeout '+method));},15000);
    pending.set(n,m=>{clearTimeout(timer);resolve(m);});ws.send(JSON.stringify({id:n,method,params}));
  });
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.ok(!r.result?.exceptionDetails,JSON.stringify(r.result?.exceptionDetails));return r.result?.result?.value;};
  await send('Page.enable');await send('Runtime.enable');
  const uid=88000695;
  await send('Page.navigate',{url:'http://lobby.localhost:11042/21/0?userId='+uid+'&userToken=dev-'+uid+'&openId='+uid+'&v=2.0.1279'});
  await delay(13000);
  console.log('NAVIGATION',JSON.stringify(await evaluate(`Array.from(document.querySelectorAll('span,p,div,a')).filter(e=>e.children.length===0&&/德州/.test(e.textContent)).map(e=>({text:e.textContent,href:e.closest('a')?.getAttribute('href')}))`)));
  for(const [show,expected] of [[true,13],[false,6]]){
    const clicked=await evaluate(`(()=>{const options=Array.from(document.querySelectorAll('*'));const labels=${JSON.stringify(show?['德州秀牌','德州','秀牌']:['德州不秀牌','不秀牌'])};for(const label of labels){const e=options.filter(e=>e.textContent.trim()===label).sort((a,b)=>a.querySelectorAll('*').length-b.querySelectorAll('*').length)[0];if(e){e.click();return label;}}return null;})()`);
    if(!clicked)console.log('NATIVE_TABS',JSON.stringify(await evaluate(`Array.from(document.querySelectorAll('*')).filter(e=>e.children.length<2&&/德州/.test(e.textContent)).map(e=>e.outerHTML.slice(0,1200))`)));
    assert.ok(clicked,'native holdem navigation exists');await delay(3500);
    const rooms=await evaluate(`Array.from(document.querySelectorAll('[class*=roomList] li')).map(e=>e.innerText)`);
    console.log(show?'SHOW_ROOMS':'NO_SHOW_ROOMS',JSON.stringify(rooms));
    assert.equal(rooms.length,expected);assert.ok(rooms.every(s=>!/undefined|NaN/.test(s)));
    const shot=await send('Page.captureScreenshot');fs.writeFileSync('test/browser/holdem-'+(show?'show':'no-show')+'-catalog.png',Buffer.from(shot.result.data,'base64'));
  }
  console.log('ERRORS',JSON.stringify(errors));assert.equal(errors.length,0);
}finally{ws?.close();browser.kill();}
