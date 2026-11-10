import test from 'node:test';
import assert from 'node:assert/strict';
import {walletOperation} from '../../../game-server/src/wallet/operations.js';
import {createBairenEngine} from '../../../game-server/src/core/bairen-engine.js';

test('hundred payouts keep duplicate protection on the existing hand instead of permanent string-key receipts',async()=>{
  const owner={},session={userId:42,agentId:7,wallet:1000},credits=[];
  const engine=createBairenEngine({areaIds:[1],createHand:()=>({winningAreas:[1],tieAreas:[]}),
    outcome:()=>({winningAreas:[1],tieAreas:[],lostAreas:[]}),resultCards:()=>({}),showdownTypes:()=>({}),
    updateRoads(){},roadSnapshot:()=>[],visibleCards:()=>({}),emptyCards:()=>({})});
  const table={agentId:7,roomId:500000,roomType:50,inning:1,config:{},rules:{betAreaOdds:{1:1}},
    playerSessions:new Map([[42,session]]),playerBets:new Map([[42,[{areaId:1,total:100}]]]),visitors:new Set([42]),
    hand:{winningAreas:[1],tieAreas:[]}};
  const ctx={table,io:{broadcast(){},sendUser(){},forEachPlayer(){}},runtime:{wallet:{
    credit(s,amount,meta){credits.push(meta);return walletOperation(owner,s,amount,'credit',meta,()=>{s.wallet+=amount;return {ok:true};});},
  }}};
  await engine.settleRound(ctx);await engine.settleRound(ctx);
  assert.equal(credits.length,1);assert.equal(session.wallet,1200);
  assert.equal(credits[0].operation,table.hand);
  assert.equal(owner[Symbol.for('gogame.wallet.operations')].keys.size,0,'settling each hand must not grow the global receipt key map');
});
