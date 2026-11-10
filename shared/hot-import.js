import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {registerHooks} from 'node:module';
import {installHotResolver} from './hot-loader.js';

const resolver=installHotResolver(),selfURL=new URL('./hot-import.js',import.meta.url);
const root=fileURLToPath(new URL('../',import.meta.url));
const directories=['game-server/src','hall/src','client-web/src','match/src','shared','cache'].map(p=>path.resolve(root,p));
const within=file=>directories.some(dir=>{const rel=path.relative(dir,file);return !rel.startsWith('..')&&!path.isAbsolute(rel);});
const linkerKey=Symbol.for('gogame.hot.canonical-import.v2');
if(!globalThis[linkerKey]){
  globalThis[linkerKey]=registerHooks({
    resolve(specifier,context,nextResolve){
      const result=nextResolve(specifier,context);
      if(!result.url?.startsWith('file:'))return result;
      const url=new URL(result.url);
      if(url.pathname===selfURL.pathname){
        url.search='';return {...result,url:url.href};
      }
      // Isolate modules linked before this upgrade exactly once. All later
      // unchanged imports reuse this same link version and content hash.
      if(url.searchParams.has('v')&&within(fileURLToPath(url)))url.searchParams.set('link','2');
      return {...result,url:url.href};
    },
    load(url,context,nextLoad){
      const result=nextLoad(url,context);
      if(result.format!=='module'||!url.startsWith('file:')||!within(fileURLToPath(url)))return result;
      const source=typeof result.source==='string'?result.source:result.source?Buffer.from(result.source).toString('utf8'):null;
      if(!source)return result;
      // Rewrite only source-level imports/exports at the start of a line.
      // Runtime JavaScript patch strings and user content remain untouched.
      const linked=source.replace(/(^[ \t]*(?:import|export)\s+[^;\r\n]*?\bfrom\s*)(['"])(\.{1,2}\/[^'"\r\n]*rel\.js)\2/gm,
        (_match,prefix)=>prefix+JSON.stringify(selfURL.href));
      return linked===source?result:{...result,source:linked};
    },
  });
}

function resolvedLocation(location,version){
  const url=new URL(location);
  url.searchParams.set('v',String(version||'0'));
  url.searchParams.set('link','2');
  url.searchParams.set('_hot_source','1');
  return resolver.resolve(url.href,{parentURL:import.meta.url},specifier=>({url:specifier})).url;
}
export function importHotModule(location,version='0'){
  // Canonicalize before import(), not just inside a resolve hook: otherwise
  // Node can retain a separate raw-specifier entry for every timestamp.
  return import(resolvedLocation(location,version));
}
const linkedDependencies=globalThis[Symbol.for('gogame.hot.linked-dependencies.v2')] ||= new Map();
export function rel(metaURL,spec,version){
  const parent=new URL(metaURL),location=new URL(spec,parent).href;
  // A running old handler keeps dependencies it has already imported. A
  // changed dependency changes its parent's content hash on the next reload,
  // so the new handler receives a separate dependency graph.
  if(!parent.searchParams.has('v'))return importHotModule(location,version);
  let dependencies=linkedDependencies.get(parent.href);
  if(!dependencies){dependencies=new Map();linkedDependencies.set(parent.href,dependencies);}
  if(!dependencies.has(location))dependencies.set(location,resolvedLocation(location,version));
  return import(dependencies.get(location));
}
