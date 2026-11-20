// Only consume the trusted data-center projection. gp_game.gameType remains the
// legacy catalogue classification; projection.gameType is clientGameType.
const fail=message=>Object.assign(new Error(message),{code:'GAME_ROUTE_INVALID',status:503});
function positive(value,name){
  if(typeof value!=='number'&&!(typeof value==='string'&&/^\d+$/.test(value)))throw fail('Invalid '+name);
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<=0||number>0xffffffff)throw fail('Invalid '+name);
  return number;
}
export function createGameRouteIndex(rows){
  if(!Array.isArray(rows))throw fail('Game routes must be an array');
  const byPair=new Map(),byNumber=new Map(),symbols=new Set();
  for(const row of rows){
    const gameType=positive(row.gameType,'client gameType'),roomType=positive(row.roomType,'roomType');
    const number=positive(row.number,'gp_game.number'),key=gameType+':'+roomType;
    const symbol=typeof row.symbol==='string'?row.symbol.trim():'';
    if(!symbol)throw fail('Game route has no pool symbol');
    if(symbols.has(symbol))throw fail('Pool symbol is shared by multiple client routes: '+symbol);
    if(byPair.has(key))throw fail('Duplicate client gameType/roomType: '+key);
    if(byNumber.has(number))throw fail('Game number is shared by multiple client routes: '+number);
    const state=Number(row.state);
    if(![1,2].includes(state)||![0,1].includes(Number(row.isFrozen)))throw fail('Invalid game availability');
    const route=Object.freeze({gameType,roomType,number,symbol,state,isFrozen:Number(row.isFrozen)});
    byPair.set(key,route);byNumber.set(number,route);symbols.add(symbol);
  }
  return Object.freeze({
    resolve(gameType,roomType){
      const key=positive(gameType,'client gameType')+':'+positive(roomType,'roomType'),route=byPair.get(key);
      if(!route)throw Object.assign(new Error('Game route is not configured: '+key),{code:'GAME_ROUTE_MISSING',status:503});
      if(route.state!==1||route.isFrozen!==0)throw Object.assign(new Error('Game is under maintenance'),{code:'GAME_FROZEN',status:503});
      return route;
    },
    list(){return [...byPair.values()];},
  });
}

// Room configuration is supplied by data-center, never by the browser's body.
export function resolveRoomGameRoute(index,config){
  if(!index)return null;
  if(!config)throw fail('Trusted room configuration is missing');
  return index.resolve(config.game_type,config.room_type);
}

export function bindRoundGameRoute(round,index,config){
  if(!round||typeof round!=='object')throw fail('Round state is missing');
  if(round.financeGame){
    if(round.financeGame.gameType!==Number(config?.game_type)||round.financeGame.roomType!==Number(config?.room_type))
      throw fail('Existing round belongs to a different game');
    return round.financeGame;
  }
  const route=resolveRoomGameRoute(index,config);
  if(route)Object.defineProperty(round,'financeGame',{value:route,enumerable:true});
  return route;
}

export async function loadGameRoutes(runtime){
  if(runtime.env!=='prod'||!runtime.rpc)return null;
  if(typeof runtime.rpc.lobby?.listFinanceGames!=='function')throw fail('Data-center financial game catalogue is unavailable');
  return createGameRouteIndex(await runtime.rpc.lobby.listFinanceGames());
}
