import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {parse} from 'acorn';

const root=fileURLToPath(new URL('../',import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const parseModule=source=>parse(source,{ecmaVersion:'latest',sourceType:'module'});
const property=(node,name)=>node?.properties?.find(item=>item.type==='Property'&&(item.key.name??item.key.value)===name);
const proxyText='{"^/gogame-match":{target:process.env.VUE_APP_MATCH_PROXY||"http://127.0.0.1:11040",changeOrigin:true,pathRewrite:{"^/gogame-match":""}}';

export function buildAdminIntegration({target='D:/project/gogames',output=path.join(root,'doc/待应用/比赛后台菜单')}={}){
  target=fs.realpathSync(target);output=path.resolve(output);
  const component=fs.readFileSync(path.join(root,'admin/integrations/MatchManagement.vue'));
  const files=[],contents=new Map();
  function add(file,content){
    const destination=path.join(target,file),old=fs.existsSync(destination)?fs.readFileSync(destination):null;
    const bytes=Buffer.from(content);
    files.push({path:file,before:old?digest(old):null,after:digest(bytes)});contents.set(file,bytes);
  }
  for(const platform of ['NewAdminclient','adminagent']){
    const routes=platform==='NewAdminclient'?'src/router/routes.js':'src/router/routers.js';
    const componentPath=platform==='NewAdminclient'?'src/views/gogame-match/MatchManagement.vue':'src/view/gogame-match/MatchManagement.vue';
    const routeFile=platform+'/'+routes;
    let source=fs.readFileSync(path.join(target,routeFile),'utf8');
    const exported=parseModule(source).body.find(node=>node.type==='ExportDefaultDeclaration')?.declaration;
    if(exported?.type!=='ArrayExpression')throw Error('Expected explicit frontend routes: '+routeFile);
    if(source.includes('gogame-match'))throw Error('Match route already present; review existing integration: '+routeFile);
    const route={path:platform==='NewAdminclient'?'match-management':'/match-management',name:'gogame-match',meta:{title:'比赛管理',notCache:true,...(platform==='NewAdminclient'?{access:['administrator','operation']}:{icon:'md-trophy'})}};
    const definition=JSON.stringify(route).slice(0,-1)+',component:()=>import('+JSON.stringify('@/'+componentPath.slice(4))+')}';
    let at,insertion;
    if(platform==='NewAdminclient'){
      const main=exported.elements.find(node=>property(node,'path')?.value?.value==='/');
      const children=property(main,'children')?.value;
      if(children?.type!=='ArrayExpression')throw Error('Main frontend menu not found');
      at=children.start+1;insertion='\n'+definition+',';
    }else{
      at=exported.start+1;
      insertion='\n{path:"/match-management-menu",name:"gogame-match-menu",component:Main,meta:{title:"比赛管理",icon:"md-trophy"},children:['+definition+']},';
    }
    source=source.slice(0,at)+insertion+source.slice(at);parseModule(source);add(routeFile,source);
    add(platform+'/'+componentPath,component);
    const configFile=platform+'/vue.config.js';source=fs.readFileSync(path.join(target,configFile),'utf8');
    const assignment=parseModule(source).body.find(node=>node.type==='ExpressionStatement'&&node.expression.type==='AssignmentExpression'&&source.slice(node.expression.left.start,node.expression.left.end)==='module.exports')?.expression.right;
    const proxy=property(property(assignment,'devServer')?.value,'proxy')?.value;
    if(!proxy)throw Error('Frontend development proxy not found: '+configFile);
    if(source.includes('^/gogame-match'))throw Error('Match proxy already present; review existing integration: '+configFile);
    if(proxy.type==='ObjectExpression'){
      const insertion=proxyText.slice(1)+',';
      source=source.slice(0,proxy.start+1)+insertion+source.slice(proxy.start+1);
    }else if(proxy.type==='Literal'&&typeof proxy.value==='string'){
      const replacement=proxyText+',"/api":{target:'+JSON.stringify(proxy.value)+',changeOrigin:true}}';
      source=source.slice(0,proxy.start)+replacement+source.slice(proxy.end);
    }else throw Error('Unsupported development proxy; merge explicitly: '+configFile);
    parseModule(source);add(configFile,source);
  }
  // Only publish after validating every source, preserving earlier packages
  // when an unsupported or concurrently edited input prevents preparation.
  for(const entry of files){
    const current=path.join(target,entry.path),hash=fs.existsSync(current)?digest(fs.readFileSync(current)):null;
    if(hash!==entry.before)throw Error('Frontend source changed during preparation: '+entry.path);
  }
  fs.mkdirSync(output,{recursive:true});
  for(const [file,bytes]of contents){const destination=path.join(output,'files',file);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,bytes);}
  const manifest={format:1,kind:'gogame-admin-menu',files};fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const manifest=buildAdminIntegration({target:process.argv[2]||'D:/project/gogames'});
  console.log('Prepared '+manifest.files.length+' frontend files; no backend, frontend target or database changed.');
}
