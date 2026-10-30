import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gogame-hundred-hall-'));
const browser = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new','--no-sandbox','--disable-gpu','--disable-extensions','--no-first-run',
  '--remote-debugging-port=0','--user-data-dir=' + profile,'--window-size=1280,900','about:blank',
], { windowsHide: true, stdio: ['ignore','ignore','pipe'] });
let socket, id = 0;
const pending = new Map(), errors = [], requests = [];
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; }
    catch { await delay(100); }
  }
  const target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(row => row.type === 'page');
  socket = new WebSocket(target.webSocketDebuggerUrl.replace('localhost','127.0.0.1'));
  await new Promise((resolve,reject) => { socket.once('open',resolve); socket.once('error',reject); });
  const send = (method, params = {}) => new Promise((resolve,reject) => {
    const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(new Error('CDP timeout ' + method)); },15000);
    pending.set(n, message => { clearTimeout(timer); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); });
    socket.send(JSON.stringify({ id: n, method, params }));
  });
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Network.requestWillBeSent' && message.params.request.url.includes('op=38')) requests.push(message.params.request.url);
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.ok(!result.exceptionDetails,JSON.stringify(result.exceptionDetails)); return result.result?.value;
  };
  const until = async (check, description, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await check()) return; await delay(250); }
    throw new Error('timeout: ' + description);
  };
  await Promise.all([send('Page.enable'),send('Runtime.enable'),send('Network.enable')]);
  await send('Page.navigate', { url: 'http://lobby.localhost:11042/21/0?userId=10001&userToken=dev&openId=10001&v=2.0.1279' });
  await until(() => evaluate('!!document.querySelector(\'img[src*="category/02.webp"]\')'), 'hundred category');
  await delay(6000);
  await evaluate('document.querySelector(\'img[src*="category/02.webp"]\').parentElement.click()');
  await until(() => evaluate('!!document.querySelector(\'img[src*="types/1001.png"]\')'), 'arcade menu');
  await evaluate('document.querySelector(\'img[src*="types/1001.png"]\').parentElement.click()');
  await until(() => evaluate('document.querySelectorAll("[data-room-status]").length === 5'), 'five arcade status badges');
  const badges = () => evaluate('Array.from(document.querySelectorAll("[data-room-status]")).map(el=>({id:el.dataset.roomStatus,state:el.dataset.gameStatus,text:el.textContent,title:el.parentElement.querySelector("h3")?.textContent}))');
  const seen = new Set(), samples = [];
  for (let i = 0; i < 16; i++) {
    const current = await badges(); samples.push(current);
    for (const badge of current) { seen.add(badge.state); assert.ok(!/NaN|undefined/.test(badge.text)); }
    if (seen.has('2') && seen.has('6') && i >= 3) break;
    await delay(2000);
  }
  console.log('ARCADE_STATES',JSON.stringify(samples));
  assert.ok(seen.has('2') && seen.has('6'), 'real betting and settlement visible');
  assert.equal(await evaluate('document.querySelectorAll("[class*=arcada_outer] i").length'),120);
  assert.equal(await evaluate('document.querySelectorAll("[class*=arcada_inner] i").length'),120);
  assert.ok(requests.length >= 3, 'native list keeps polling public snapshots');
  const screenshot = path.join(os.tmpdir(), 'gogame-hundred-lobby-status.png');
  fs.writeFileSync(screenshot, Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  console.log('SCREENSHOT',screenshot);
  for (const type of [1000,1002]) {
    await evaluate('document.querySelector(\'img[src*="types/' + type + '.png"]\').parentElement.click()');
    await until(() => evaluate('document.querySelectorAll("[data-room-status]").length > 0 && !document.querySelector("[class*=roomListArcada]")'), 'hundred list ' + type);
    console.log('LIST',type,JSON.stringify(await badges()));
  }
  assert.deepEqual(errors,[]);
  console.log('PASS_HUNDRED_LOBBY',JSON.stringify({states:[...seen],requests:requests.length,errors:errors.length}));
} finally {
  socket?.close(); browser.kill();
}
