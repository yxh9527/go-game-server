import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { hallCardAssets, hallRoomTileAssets } from '../../scripts/sync-hall-card-assets.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gogame-hall-images-'));
const browser = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=1280,900', 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
const failures = [], errors = [], pending = new Map();
let socket, sequence = 0;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; }
    catch { await delay(100); }
  }
  assert.ok(port, 'Chrome debugging port');
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl.replace('localhost', '127.0.0.1'));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 25000);
    pending.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); });
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
    else if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) {
      failures.push({ url: message.params.response.url, status: message.params.response.status });
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result?.value;
  };
  await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Network.enable')]);
  await send('Page.navigate', { url: 'http://lobby.localhost:11042/21/0?userId=88131000&userToken=dev-88131000&openId=88131000&v=2.0.1279' });
  await delay(6500);
  const paths = [...hallCardAssets.map(name => 'cards/small/' + name), ...hallRoomTileAssets,
    'room/type/1003/characters/301.png'].map(name => '/l01/img/' + name);
  const decoded = await evaluate('(async()=>{const paths=' + JSON.stringify(paths) + ';return await Promise.all(paths.map(async file=>{try{'
    + 'const img=new Image();img.src=file;await img.decode();return {file,width:img.naturalWidth,height:img.naturalHeight}'
    + '}catch(e){return {file,error:e.message}}}))})()');
  assert.equal(decoded.length, 85);
  assert.ok(decoded.every(image => image.width > 0 && image.height > 0), JSON.stringify(decoded.filter(image => image.error)));
  console.log('PASS_IMAGE_DECODE', JSON.stringify({ checked: decoded.length, mahjong: decoded.filter(image => image.file.includes('/62/')) }));
  await evaluate('(' + (() => { document.querySelector('img[src*="category/02.webp"]').parentElement.click(); return true; }).toString() + ')()');
  await delay(1500);
  await evaluate('(' + (() => { document.querySelector('img[src*="types/1000.png"]').parentElement.click(); return true; }).toString() + ')()');
  let rooms = 0;
  for (let i = 0; i < 50; i++) {
    rooms = await evaluate('document.querySelectorAll("[data-room-status]").length');
    if (rooms) break; await delay(300);
  }
  assert.ok(rooms > 0, 'native hundred hall rooms');
  await delay(2500);
  const relevantFailures = failures.filter(failure => paths.includes(new URL(failure.url).pathname));
  assert.deepEqual(relevantFailures, []); assert.deepEqual(errors, []);
  const screenshot = path.join(os.tmpdir(), 'gogame-hall-images-final.png'), shot = await send('Page.captureScreenshot');
  fs.writeFileSync(screenshot, Buffer.from(shot.data, 'base64'));
  console.log('PASS_NATIVE_HALL', JSON.stringify({ rooms, relevant404: relevantFailures.length, scriptErrors: errors.length,
    otherFailures: failures.length, screenshot }));
} finally { socket?.close(); browser.kill(); }
