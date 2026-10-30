import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoomStatusView, hallCardImagePath } from '../hall/src/room-status-view.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chunks = path.join(root, 'static/hall/_next/static/chunks');
const shared = path.join(chunks, '434-da255fd00b51666b.js');
const begin = '/* GOGAME_ROOM_STATUS_START */', end = '/* GOGAME_ROOM_STATUS_END */';
const moduleSource = begin + '910038:(module,exports,require)=>{exports.RoomStatus=('
  + createRoomStatusView.toString() + ')(require(5868));exports.cardImagePath=('
  + hallCardImagePath.toString() + ');},' + end;
let source = fs.readFileSync(shared, 'utf8');
if (source.includes(begin)) {
  source = source.slice(0, source.indexOf(begin)) + moduleSource + source.slice(source.indexOf(end) + end.length);
} else {
  const anchor = '.push([[434],{';
  if (!source.includes(anchor)) throw new Error('Shared hall chunk changed');
  source = source.replace(anchor, anchor + moduleSource);
}
const interval = 'r=window.setInterval(n,5e3)';
const liveInterval = 'r=window.setInterval(n,[1000,1001,1002,1003].includes(t)?1e3:5e3)';
if (!source.includes(liveInterval)) {
  if (source.split(interval).length !== 2) throw new Error('Room polling layout changed');
  source = source.replace(interval, liveInterval);
}
fs.writeFileSync(shared, source);
for (const [file, requireName] of [
  ['553.bbe3bc413ea4869f.js', 't'], ['345.9de70229d91b0fcc.js', 'r'],
  ['194.814b8c8dec766fa3.js', 'r'], ['726.ed0f4d2a88a2c3e3.js', 'r'],
]) {
  const filename = path.join(chunks, file);
  let code = fs.readFileSync(filename, 'utf8');
  if (!code.includes('GogameRoomStatus')) {
    if (!code.includes('"use strict";')) throw new Error('Hall module changed: ' + file);
    code = code.replace('"use strict";', '"use strict";var GogameRoomStatus=' + requireName + '(910038).RoomStatus;');
    const anchor = /onClick:\(\)=>\(0,[a-z]\.OY\)\(([a-z])\),children:\[/g;
    const matches = [...code.matchAll(anchor)];
    if (matches.length !== 1) throw new Error('Room card changed: ' + file);
    const room = matches[0][1], jsx = file.startsWith('194.') ? 'l' : 'n';
    code = code.replace(anchor, match => match.replace('children:[', 'style:{position:"relative"},children:[(0,'
      + jsx + '.jsx)(GogameRoomStatus,{room:' + room + '}),'));
  }
  if (file.startsWith('345.') && !code.includes('52===e.roomType&&')) {
    const anchor = '60===e.roomType&&';
    if (code.split(anchor).length !== 2) throw new Error('Hundred card picture layout changed');
    const cards = '52===e.roomType&&((e)=>e?(0,n.jsx)("ul",{className:t().left52,children:["banker","a","b","c"].map(key=>(0,n.jsx)("li",{children:(e.showdownPokers?.[key]||[]).map((card,index)=>(0,n.jsx)("span",{children:(0,n.jsx)("img",{src:"/l01/img/cards/small/"+card+".webp"})},index))},key))}):null)(e.extendInfo),';
    code = code.replace(anchor, cards + anchor);
  }
  if (file.startsWith('345.')) {
    // Native records already use the blue back for -1. Public room cards must
    // use that same sentinel mapping rather than requesting a nonexistent -1.webp.
    if (!code.includes('var GogameCardImagePath=')) {
      code = code.replace('"use strict";', '"use strict";var GogameCardImagePath=' + requireName + '(910038).cardImagePath;');
    }
    code = code.replaceAll('src:"/l01/img/cards/small/".concat(e,".webp")', 'src:GogameCardImagePath(e)')
      .replaceAll('src:"/l01/img/cards/small/"+card+".webp"', 'src:GogameCardImagePath(card)');
    if ((code.match(/src:GogameCardImagePath\(/g) || []).length !== 4) {
      throw new Error('Hundred hall card image layout changed');
    }
  }
  // Keep the native title first in DOM/accessibility order. The badge remains
  // visually positioned at the corner and does not intercept room entry clicks.
  const firstBadge = /children:\[\(0,([nl])\.jsx\)\(GogameRoomStatus,\{room:([er])\}\),/;
  const badge = code.match(firstBadge);
  if (badge) {
    code = code.replace(firstBadge, 'children:[');
    const root = code.match(/onClick:\(\)=>\(0,[a-z]\.OY\)\([a-z]\),style:\{position:"relative"\},children:\[/);
    if (!root) throw new Error('Missing root room card');
    let depth = 1, quote = '', escaped = false, close = root.index + root[0].length;
    for (; close < code.length; close++) {
      const char = code[close];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '[') depth++;
      else if (char === ']' && --depth === 0) break;
    }
    if (depth !== 0) throw new Error('Unclosed root room card');
    code = code.slice(0, close) + ',(0,' + badge[1] + '.jsx)(GogameRoomStatus,{room:' + badge[2] + '})' + code.slice(close);
  }
  fs.writeFileSync(filename, code);
}
console.log('Shared status view installed in all four hundred hall lists.');
