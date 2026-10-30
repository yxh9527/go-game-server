import assert from 'node:assert/strict';

// Reuse the shipped card's chip, area and confirmation handlers. Never inject a betting packet.
export async function checkCrossGameShortcuts({ ev, frames, until, delay, roomType, screenshot }) {
  const helper = "__require('BairenMultyBetHelper').default";
  const readBalance = () => ev(roomType===58
    ? "Math.round(__require('Facade').default.getModule('BlackJack').gameViewModel.model.__currentBalanceCNY*100)"
    : "__require('BairenHelper').default.vm.model.__currentBalance");
  const panel = "(()=>{const seen=new Set();function find(n){if(!n||seen.has(n))return null;seen.add(n);const c=(n._components||[]).find(c=>Array.isArray(c._roomItemCmps));if(c)return c;for(const ch of n.children||[]){const r=find(ch);if(r)return r;}return null;}for(const root of [cc.director.getScene(),...Object.values(cc.game._persistRootNodes)]){const r=find(root);if(r)return r;}return null;})()";
  assert.deepEqual(await ev(helper + '.module.multyRoomTypes'), [roomType]);
  const inspect = () => ev('(()=>{const p=' + panel + ';return p&&{active:p.node.activeInHierarchy,rooms:p._roomItemCmps.map(c=>({roomId:c.roomId,roomType:c.roomType,state:c.currentGameState,active:c.node.activeInHierarchy,odds:Array.from(c.areaOddsLbMap||[]).map(([id,l])=>[id,l.string]),confirmed:Array.from(c.confirmedBetMap||[]),data:{inning:c.data.inning}}))};})()');
  console.log('SHORTCUT_INITIAL', JSON.stringify(await inspect()));
  await until(async () => (await inspect())?.rooms.some(r=>r.roomType===roomType), 12000, 'native cross-game shortcut cards');
  let view = await inspect();
  if (!view.active) {
    // Same public show handler used by the native expand/collapse control.
    await ev('(()=>{const p=' + panel + ';p.show(true);return true;})()');
  }
  await until(async () => (await inspect())?.active, 5000, 'shortcut panel visible');
  await until(async () => (await inspect())?.rooms.some(r=>r.active&&r.state===2), 60000, 'shortcut betting opens');
  view = await inspect();
  const room = view.rooms.find(r=>r.active&&r.state===2);
  const roomId = room.roomId;
  assert.ok(room.odds.length > 0);
  assert.ok(room.odds.every(([,s])=>!s.includes('undefined')&&!s.includes('NaN')), JSON.stringify(room));
  const start = frames.length;
  const click = await ev('(()=>{const p=' + panel + ';const c=p.getRoomItemCmp(' + roomId + ');const ids=Array.from(c.areaOddsLbMap).filter(([id,l])=>Number(l.string.split(":")[1])>0).map(([id])=>id);' + helper + '.vm.setCurrentChipValue(1);const id=ids[0];c.onClickArea(null,String(id));const staged=Array.from(c.unconfirmedBetMap);if(staged.length)c.onClickConfirmBet();return {staged,id};})()');
  assert.ok(click.staged.length > 0, 'native area click stages a chip');
  await until(()=>frames.slice(start).some(f=>f.direction==='receive'&&f.msgid===6226&&f.payload.roomId===roomId),5000,'shortcut bet receipt');
  const bet=frames.slice(start).find(f=>f.direction==='receive'&&f.msgid===6226&&f.payload.roomId===roomId).payload;
  const request=frames.slice(start).find(f=>f.direction==='send'&&f.msgid===6125&&f.payload.roomId===roomId).payload;
  assert.equal(request.roomType,roomType);assert.equal(request.customData,undefined);
  assert.equal(bet.code,0,JSON.stringify(bet));assert.equal(bet.customData,2);
  await until(async()=>await readBalance()===bet.points,5000,'main display reflects shortcut debit');
  await until(()=>ev(helper+'.vm.__usertBalancePoints==='+bet.points),5000,'shortcut available balance reflects debit');
  await until(async()=> (await inspect())?.rooms.find(r=>r.roomId===roomId)?.confirmed.length>0,5000,'shortcut confirmed chip renders');
  await delay(700); if(screenshot)await screenshot('bet');
  await until(()=>frames.slice(start).some(f=>f.msgid===6229&&f.payload.roomId===roomId&&f.payload.customData===2),65000,'shortcut personal settlement');
  const result=frames.slice(start).find(f=>f.msgid===6229&&f.payload.roomId===roomId&&f.payload.customData===2).payload;
  const stake=request.params.reduce((n,b)=>n+b.total,0);
  assert.equal(result.points,bet.points+stake+result.realScore);
  assert.ok(Number.isFinite(result.realScore));
  await until(async()=>await readBalance()===result.points,5000,'main display reflects shortcut payout');
  await until(()=>ev(helper+'.vm.__usertBalancePoints==='+result.points),5000,'shortcut available balance reflects payout');
  assert.equal(frames.slice(start).some(f=>[6204,6208,6212].includes(f.msgid)&&f.payload.roomId===roomId),false,'shortcut cannot replace selected main-table state');
  await delay(700); if(screenshot)await screenshot('settlement');
  const settledUI=await ev('(()=>{const c=(' + panel + ').getRoomItemCmp(' + roomId + ');return {state:c.currentGameState,settle:c.settleResultPanel?.active,score:c.scoreTip?.string,confirmed:Array.from(c.confirmedBetMap)};})()');
  console.log('SHORTCUT_SETTLEMENT',JSON.stringify({roomType,roomId,request,bet,result,ui:settledUI}));
  await until(()=>frames.slice(start).some(f=>f.msgid===6228&&f.payload.roomId===roomId&&f.payload.inning>result.inning&&f.payload.state===2),65000,'shortcut next round');
  assert.deepEqual((await inspect()).rooms.find(r=>r.roomId===roomId).confirmed,[],'new round automatically clears the previous confirmed chips');
  await ev(helper+'.vm.sendRegRoomsReq();true');
  await until(async()=> (await inspect())?.rooms.some(r=>r.roomId===roomId&&r.data.inning>result.inning),5000,'shortcut re-registration restores new round');
  console.log('SHORTCUT_PASS',JSON.stringify({roomType,roomId,view:await inspect()}));
}
