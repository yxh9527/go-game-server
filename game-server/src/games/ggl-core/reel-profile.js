// Initial, reviewable game-server configuration. These are this project's reel
// strips, not a claim to reproduce an unpublished third-party return rate.
// Four adjacent winning symbols make all 0..20 hit counts reachable on 5x4.
export function scratchReelProfile(offsets){
  return Object.freeze({rows:4,strips:Object.freeze(offsets.map(offset=>{
    const strip=Array.from({length:72},(_,i)=>i<4?1:2+((i+offset)%9));
    const rotated=strip.slice(offset).concat(strip.slice(0,offset));return Object.freeze(rotated);
  }))});
}
