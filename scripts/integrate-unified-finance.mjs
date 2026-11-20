// Explicit migration from the local implementation corresponding to the supplied
// protocol. Additive: existing lottery methods and wallet implementations stay.
import fs from 'node:fs';
import path from 'node:path';

const target=path.resolve(process.argv[2]||'D:/project/gogames');
const reference=path.resolve(process.argv[3]||'D:/project/wgsqp');
const read=(root,file)=>fs.readFileSync(path.join(root,file),'utf8');
const write=(file,value)=>{
  const destination=path.join(target,file);fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.writeFileSync(destination,value,'utf8');
};
function declarations(source){
  const starts=[...source.matchAll(/^func (?:\([^\n]*\) )?([A-Za-z_][A-Za-z_0-9]*)\(/gm)];
  return starts.map(match=>{
    let depth=0,opened=false,quote='',comment='';
    for(let i=match.index;i<source.length;i++){
      const ch=source[i],next=source[i+1];
      if(comment==='line'){if(ch==='\n')comment='';continue;}
      if(comment==='block'){if(ch==='*'&&next==='/'){comment='';i++;}continue;}
      if(quote){if(ch==='\\'&&quote!=='`'){i++;continue;}if(ch===quote)quote='';continue;}
      if(ch==='/'&&next==='/'){comment='line';i++;continue;}
      if(ch==='/'&&next==='*'){comment='block';i++;continue;}
      if(ch==='"'||ch==="'"||ch==='`'){quote=ch;continue;}
      if(ch==='{'){depth++;opened=true;}
      if(ch==='}'&&--depth===0&&opened)return {name:match[1],text:source.slice(match.index,i+1)+'\n'};
    }
    throw Error('Unterminated Go function '+match[1]);
  });
}
if(fs.existsSync(path.join(target,'lottery/unified/service.go')))throw Error('Unified implementation already exists; review changes instead of overwriting.');

const protocol=read(reference,'micro_service/proto/lottery.proto');
const legacy=read(target,'micro_service/proto/lottery.proto');
const methods=protocol.slice(protocol.indexOf('service LotteryService {')+'service LotteryService {'.length,protocol.indexOf('\n}',protocol.indexOf('service LotteryService {')));
const messages=protocol.slice(protocol.indexOf('\n}',protocol.indexOf('service LotteryService {'))+2);
write('micro_service/proto/lottery.proto',legacy.replace('service LotteryService {','service LotteryService {'+methods)+messages);
write('micro_service/proto/base.proto',read(target,'micro_service/proto/base.proto').replace('    OK = 0;','    OK = 0;\n    ROUND_NOT_FOUND = 10;'));

for(const file of ['service.go','pool_control_decision.go','service_test.go','pool_control_decision_test.go']){
  let source=read(reference,'lottery/rpc/'+file).replace(/^package rpc/m,'package unified');
  source=source.replaceAll('dao.CacheIns().GetPool(','dao.CacheIns().GetUnifiedPool(');
  source=source.replace(/^\s*LevelName:\s*config\.RoomLevelName\(symbol, level\),\r?\n/m,'\n');
  write('lottery/unified/'+file,source);
}

// Share legacy AgentData/User/Game objects and their existing flush loop.
// Only append new operations; use a separate level-aware pool reader.
const cache=read(reference,'lottery/dao/cache.go');
const wanted=new Set(['GetPool','poolValue','availablePoolValue','poolType','CanAffordAward','ApplyPoolChange',
  'TryReservePool','TryReservePoolWithLedger','ReleasePoolReservation','ReleasePoolReservationWithLedger',
  'AdjustPoolReservationWithLedger','RecordSettlement']);
const extra=declarations(cache).filter(item=>wanted.has(item.name)).map(item=>item.name==='GetPool'?item.text.replace(' GetPool(',' GetUnifiedPool('):item.text).join('\n');
write('lottery/dao/unified_cache.go','package dao\n\nimport ("app/config";"time";"github.com/shopspring/decimal";"go.uber.org/zap")\n\n'+extra);

const redisSource=read(reference,'lottery/dao/redis.go');
const existing=new Set(declarations(read(target,'lottery/dao/redis.go')).map(item=>item.name));
const omitted=new Set(['NewRedisDao','NewRedisDaoWithClient','SetRedisDaoForTest']);
const redisExtra=declarations(redisSource).filter(item=>!existing.has(item.name)&&!omitted.has(item.name)).map(item=>item.text).join('\n');
const redisGlobals=redisSource.slice(redisSource.indexOf('\nvar (')+1,redisSource.indexOf('\nfunc EncodeReservationLedger'));
const cancelType=redisSource.slice(redisSource.indexOf('type CancelWalletRefundResult struct'),redisSource.indexOf('// RefundPlayerCurrencyWithCancelMarker'));
const reserveType=redisSource.slice(redisSource.indexOf('type ReserveWithLedgerResult struct'),redisSource.indexOf('// TryReserveAgentPoolWithLedger'));
const releaseType=redisSource.slice(redisSource.indexOf('type ReleaseWithLedgerResult struct'),redisSource.indexOf('// ReleaseAgentReservedWithLedger'));
write('lottery/dao/unified_redis.go','package dao\n\nimport ("context";"fmt";"errors";"strconv";"time";"github.com/redis/go-redis/v9";"github.com/shopspring/decimal";"go.uber.org/zap")\n\n'+redisGlobals+'\n'+cancelType+'\n'+reserveType+'\n'+releaseType+'\n'+redisExtra);

// Test-only constructor used by the imported ledger regressions.
write('lottery/dao/unified_test_helpers_test.go','package dao\nimport "github.com/redis/go-redis/v9"\nfunc NewRedisDaoWithClient(cli redis.UniversalClient)*RedisDao{return &RedisDao{cli:cli}}\nfunc SetRedisDaoForTest(rd *RedisDao){redisDao=rd}\n');
write('lottery/dao/reservation_ledger_test.go',read(reference,'lottery/dao/reservation_ledger_test.go'));

write('app/config/unified_pool.go',`package config
import "fmt"
// Preserve existing legacy lookup while exposing the protocol's level-aware route.
func(cfg *Configs)GetPoolCfgWithKey(agentId int64,symbol string)(*Pool,string){
 cfg.Lock.RLock();defer cfg.Lock.RUnlock();if cfg.Pool==nil{return nil,""}
 for _,key:=range []string{fmt.Sprintf("%d_%s",agentId,symbol),fmt.Sprintf("%d-%s",agentId,symbol)}{if p:=cfg.Pool.Agent[key];p!=nil{return p,key}}
 return cfg.Pool.Default[symbol],symbol
}
func(cfg *Configs)GetPoolItem(agentId int64,symbol string,level uint32)*PoolItem{p,_:=cfg.GetPoolCfgWithKey(agentId,symbol);if p==nil{return nil};return p.Pool[int32(level)]}
`);
write('app/entity/record.go',read(target,'app/entity/record.go').replace('type CacheRecordsReq struct {',
 'type CacheRecordsReq struct {\n Level uint32 '+String.fromCharCode(96)+'json:"level"'+String.fromCharCode(96)+'\n ExPump float64 '+String.fromCharCode(96)+'json:"exPmup"'+String.fromCharCode(96)));

const pairs=[['Bet','BetRequest','BetResponse'],['PrePay','PrePayRequest','PrePayResponse'],
 ['RenewReservation','RenewReservationRequest','RenewReservationResponse'],['Settlement','SettlementRequest','SettlementResponse'],
 ['GetRoundFinanceState','GetRoundFinanceStateReq','GetRoundFinanceStateResp'],['CancelBet','CancelBetRequest','CancelBetResponse'],
 ['GetPoolControlDecision','GetPoolControlDecisionRequest','GetPoolControlDecisionResponse']];
const wrappers=pairs.map(([name,req,resp])=>`func(d *LotteryService)${name}(ctx context.Context,req *services.${req})(*services.${resp},error){if d.finance==nil{return nil,status.Error(codes.Unavailable,"unified finance is not initialized")};return d.finance.${name}(ctx,req)}`).join('\n');
write('lottery/rpc/service_unified.go','package rpc\nimport("context";"micro_service/services";"google.golang.org/grpc/codes";"google.golang.org/grpc/status")\n'+wrappers+'\n');
let service=read(target,'lottery/rpc/service.go');
service=service.replace('"lottery/dao"','"lottery/dao"\n"lottery/unified"');
service=service.replace('type LotteryService struct {','type LotteryService struct {\n finance *unified.LotteryService');
service=service.replace('tmp.initRecordsCache()','tmp.finance = unified.NewLotteryService(es)\n tmp.initRecordsCache()');
write('lottery/rpc/service.go',service);
console.log('Added seven unified finance RPCs alongside legacy methods. Generate Go bindings and run checks before deployment.');
