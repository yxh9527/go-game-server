import fs from 'node:fs/promises';
import yaml from 'js-yaml';
const root=new URL('../../../',import.meta.url);
for(const service of ['hall','game-server','match']){
  const file=new URL(service+'/config.yaml',root),config=yaml.load(await fs.readFile(file,'utf8'));
  if(!Object.hasOwn(config,'mysql'))continue;
  delete config.mysql;
  await fs.writeFile(file,yaml.dump(config));
}
console.log('Removed Node service MySQL configuration; credentials are not printed.');
