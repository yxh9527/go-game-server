import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const clientRoot=fileURLToPath(new URL('../static/client/',import.meta.url));

// Shared asset lookup must not load the entire client HTTP application into
// each hall business version. No server or process-wide cache is owned here.
export function clientVersion(){
  if(!fs.existsSync(clientRoot))return '2.0.1279';
  const names=fs.readdirSync(clientRoot).filter(name=>/^\d+\.\d/.test(name)).sort();
  return names.at(-1)||'2.0.1279';
}

// Public browser endpoints are separate from Node's internal RPC/WS targets.
export function browserEndpoints(config = {}) {
  const result = {};
  for (const key of ['hall_url', 'client_url', 'game_ws_url', 'hundred_ws_url']) {
    if (!config.public?.[key]) continue;
    const url = new URL(config.public[key]);
    const socket = key.includes('_ws_');
    if (!(socket ? ['ws:', 'wss:'] : ['http:', 'https:']).includes(url.protocol)
      || url.username || url.password || url.search || url.hash || (!socket && url.pathname !== '/')) {
      throw new Error(`Invalid public.${key}`);
    }
    result[key] = socket ? url.href : url.origin;
  }
  if (result.game_ws_url && !result.hundred_ws_url) result.hundred_ws_url = result.game_ws_url;
  return result;
}

export function browserSocketDomain(url) {
  const value = new URL(url);
  return value.host + (value.pathname === '/' ? '' : value.pathname);
}

export function clientEndpointScript(config = {}) {
  const endpoints = browserEndpoints(config);
  if (!Object.keys(endpoints).length) return '';
  const json = JSON.stringify(endpoints).replaceAll('<', '\\u003c');
  return `<script>(function(p){
    window.__GOGAME_ENDPOINTS__=p;
    function rewrite(value){
      if(typeof value!=="string"||!p.hall_url)return value;
      var url;try{url=new URL(value,location.href);}catch(e){return value;}
      if((url.hostname==="api.pansu.xyz"||url.hostname==="lobby.localhost"||url.origin===location.origin)
        &&/^\\/(?:api\\/)?internal\\/v1\\/do$/.test(url.pathname))
        return p.hall_url+"/api/internal/v1/do"+url.search;
      return value;
    }
    var open=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(){arguments[1]=rewrite(arguments[1]);return open.apply(this,arguments);};
    if(window.fetch){var fetch=window.fetch.bind(window);window.fetch=function(input,init){
      if(typeof input==="string")input=rewrite(input);
      else if(input&&input.url){var next=rewrite(input.url);if(next!==input.url)input=new Request(next,input);}
      return fetch(input,init);
    };}
    var Native=window.WebSocket;
    function Socket(url,protocols){
      var parsed;try{parsed=new URL(url);}catch(e){}
      [p.game_ws_url,p.hundred_ws_url].forEach(function(target){
        if(!target||!parsed)return;var configured=new URL(target);
        if(parsed.host===configured.host&&parsed.pathname===configured.pathname){parsed.protocol=configured.protocol;url=parsed.href;}
      });
      return arguments.length>1?new Native(url,protocols):new Native(url);
    }
    Object.setPrototypeOf(Socket,Native);Socket.prototype=Native.prototype;window.WebSocket=Socket;
  })(${json});</script>`;
}
