// Manual build verification against the installed frontend toolchains. All
// copies, loader caches and build outputs stay in a new workspace cache dir.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';

const root=fileURLToPath(new URL('../../',import.meta.url));
if(process.argv[2]==='--child'){
  const directory=process.argv[3];process.chdir(directory);process.env.NODE_ENV='production';
  const req=createRequire(pathToFileURL(path.join(directory,'package.json')));
  const Service=req('@vue/cli-service/lib/Service.js');
  await new Service(directory).run('build',{dest:path.join(directory,'verified-output')});
}else{
  const target=fs.realpathSync(process.argv[2]||'D:/project/gogames');
  const bundle=path.join(root,'doc/待应用/比赛后台菜单');
  const manifest=JSON.parse(fs.readFileSync(path.join(bundle,'manifest.json'),'utf8'));
  const isolated=fs.mkdtempSync(path.join(root,'cache','admin-menu-build-'));
  console.log('Isolated build directory: '+isolated);
  for(const platform of ['NewAdminclient','adminagent']){
    const source=path.join(target,platform),destination=path.join(isolated,platform);
    fs.cpSync(source,destination,{recursive:true,filter:file=>{
      const relative=path.relative(source,file),parts=relative.split(path.sep);
      return !parts.some(part=>['node_modules','.git','dist','web-agent','web-admin','coverage'].includes(part))&&!/\.(log|zip)$/.test(file);
    }});
    for(const entry of manifest.files.filter(entry=>entry.path.startsWith(platform+'/'))){
      const file=path.join(isolated,entry.path);fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(path.join(bundle,'files',entry.path),file);
    }
    // Dependency junction is read-only in use; disable webpack's global cache
    // and put Babel's cache beside the isolated source instead.
    fs.symlinkSync(path.join(source,'node_modules'),path.join(destination,'node_modules'),'junction');
    const config=path.join(destination,'vue.config.js');
    fs.appendFileSync(config,'\nconst verificationChain=module.exports.chainWebpack;module.exports.chainWebpack=function(config){if(verificationChain)verificationChain(config);config.cache(false);if(config.module.rules.has("js")&&config.module.rule("js").uses.has("babel-loader"))config.module.rule("js").use("babel-loader").tap(options=>({...options,cacheDirectory:require("path").join(__dirname,"verification-cache")}));};\n');
    const result=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--child',destination],{cwd:destination,stdio:'inherit',timeout:240000,windowsHide:true,
      env:{...process.env,NODE_ENV:'production',VUE_CLI_SKIP_WRITE:'true',BABEL_CACHE_PATH:path.join(destination,'babel-verification-cache.json')}});
    if(result.error)throw result.error;if(result.status!==0)throw Error(platform+' isolated frontend build failed: '+result.status);
    console.log(platform+': full isolated production build passed');
  }
}
