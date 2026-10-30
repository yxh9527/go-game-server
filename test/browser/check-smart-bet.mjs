import assert from 'node:assert/strict';

// Called by check-baccarat.mjs with SMART_BET_ONLY=1; also supports CARD_GAME=dragon-tiger.
export async function checkSmartBet({ ev, until, delay, roomType }) {
  const data = "__require('smart_data').default";
  const main = data + '.getSmartMain()';
  const button = "(()=>{const seen=new Set();function find(n){if(!n||seen.has(n))return null;seen.add(n);const c=n.getComponent?.('smart_btn');if(c&&c.node.activeInHierarchy&&c.gameId===" + roomType + ")return c;for(const ch of n.children||[]){const r=find(ch);if(r)return r;}return null;}for(const root of [cc.director.getScene(),...Object.values(cc.game._persistRootNodes)]){const c=find(root);if(c)return c;}return null;})()";
  assert.ok(await ev('Boolean(' + button + ')'), 'native smart betting button');
  await ev('(' + button + ').onClick();true');
  await until(async () => await ev('Boolean(' + main + '?.panel_main.view0.node.activeInHierarchy&&' + data + '.getSmartList()?.overview)'), 10000, 'native smart overview response');
  const readMarket = () => ev('(()=>{const p=' + main + '.panel_main.view0;return {count:p.count.string,amount:p.amount.string,items:p.content.children.length,data:' + data + '.getSmartList()};})()');
  const market = await readMarket();
  assert.equal(market.count, '0');
  assert.equal(Number(market.amount), 0);
  assert.equal(market.items, 0);
  assert.deepEqual(market.data, { overview: { participantCount: 0, participantAmount: 0 }, marketList: [] });
  // Use the same menu handler as the shipped UI; responses travel through native XHR.
  await ev(main + '.panel_main.onClickMenu({target:' + main + '.panel_main.menus.children[1]});true');
  await until(async () => await ev(main + '.panel_main.view1.node.activeInHierarchy'), 5000, 'personal task tab');
  await delay(600);
  assert.deepEqual(await ev(data + '.getMyList()'), []);
  await ev(main + '.panel_main.onClickMenu({target:' + main + '.panel_main.menus.children[0]});true');
  await until(async () => await ev(main + '.panel_main.view0.node.activeInHierarchy'), 5000, 'return to smart market');
  await delay(600);
  assert.equal((await readMarket()).count, '0');
  await ev(main + '.hide();true');
  await ev('(' + button + ').onClick();true');
  await until(async () => await ev(main + '.panel_main.view0.node.activeInHierarchy'), 5000, 'reopen smart panel');
  await delay(600);
  assert.equal((await readMarket()).items, 0);
  await ev(main + '.hide();true');
  console.log('PASS_NATIVE_SMART_BET', JSON.stringify({ roomType, market }));
}
