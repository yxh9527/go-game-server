// Read-only cross-repository audit. Local HTTP dependencies are explicit stubs;
// no real login, wallet, Redis, SQL or ES mutation is performed.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {loadGames} from '../../game-server/src/games/catalog.js';
import {seedRooms} from '../../cache/rpc/seed.js';
import {withLoginQuery} from '../../hall/src/web.js';
import {createApp} from '../../hall/src/create-app.js';
import {createMatchStore,createRoomStore} from '../../hall/src/store.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const backend=path.resolve(process.argv[2]||'D:/project/gogames');
const games=await loadGames('player-flow-audit'),rows=seedRooms();
const token='SESSION@audit-placeholder';
const redirected=new URL(withLoginQuery('/21/0?'+new URLSearchParams({userId:'42',token,gamecode:'audit'}),'2.0.1279'),'http://audit');
const calls=[];
const app=await createApp({env:'prod',hotVersion:'audit',config:{},log:{error(){}},
  roomStore:createRoomStore(),matchStore:createMatchStore(),
  gateway:{authenticate:async()=>{calls.push('authenticate');return {success:false};}},
  rpc:{lobby:{listFinanceGames:async()=>[],listAwards:async()=>[],listBlinds:async()=>[],countUnusedTickets:async uid=>{calls.push({tickets:uid});return 3;}},
    common:{getBalance:async uid=>{calls.push({balance:uid});return 12345;}}}});
const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let walletResult;
try{const response=await fetch('http://127.0.0.1:'+server.address().port+'/internal/v1/do?op=54&userId=42');walletResult={status:response.status,body:await response.json(),calls};}
finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
const seeds=fs.readFileSync(path.join(backend,'app/tables/gogame/seed.go'),'utf8');
const report={date:'2026-11-21',scope:'source inspection and local stubbed HTTP; no live infrastructure',
  loginHandoff:{expectedUserToken:token,actualUserToken:redirected.searchParams.get('userToken'),confirmedMismatch:redirected.searchParams.get('userToken')!==token},
  unauthenticatedWalletQuery:walletResult,
  gameMatrix:games.list.map(game=>({id:game.id,kind:game.kind,roomTypes:game.roomTypes,devConfigCount:rows.filter(row=>game.roomTypes.includes(Number(row.room_type))).length})),
  missingSeedRegistrations:['Niuniu','Sss','Blackjack','Mahjong'].filter(name=>!seeds.includes('seed'+name+'IfMissing(m, now)'))};
const output=path.join(root,'cache/player-flow-audit-2026-11-21-evidence.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,loginMismatch:report.loginHandoff.confirmedMismatch,walletResponse:walletResult.body,authCalled:calls.includes('authenticate'),games:report.gameMatrix.length,missingSeeds:report.missingSeedRegistrations}));
