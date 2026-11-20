import {randomBytes} from 'node:crypto';

const compiled=new WeakMap();
export function randomBelow(limit){
  if(typeof limit!=='bigint'||limit<=0n)throw new Error('Invalid random bound');
  const bits=(limit-1n).toString(2).length,bytes=Math.ceil(bits/8),mask=bits%8;
  for(let tries=0;tries<64;tries++){
    const buffer=randomBytes(bytes);if(mask)buffer[0]&=(1<<mask)-1;
    const value=BigInt('0x'+buffer.toString('hex'));if(value<limit)return value;
  }
  throw new Error('Could not sample reel entropy');
}
function weighted(entries,rng){
  const total=entries.reduce((sum,item)=>sum+item.weight,0n);
  if(!total)throw new Error('Reel configuration cannot generate the requested outcome');
  let cursor=rng(total);
  if(typeof cursor!=='bigint'||cursor<0n||cursor>=total)throw new Error('Invalid reel random source');
  for(const item of entries){if(cursor<item.weight)return item.value;cursor-=item.weight;}
  throw new Error('Invalid reel probability table');
}
function indexBelow(size,rng){const value=rng(BigInt(size));if(typeof value!=='bigint'||value<0n||value>=BigInt(size))throw new Error('Invalid reel random source');return Number(value);}

// Ordinary Slots reel stops: each strip is circular and a stop reveals `rows`
// adjacent symbols. Conditional outcomes use exact dynamic-programming counts;
// they never spin until a lucky/unlucky result happens to appear.
export function compileReels(profile,winningSymbol=1){
  if(compiled.get(profile)?.winningSymbol===winningSymbol)return compiled.get(profile).sampler;
  const rows=profile?.rows,strips=profile?.strips;
  if(!Number.isInteger(rows)||rows<1||rows>16||!Array.isArray(strips)||!strips.length||strips.length>16||rows*strips.length>256)
    throw new Error('Invalid Slots reel dimensions');
  const copied=strips.map(strip=>{
    if(!Array.isArray(strip)||strip.length<rows||strip.length>4096||strip.some(symbol=>!Number.isInteger(symbol)||symbol<1||symbol>255))
      throw new Error('Invalid Slots reel strip');return Object.freeze(strip.slice());
  });
  const groups=copied.map(strip=>{
    const counts=new Map();
    for(let stop=0;stop<strip.length;stop++){
      let count=0;for(let row=0;row<rows;row++)if(strip[(stop+row)%strip.length]===winningSymbol)count++;
      if(!counts.has(count))counts.set(count,[]);counts.get(count).push(stop);
    }
    return counts;
  });
  const suffix=Array(strips.length+1);suffix[strips.length]=new Map([[0,1n]]);
  for(let col=strips.length-1;col>=0;col--){
    const next=new Map();
    for(const [count,stops]of groups[col])for(const [tail,weight]of suffix[col+1])next.set(count+tail,(next.get(count+tail)||0n)+BigInt(stops.length)*weight);
    suffix[col]=next;
  }
  const reveal=stops=>({stops:Object.freeze(stops.slice()),symbols:Object.freeze(stops.flatMap((stop,col)=>Array.from({length:rows},(_,row)=>copied[col][(stop+row)%copied[col].length])))});
  const sampler=Object.freeze({
    distribution(){return new Map(suffix[0]);},
    sample(rng=randomBelow){return reveal(copied.map(strip=>indexBelow(strip.length,rng)));},
    sampleWhere(predicate,rng=randomBelow){
      let remaining=weighted([...suffix[0]].filter(([count])=>predicate(count)).map(([count,weight])=>({value:count,weight})),rng);
      const stops=[];
      for(let col=0;col<copied.length;col++){
        const count=weighted([...groups[col]].map(([count,options])=>({value:count,weight:BigInt(options.length)*(suffix[col+1].get(remaining-count)||0n)})),rng);
        const options=groups[col].get(count);stops.push(options[indexBelow(options.length,rng)]);remaining-=count;
      }
      return reveal(stops);
    },
  });
  if(Object.isFrozen(profile)&&Object.isFrozen(profile.strips)&&profile.strips.every(Object.isFrozen))compiled.set(profile,{winningSymbol,sampler});
  return sampler;
}
