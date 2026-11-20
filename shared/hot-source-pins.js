import fs from 'node:fs';
import path from 'node:path';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
import {parse} from 'acorn';
import {installHotResolver} from './hot-loader.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const roots=['shared','game-server/src','hall/src','match/src','client-web/src','cache'].map(dir=>path.join(root,dir));
const stateKey=Symbol.for('gogame.hot.source-pins.v1');
const inside=file=>roots.some(dir=>{const relative=path.relative(dir,file);return relative===''||!relative.startsWith('..')&&!path.isAbsolute(relative);});
const functions=new Set(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression']);
function children(node,visit){for(const value of Object.values(node)){if(Array.isArray(value)){for(const child of value)if(child?.type)visit(child);}else if(value?.type)visit(value);}}
function bindings(pattern,names){
  if(!pattern)return;
  if(pattern.type==='Identifier')names.add(pattern.name);
  else if(pattern.type==='RestElement')bindings(pattern.argument,names);
  else if(pattern.type==='AssignmentPattern')bindings(pattern.left,names);
  else if(pattern.type==='ArrayPattern')for(const item of pattern.elements)bindings(item,names);
  else if(pattern.type==='ObjectPattern')for(const item of pattern.properties)bindings(item.type==='RestElement'?item.argument:item.value,names);
}
function blockBindings(node,names){
  for(const statement of node.body||[]){
    if(statement.type==='VariableDeclaration'&&statement.kind!=='var')for(const declaration of statement.declarations)bindings(declaration.id,names);
    if(statement.type==='FunctionDeclaration'||statement.type==='ClassDeclaration')bindings(statement.id,names);
  }
}
function functionVars(node,names){
  if(functions.has(node.type)||node.type==='ClassDeclaration'||node.type==='ClassExpression')return;
  if(node.type==='VariableDeclaration'&&node.kind==='var')for(const item of node.declarations)bindings(item.id,names);
  children(node,child=>functionVars(child,names));
}
const ownMeta=node=>node?.type==='MemberExpression'&&!node.computed&&node.property?.name==='url'
  &&node.object?.type==='MetaProperty'&&node.object.meta?.name==='import'&&node.object.property?.name==='meta';

export function applySourceEdits(source,edits){
  if(!edits.length)return source;
  const ordered=edits.map((edit,index)=>({...edit,index})).sort((a,b)=>a.start-b.start||a.end-b.end||b.index-a.index);
  const chunks=[];let cursor=0;
  for(const edit of ordered){
    if(!Number.isInteger(edit.start)||!Number.isInteger(edit.end)||edit.start<cursor||edit.end<edit.start||edit.end>source.length||typeof edit.text!=='string')throw Error('Invalid or overlapping hot source edits');
    chunks.push(source.slice(cursor,edit.start),edit.text);cursor=edit.end;
  }
  chunks.push(source.slice(cursor));return chunks.join('');
}

// Bind repository rel() calls in the compiled source to canonical dependency
// URLs. Old handlers then retain their own URLs without a global per-version
// map. Only parsed calls bound to our imported rel function are transformed.
export function planHotSourcePins(source,location,resolver,{ast,importExpression=expression=>'import('+expression+')'}={}){
  const parent=new URL(location);
  const empty={edits:[],prefix:'',pinned:0,dynamic:0};
  if(!parent.searchParams.get('v')?.startsWith('hot-'))return empty;
  ast ||= parse(source,{ecmaVersion:'latest',sourceType:'module'});
  const imports=new Set();
  for(const statement of ast.body){
    if(statement.type!=='ImportDeclaration')continue;
    let target;try{target=new URL(statement.source.value,parent);}catch{continue;}
    if(!target.pathname.endsWith('/rel.js')&&!target.pathname.endsWith('/hot-import.js'))continue;
    for(const item of statement.specifiers)if(item.type==='ImportSpecifier'&&item.imported.name==='rel')imports.add(item.local.name);
  }
  if(!imports.size)return empty;
  const canonical=specifier=>{
    const url=new URL(specifier,parent);
    if(url.protocol!=='file:'||!inside(fileURLToPath(url))||!fs.existsSync(fileURLToPath(url)))return null;
    url.searchParams.set('v',parent.searchParams.get('v'));url.searchParams.set('_hot_source','1');url.searchParams.set('link','2');
    return resolver.resolve(url.href,{parentURL:parent.href},value=>({url:value})).url;
  };
  const literalDependencies=new Map();
  function literals(node){
    if(node.type==='Literal'&&typeof node.value==='string'&&/^\.{1,2}\/[^?#]*\.m?js(?:[?#].*)?$/.test(node.value))literalDependencies.set(node.value,null);
    children(node,literals);
  }
  const edits=[],dynamicCalls=[];let literalCalls=0;
  function walk(node,shadow=new Set()){
    let scoped=shadow;
    if(functions.has(node.type)){
      scoped=new Set(shadow);bindings(node.id,scoped);for(const parameter of node.params)bindings(parameter,scoped);functionVars(node.body,scoped);
    }else if(node.type==='BlockStatement'){
      scoped=new Set(shadow);blockBindings(node,scoped);
    }else if(node.type==='CatchClause'){
      scoped=new Set(shadow);bindings(node.param,scoped);
    }else if(node.type==='ClassDeclaration'||node.type==='ClassExpression'){
      scoped=new Set(shadow);bindings(node.id,scoped);
    }else if(node.type==='SwitchStatement'){
      scoped=new Set(shadow);blockBindings({body:node.cases.flatMap(branch=>branch.consequent)},scoped);
    }else if(['ForStatement','ForInStatement','ForOfStatement'].includes(node.type)){
      scoped=new Set(shadow);const declaration=node.init||node.left;if(declaration?.type==='VariableDeclaration'&&declaration.kind!=='var')for(const item of declaration.declarations)bindings(item.id,scoped);
    }
    if(node.type==='CallExpression'&&node.callee.type==='Identifier'&&imports.has(node.callee.name)&&!scoped.has(node.callee.name)
      &&ownMeta(node.arguments[0])&&node.arguments.length>=2&&!node.arguments.some(arg=>arg.type==='SpreadElement')){
      const specifier=node.arguments[1];
      if(specifier.type==='Literal'&&typeof specifier.value==='string'){
        const target=canonical(specifier.value);
        if(target){
          // Preserve argument evaluation, including a version expression with
          // side effects, while removing the mutable dependency-map lookup.
          // Keep argument expressions in the original AST ranges so the
          // factory compiler can rewrite nested imports/meta without parsing
          // generated JavaScript a second time. Replace punctuation only.
          const args=node.arguments;
          edits.push({start:node.start,end:args[0].start,text:'(('});
          for(let index=0;index<args.length-1;index++)edits.push({start:args[index].end,end:args[index+1].start,text:'),('});
          edits.push({start:args.at(-1).end,end:node.end,text:'),'+importExpression(JSON.stringify(target))+')'});
          literalCalls++;
        }
      }else dynamicCalls.push({start:node.callee.start,end:node.callee.end,name:node.callee.name});
    }
    children(node,child=>walk(child,scoped));
  }
  walk(ast);
  let prefix='';
  if(dynamicCalls.length){
    literals(ast);
    for(const specifier of literalDependencies.keys()){const target=canonical(specifier);if(target)literalDependencies.set(specifier,target);else literalDependencies.delete(specifier);}
    const pins=JSON.stringify(Object.fromEntries(literalDependencies));
    const helpers=new Map();
    for(const call of dynamicCalls){
      let helper=helpers.get(call.name);
      if(!helper){
        helper='__gogamePinnedRel';while(source.includes(helper)||[...helpers.values()].includes(helper))helper+='_';helpers.set(call.name,helper);
        prefix+='const '+helper+'Urls='+pins+';const '+helper+'=(meta,spec,version)=>Object.hasOwn('+helper+'Urls,spec)?'+importExpression(helper+'Urls[spec]')+':'+call.name+'(meta,spec,version);\n';
      }
      edits.push({start:call.start,end:call.end,text:helper});
    }
  }
  return {edits,prefix,pinned:literalCalls+dynamicCalls.length,dynamic:dynamicCalls.length};
}

export function pinHotSource(source,location,resolver){
  const plan=planHotSourcePins(source,location,resolver);
  const output=applySourceEdits(source,plan.edits);
  const insertion=output.startsWith('#!')?output.indexOf('\n')+1:0;
  return {source:output.slice(0,insertion)+plan.prefix+output.slice(insertion),pinned:plan.pinned,dynamic:plan.dynamic};
}

export function installHotSourcePins(){
  if(globalThis[stateKey])return globalThis[stateKey];
  const resolver=installHotResolver();
  const state={modules:0,pinnedCalls:0,dynamicCalls:0};
  state.hook=registerHooks({load(location,context,nextLoad){
    const result=nextLoad(location,context);
    if(result.format!=='module'||!location.startsWith('file:')||!inside(fileURLToPath(location)))return result;
    const source=typeof result.source==='string'?result.source:result.source?Buffer.from(result.source).toString('utf8'):null;
    if(!source||!source.includes('rel'))return result;
    const pinned=pinHotSource(source,location,resolver);
    if(!pinned.pinned)return result;
    state.modules++;state.pinnedCalls+=pinned.pinned;state.dynamicCalls+=pinned.dynamic;
    return {...result,source:pinned.source};
  }});
  globalThis[stateKey]=state;
  return state;
}
