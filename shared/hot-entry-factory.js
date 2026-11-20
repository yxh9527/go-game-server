import path from 'node:path';
import {compileFunction} from 'node:vm';
import {fileURLToPath} from 'node:url';
import {parse} from 'acorn';
import {installHotResolver} from './hot-loader.js';
import {planHotSourcePins,applySourceEdits} from './hot-source-pins.js';

const root=fileURLToPath(new URL('../',import.meta.url));
export const collectibleEntryFiles=Object.freeze(['game-server/src/create-handler.js','hall/src/create-app.js','match/src/create-app.js'].map(file=>path.join(root,file)));
// Reviewed dependencies contain functions/constants or markup, with no room,
// wallet, socket, timer or other resident state created at module evaluation.
export const collectibleDependencyFiles=Object.freeze([
  'game-server/src/codec.js','hall/src/decode.js','hall/src/to-client.js',
  'match/src/admin-page.js','match/src/admin-forms.js',
].map(file=>path.join(root,file)));
// Explicitly reviewed game wrappers.
// The five arcade wrappers construct a game instance;
// unchanged wrappers must reuse it rather than instantiate per request.
export const collectibleGameEntryFiles=Object.freeze([
  'catalog.js',...[
    'holdem','baccarat','dragon-tiger','ggl-mjhl','ggl-queen','zjh','niuniu',
    'sss','blackjack','sgay','mahjong','hundred-holdem','hundred-zjh',
    'hundred-niuniu','hundred-blackjack','hundred-mahjong','arcade-bcbm',
    'arcade-slwh','arcade-fqzs','arcade-mjzl','arcade-qwby',
  ].map(game=>game+'/index.js'),
].map(file=>path.join(root,'game-server/src/games',file)));
// Concrete classes have no independent process state: room/hand/chip state
// belongs to tables, while these classes hold configuration and engine refs.
export const collectibleGameClassFiles=Object.freeze([
  'games/holdem/HoldemGame.js','games/zjh/ZjhGame.js','games/niuniu/NiuniuGame.js',
  'games/sss/SssGame.js','games/blackjack/BlackjackGame.js','games/sgay/SgayGame.js',
  'games/mahjong/MahjongGame.js','games/baccarat/BaccaratGame.js',
  'games/dragon-tiger/DragonTigerGame.js','games/ggl-mjhl/GglMjhlGame.js',
  'games/ggl-queen/GglQueenGame.js','games/hundred-holdem/HundredHoldemGame.js',
  'games/hundred-zjh/HundredZjhGame.js','games/hundred-niuniu/HundredNiuniuGame.js',
  'games/hundred-blackjack/HundredBlackjackGame.js','games/hundred-mahjong/HundredMahjongGame.js',
  'core/TurntableGame.js',
].map(file=>path.join(root,'game-server/src',file)));
export const collectibleGameBaseFiles=Object.freeze([
  'core/GameBase.js','core/SeatGame.js','core/HundredGame.js','core/CardShoeGame.js',
  'core/BairenGame.js','core/SlotsGame.js','games/ggl-core/GglGame.js',
].map(file=>path.join(root,'game-server/src',file)));
export const collectibleGameEngineFiles=Object.freeze([
  'core/bairen-engine.js','core/turntable-engine.js',...[
    'holdem','zjh','niuniu','sss','sgay','mahjong','blackjack','baccarat',
    'dragon-tiger','ggl-core','hundred-holdem','hundred-zjh','hundred-niuniu',
    'hundred-blackjack','hundred-mahjong',
  ].map(game=>'games/'+game+'/engine.js'),
].map(file=>path.join(root,'game-server/src',file)));
// Card/rule helpers own immutable templates or bounded computation caches;
// strategies use only weak hand-keyed estimates. No wallet/session/retry state
// lives here. Unselected callers and financial modules keep the native path.
export const collectibleGameHelperFiles=Object.freeze([
  'holdem/cards.js','zjh/hand.js','niuniu/hand.js','sss/hand.js','sss/scoring.js',
  'sgay/hand.js','sgay/scoring.js','blackjack/hand.js','mahjong/tiles.js',
  'mahjong/hand.js','mahjong/scoring.js','baccarat/rules.js','dragon-tiger/rules.js',
  'ggl-core/rules.js','hundred-holdem/hand.js','hundred-zjh/hand.js',
  'hundred-niuniu/hand.js','hundred-blackjack/hand.js','hundred-mahjong/hand.js',
  ...['holdem','zjh','niuniu','sss','sgay','blackjack','mahjong'].map(game=>game+'/robot.js'),
].map(file=>path.join(root,'game-server/src/games',file)));
// Query coalescing/cache ownership stays on caller runtimes and tables. These
// modules own no result cache, retry task or resident transport of their own.
export const collectibleHistoryFiles=Object.freeze([
  'shared/history-query.js','shared/holdem-replay-format.js','shared/holdem-replay-store.js',
  'shared/native-history-snapshot.js','shared/game-history-detail.js',
  'game-server/src/core/game-history.js','game-server/src/core/hundred-card-history.js',
  'game-server/src/games/baccarat/history.js','game-server/src/games/ggl-core/history.js',
  'game-server/src/games/holdem/history-response.js','game-server/src/games/holdem/replay-state.js',
].map(file=>path.join(root,file)));
// Pricing owns only bounded calculation caches; pot/critical/wheel state is
// passed in explicitly on the hand/table, never reconstructed by module load.
export const collectibleRuleFiles=Object.freeze([
  'game-server/src/games/baccarat/odds.js','game-server/src/games/dragon-tiger/odds.js',
  'game-server/src/core/turntable-rules.js','game-server/src/games/holdem/pots.js',
  'game-server/src/games/holdem/critical.js',
].map(file=>path.join(root,file)));
// Projection state stays on sessions/tables. Sampling caches use weak keys;
// member's avatar directory is read-only and retains no room or wallet state.
export const collectibleCoreHelperFiles=Object.freeze([
  'member.js','seat-view.js','wager.js','robot-cards.js','slots-reels.js',
].map(file=>path.join(root,'game-server/src/core',file)));
// Ticket task ownership stays on the resident common RPC object; these
// factories create no stock, money journal, network client or timer on load.
export const collectibleTicketFiles=Object.freeze([
  'rpc-tickets.js','control-plan.js','reel-profile.js',
].map(file=>path.join(root,'game-server/src/games/ggl-core',file)));
// Pure financial helpers. Rollback closures belong to a caller.
export const collectibleFinanceHelperFiles=Object.freeze([
  'game-server/src/wallet/money-format.js','game-server/src/wallet/transaction-state.js',
  'shared/rpc/game-routes.js',
].map(file=>path.join(root,file)));
// These controllers keep accounts, AsyncLocalStorage, transaction queues and
// round identities on the existing common RPC owner, not on module namespaces.
// Replacing code must not replace that owner or discard an in-flight command.
export const collectibleFinanceControllerFiles=Object.freeze([
  'game-server/src/wallet/rpcWallet.js','game-server/src/wallet/authoritative.js',
  'game-server/src/wallet/round-finance.js',
].map(file=>path.join(root,file)));
// Complete the reviewed wallet import chain. Carry/operation state stays on
// wallet or common owners; the dev-only fallback lives in cache, not an entry.
export const collectibleWalletFacadeFiles=Object.freeze([
  'index.js','carry.js','operations.js','OnlineWallet.js','WalletAdapter.js',
].map(file=>path.join(root,'game-server/src/wallet',file)));
// Room clocks, pools, robot profiles, subscriptions, banker work and fair-proof
// tasks remain on their existing registry/table/session owners across versions.
export const collectibleRoomRuntimeFiles=Object.freeze([
  'room-lifecycle.js','room-pool.js','room-features.js','robot.js',
  'hundred-subscriptions.js','hundred-banker.js','hundred-finance.js',
  'fair-code.js','player-panel-records.js',
].map(file=>path.join(root,'game-server/src/core',file)));
// Profiles, notes and gift quotas stay on room/runtime/storage owners. Final
// reports share the original runtime batch and do not acquire a second writer.
export const collectiblePlayerServiceFiles=Object.freeze([
  'game-server/src/core/player-panel.js','game-server/src/core/user-center.js',
  'shared/player-panel.js','shared/native-player-actions.js','shared/user-center.js',
  'shared/user-center-matches.js',
].map(file=>path.join(root,file)));
// The watcher is a separate resident transport. Hall business code and each
// request's temporary room-pool socket own no module-level runtime state.
export const collectibleHallCenterFiles=Object.freeze([
  'hall/src/user-center.js','hall/src/room-pool.js',
].map(file=>path.join(root,file)));
// Room selection and display population are derived from caller rows/config.
// They own no room pool, login, money, timer or mutable process-wide cache.
export const collectibleHallRoomFiles=Object.freeze([
  'hall/src/rooms.js','hall/src/room-population.js',
  'hall/src/room-population-config.js','shared/holdem-room.js',
].map(file=>path.join(root,file)));
// Query/mutation forwarding owns only the current HTTP/temporary WS request.
// Match snapshots and smart-task ownership stay on the original service/store.
export const collectibleHallRequestFiles=Object.freeze([
  'match-client.js','fair-code.js','smart-bet.js',
].map(file=>path.join(root,'hall/src',file)));
// Markup/response adapters retain data only on their mounted application.
// Asset version lookup is separate from the native client HTTP entry.
export const collectibleHallWebFiles=Object.freeze([
  'hall/src/web.js','hall/src/room-list-refresh.js','hall/src/smart-bet-page.js',
  'shared/client-version.js',
].map(file=>path.join(root,file)));
// RPC business facades own no transport/cache singleton. Their client getters
// remain resident; refresh replaces methods on the existing runtime services.
export const collectibleRpcAccessFiles=Object.freeze([
  'adapters/rpcAdapter.js','tournaments.js',
  ...['commonRpcProd.js','gatewayRpcProd.js','lobbyRpcProd.js','dataCenterStore.js']
    .map(file=>'implementations/prod/'+file),
].map(file=>path.join(root,'shared/rpc',file)));
// Smart tasks, payout receipts and table-owner settings stay on the original
// runtime/table/result. Replacement unwraps the existing smart-table hooks.
export const collectibleHundredControlFiles=Object.freeze([
  'game-server/src/core/smart-bet.js','game-server/src/core/hundred-card-payout.js',
  'game-server/src/core/hundred-table-owner.js','shared/cash-limits.js',
].map(file=>path.join(root,file)));
// Session queues/leases and room registry remain on runtime. The subscription
// callback lives in the resident revocation transport, not a business version.
export const collectibleSessionFiles=Object.freeze([
  'session-control.js','messages.js','core/hundred-lobby.js',
].map(file=>path.join(root,'game-server/src',file)));
// Asset response caches belong to each mounted HTTP app. Admin request and
// submission state is created only inside the browser/page factory.
export const collectibleClientResponseFiles=Object.freeze([
  ...['app.js','scratch-multi-response.js','holdem-replay-response.js',
    'player-panel-response.js','room-ui-response.js','hundred-cleanup-response.js']
    .map(file=>'client-web/src/'+file),
  ...['admin-requests.js','admin-submissions.js','admin-refresh.js'].map(file=>'match/src/'+file),
].map(file=>path.join(root,file)));
// Match/table/checkpoint state and request-cache entries remain on runtime.
// The request-cache sweep timer has a separate resident transport callback.
export const collectibleTournamentFiles=Object.freeze([
  'game-server/src/core/tournament.js','game-server/src/core/tournament-blinds.js',
  'shared/tournament-control.js','shared/tournament-blinds.js',
  'shared/tournament-registration.js','shared/tournament-ranking.js',
  'shared/tournament-idempotency.js','shared/tournament-snapshot.js',
].map(file=>path.join(root,file)));
// Services keep transactions in the original data-center/store and pending
// scheduler ownership on runtime. The actual interval callback stays resident.
export const collectibleMatchServiceFiles=Object.freeze([
  ...['tournaments.js','tables.js','payments.js','schedule.js','award.js',
    'admin-scope.js','admin-match.js','termination-request.js','services/match.js',
    'services/meta.js','constants.js','errors.js','envelope.js'].map(file=>'match/src/'+file),
  'shared/tournament-payment.js',
].map(file=>path.join(root,file)));
// Remaining data/configuration and stateless compatibility helpers.
export const collectibleRemainingBusinessFiles=Object.freeze([
  "game-server/src/games/arcade-bcbm/config.js",
  "game-server/src/games/arcade-fqzs/config.js",
  "game-server/src/games/arcade-mjzl/config.js",
  "game-server/src/games/arcade-qwby/config.js",
  "game-server/src/games/arcade-slwh/config.js",
  "game-server/src/games/baccarat/config.js",
  "game-server/src/games/blackjack/config.js",
  "game-server/src/games/blackjack/messages.js",
  "game-server/src/games/dragon-tiger/config.js",
  "game-server/src/games/ggl-mjhl/config.js",
  "game-server/src/games/ggl-mjhl/reel-config.js",
  "game-server/src/games/ggl-queen/config.js",
  "game-server/src/games/ggl-queen/reel-config.js",
  "game-server/src/games/holdem/config.js",
  "game-server/src/games/holdem/op.js",
  "game-server/src/games/hundred-blackjack/config.js",
  "game-server/src/games/hundred-holdem/config.js",
  "game-server/src/games/hundred-mahjong/config.js",
  "game-server/src/games/hundred-niuniu/config.js",
  "game-server/src/games/hundred-zjh/config.js",
  "game-server/src/games/mahjong/config.js",
  "game-server/src/games/mahjong/messages.js",
  "game-server/src/games/niuniu/config.js",
  "game-server/src/games/niuniu/messages.js",
  "game-server/src/games/sgay/config.js",
  "game-server/src/games/sgay/messages.js",
  "game-server/src/games/sss/config.js",
  "game-server/src/games/sss/messages.js",
  "game-server/src/games/zjh/config.js",
  "game-server/src/games/zjh/messages.js",
  "game-server/src/games/blackjack/banker.js",
  "game-server/src/games/blackjack/casino.js",
  "game-server/src/games/baccarat/table-owner.js",
  "game-server/src/wallet.js",
  "game-server/src/record-cache.js",
  "shared/finance-policy.js",
  "shared/rpc/types/rpcTypes.js",
  "hall/src/room-status-view.js"
].map(file=>path.join(root,file)));
export const collectibleModuleFiles=Object.freeze([...collectibleEntryFiles,...collectibleDependencyFiles,...collectibleGameEntryFiles,...collectibleGameClassFiles,...collectibleGameBaseFiles,...collectibleGameEngineFiles,...collectibleGameHelperFiles,...collectibleHistoryFiles,...collectibleRuleFiles,...collectibleCoreHelperFiles,...collectibleTicketFiles,...collectibleFinanceHelperFiles,...collectibleFinanceControllerFiles,...collectibleWalletFacadeFiles,...collectibleRoomRuntimeFiles,...collectiblePlayerServiceFiles,...collectibleHallCenterFiles,...collectibleHallRoomFiles,...collectibleHallRequestFiles,...collectibleHallWebFiles,...collectibleRpcAccessFiles,...collectibleHundredControlFiles,...collectibleSessionFiles,...collectibleClientResponseFiles,...collectibleRemainingBusinessFiles,...collectibleTournamentFiles,...collectibleMatchServiceFiles]);
const nativeImport=(location,options)=>import(location,options);
function walk(node,visit){
  if(!node||typeof node!=='object')return;
  if(visit(node)===false)return;
  for(const value of Object.values(node)){
    if(Array.isArray(value)){for(const child of value)if(child?.type)walk(child,visit);}
    else if(value?.type)walk(value,visit);
  }
}
function names(pattern,out){
  if(!pattern)return;
  if(pattern.type==='Identifier')out.push(pattern.name);
  else if(pattern.type==='RestElement')names(pattern.argument,out);
  else if(pattern.type==='AssignmentPattern')names(pattern.left,out);
  else if(pattern.type==='ArrayPattern')for(const item of pattern.elements)names(item,out);
  else if(pattern.type==='ObjectPattern')for(const item of pattern.properties)names(item.value||item.argument,out);
}

// Only explicitly selected files use this path. Their compiled source
// is an ordinary async function, so old code can be collected after its exports
// and handlers are released. Other modules keep the existing native ESM loader.
export function createCollectibleEntryLoader({entries=collectibleModuleFiles,resolver=installHotResolver(),importModule=nativeImport}={}){
  const selected=new Set(entries.map(file=>path.resolve(file).toLowerCase()));
  const latest=new Map(),versions=new Map(),pending=new Map(),waiting=new Map();
  let compiled=0,failures=0;
  function keyOf(location){try{const url=new URL(location);return url.protocol==='file:'?path.resolve(fileURLToPath(url)).toLowerCase():null;}catch{return null;}}
  function canonical(location){const url=new URL(location);url.searchParams.sort();return url.href;}
  function reaches(from,target){
    const seen=new Set(),queue=[from];
    while(queue.length){
      const next=queue.pop();if(next===target)return true;if(seen.has(next))continue;seen.add(next);
      for(const child of waiting.get(next)||[])queue.push(child);
    }
    return false;
  }
  async function selectedDependency(location,parent,ancestors){
    location=canonical(location);parent=canonical(parent);
    if(ancestors.has(keyOf(location))||reaches(location,parent))throw Error('Cyclic collectible factory entries are not supported');
    let links=waiting.get(parent);if(!links){links=new Set();waiting.set(parent,links);}links.add(location);
    try{return await load(location,ancestors);}finally{
      links.delete(location);if(!links.size)waiting.delete(parent);
    }
  }
  async function dependency(specifier,parent,ancestors,options){
    let location=specifier;
    if(specifier.startsWith('.')||specifier.startsWith('file:'))location=new URL(specifier,parent).href;
    if(location.startsWith('file:')){
      const url=new URL(location),parentURL=new URL(parent);
      location=resolver.resolve(url.href,{parentURL:parent},value=>({url:value})).url;
      // Match native resolution: content version first, inherited link last.
      // Static imports must not fork native configuration/state namespaces.
      const linked=new URL(location);
      if(linked.searchParams.has('v')&&parentURL.searchParams.has('link'))linked.searchParams.set('link',parentURL.searchParams.get('link'));
      location=linked.href;
      const key=keyOf(location);
      if(selected.has(key)){
        return selectedDependency(location,parent,ancestors);
      }
    }
    return importModule(location,options);
  }
  function prepare(source,location){
    const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),edits=[],imports=[],exports=[],removed=new Set();
    let imported='__gogameFactoryImports',dynamic='__gogameFactoryImport',namespace='__gogameFactoryNamespace',defaulted='__gogameFactoryDefault';
    while(source.includes(imported)||source.includes(dynamic)||source.includes(namespace)||source.includes(defaulted)){imported+='_';dynamic+='_';namespace+='_';defaulted+='_';}
    const pins=planHotSourcePins(source,location,resolver,{ast,importExpression:expression=>dynamic+'('+expression+')'});
    edits.push(...pins.edits);
    for(const statement of ast.body){
      if(statement.type==='ImportDeclaration'){
        removed.add(statement);
        const index=imports.push(statement.source.value)-1;
        const declarations=statement.specifiers.map(item=>{
          if(item.type==='ImportNamespaceSpecifier')return item.local.name+'='+imported+'['+index+']';
          const field=item.type==='ImportDefaultSpecifier'?'default':item.imported.name??item.imported.value;
          return item.local.name+'='+imported+'['+index+']['+JSON.stringify(field)+']';
        });
        edits.push({start:statement.start,end:statement.end,text:declarations.length?'const '+declarations.join(',')+';':''});
      }else if(statement.type==='ExportNamedDeclaration'){
        if(statement.declaration){
          const declaration=statement.declaration;
          if(declaration.type==='VariableDeclaration'){for(const item of declaration.declarations){const bound=[];names(item.id,bound);for(const name of bound)exports.push([name,name]);}}
          else if(declaration.id)exports.push([declaration.id.name,declaration.id.name]);
          else throw Error('Unsupported collectible entry export declaration');
          edits.push({start:statement.start,end:declaration.start,text:''});
        }else{
          removed.add(statement);
          let importedIndex;
          if(statement.source)importedIndex=imports.push(statement.source.value)-1;
          for(const item of statement.specifiers){
            const exported=item.exported.name??item.exported.value,local=item.local.name??item.local.value;
            exports.push([exported,statement.source?imported+'['+importedIndex+']['+JSON.stringify(local)+']':local]);
          }
          edits.push({start:statement.start,end:statement.end,text:''});
        }
      }else if(statement.type==='ExportDefaultDeclaration'){
        const declaration=statement.declaration;
        if(['FunctionDeclaration','ClassDeclaration'].includes(declaration.type)&&declaration.id){
          exports.push(['default',declaration.id.name]);
          edits.push({start:statement.start,end:declaration.start,text:''});
        }else{
          // A default expression is a one-time value, while a named default
          // function/class exports its live local binding. A property named
          // default also gives anonymous functions/classes the native name,
          // before class static initializers run.
          exports.push(['default',defaulted]);
          edits.push({start:statement.start,end:declaration.start,text:'const '+defaulted+'=({default:('});
          edits.push({start:declaration.end,end:statement.end,text:')}).default;'});
        }
      }else if(statement.type==='ExportAllDeclaration'){
        throw Error('Collectible factory entries do not support export-all declarations');
      }
    }
    walk(ast,node=>{
      if(removed.has(node))return false;
      if(node.type==='ImportExpression')edits.push({start:node.start,end:node.start+6,text:dynamic});
      if(node.type==='MemberExpression'&&node.object?.type==='MetaProperty'&&node.object.meta.name==='import'){
        if(node.computed||node.property.name!=='url')throw Error('Collectible entries only support import.meta.url');
        edits.push({start:node.start,end:node.end,text:JSON.stringify(location)});
        return false;
      }
    });
    if(source.startsWith('#!'))edits.push({start:0,end:source.indexOf('\n')<0?source.length:source.indexOf('\n'),text:''});
    source=applySourceEdits(source,edits);
    const descriptors=exports.map(([name,value])=>JSON.stringify(name)+':{enumerable:true,get:()=>'+value+'}').join(',');
    const body='"use strict";return (async()=>{\n'+pins.prefix+source+'\nconst '+namespace+'=Object.create(null);Object.defineProperties('+namespace+',{'+descriptors+'});Object.defineProperty('+namespace+',Symbol.toStringTag,{value:"Module"});return Object.freeze('+namespace+');})();';
    // Give each compilation its own empty scope. With the default shared
    // context, V8 can retain old compilation data after exported code dies.
    // No names or prototypes are added, and globals stay in the native realm.
    const scope=Object.freeze(Object.create(null));
    return {run:compileFunction(body,[imported,dynamic],{filename:fileURLToPath(location),contextExtensions:[scope]}),imports};
  }
  // Keep evaluation outside the cache lookup's async activation. Exported
  // closures must not retain that activation and its previous active module.
  async function evaluate(location,ancestors){
      const nextAncestors=new Set(ancestors);nextAncestors.add(keyOf(location));
      const prepared=prepare(resolver.readSource(location),location);
      // Each live entry owns its selected dependencies. An old handler can
      // still use its original lazy module after the global weak cache clears.
      const ownedDependencies=new Map();
      const localImport=(specifier,options)=>{
        let absolute=specifier;if(typeof specifier==='string'&&specifier.startsWith('.'))absolute=new URL(specifier,location).href;
        if(typeof absolute==='string'&&selected.has(keyOf(absolute))){
          absolute=canonical(absolute);
          if(!ownedDependencies.has(absolute))ownedDependencies.set(absolute,dependency(absolute,location,nextAncestors));
          return ownedDependencies.get(absolute);
        }
        return dependency(absolute,location,nextAncestors,options);
      };
      const modules=[];for(const specifier of prepared.imports)modules.push(await localImport(specifier));
      const module=await prepared.run(modules,(specifier,options)=>{
        return localImport(specifier,options);
      });
      latest.set(keyOf(location),{location,module});versions.set(location,new WeakRef(module));
      while(versions.size>256)versions.delete(versions.keys().next().value);
      compiled++;return module;
  }
  async function load(location,ancestors=new Set()){
    const key=keyOf(location);
    if(!selected.has(key)||!new URL(location).searchParams.get('v')?.startsWith('hot-'))return null;
    location=canonical(location);
    const active=latest.get(key);if(active?.location===location)return active.module;
    const old=versions.get(location)?.deref();if(old)return old;
    if(pending.has(location))return pending.get(location);
    const task=evaluate(location,ancestors);
    pending.set(location,task);
    try{return await task;}catch(error){failures++;throw error;}finally{pending.delete(location);}
  }
  return {load,handles(location){return selected.has(keyOf(location));},stats(){
    let dependencyWaits=0;for(const links of waiting.values())dependencyWaits+=links.size;
    return {activeEntries:latest.size,weakVersions:versions.size,pendingEntries:pending.size,dependencyWaits,compiledEntries:compiled,compileFailures:failures};
  }};
}
