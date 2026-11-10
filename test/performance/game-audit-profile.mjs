// Run in a separate process. Workers impose a hard wall-clock ceiling so
// adversarial evaluator inputs cannot freeze the audit or resident services.
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import fs from 'node:fs';

if(!isMainThread){
  let result;
  if(workerData==='sss-eight-jokers'){
    const {arrange}=await import('../../game-server/src/games/sss/hand.js');
    const start=performance.now();const options=arrange([52,53,52,53,52,53,52,53,0,2,3,4,5]);
    result={milliseconds:performance.now()-start,options:options.length};
  }else if(workerData==='niuniu-five-wildcards'){
    const {evaluate}=await import('../../game-server/src/games/niuniu/hand.js');
    const {roomRules}=await import('../../game-server/src/games/niuniu/config.js');
    const rules=roomRules({play_mode:7});const start=performance.now();
    const rank=evaluate([52,53,54,0,13],rules,0);
    result={milliseconds:performance.now()-start,type:rank.niuType};
  }
  parentPort.postMessage(result);
}else{
  const results=[];
  if(process.argv.includes('--content-hot')){
    await import('../../shared/hot-import.js');
  }
  for(const name of ['sss-eight-jokers','niuniu-five-wildcards']){
    const result=await new Promise(resolve=>{
      const worker=new Worker(new URL(import.meta.url),{workerData:name});let done=false;
      const finish=value=>{if(done)return;done=true;clearTimeout(timer);void worker.terminate();resolve({name,...value});};
      const timer=setTimeout(()=>finish({deadlineExceeded:true,limitMs:10000}),10000);
      worker.on('message',value=>finish(value));worker.on('error',error=>finish({error:error.message}));
    });
    results.push(result);console.log(JSON.stringify(result));
  }
  if(global.gc){
    const {loadGames}=await import('../../game-server/src/games/catalog.js'),samples=[];
    global.gc();samples.push({generations:0,heapBytes:process.memoryUsage().heapUsed});
    const generations=Number(process.argv.find(arg=>arg.startsWith('--generations='))?.split('=')[1]||8);
    for(let n=1;n<=generations;n++){await loadGames('audit-heap-'+n);global.gc();if([1,4,8,32,64,128].includes(n)||n===generations)samples.push({generations:n,heapBytes:process.memoryUsage().heapUsed});}
    const result={name:'hot-reload-module-cache',samples};results.push(result);console.log(JSON.stringify(result));
  }
  fs.mkdirSync('cache',{recursive:true});fs.writeFileSync('cache/game-audit-profile.json',JSON.stringify(results,null,2));
}
