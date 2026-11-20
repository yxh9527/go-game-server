import test from 'node:test';
import assert from 'node:assert/strict';
import {databaseConfigPatch} from '../../scripts/rename-backend-databases.mjs';

test('database name patch preserves credentials, comments and all unrelated YAML fields',()=>{
 const source='redis:\r\n  host: [127.0.0.1:6379]\r\nmysql:\r\n  player:\r\n    database: "fg_player" # player store\r\n    password: "literal:secret"\r\n  manager:\r\n    database: \'fg_web_manager\'\r\n    user: service\r\nelastic:\r\n  hosts: [http://localhost:9200]\r\n';
 const result=databaseConfigPatch(source);
 assert.equal(result.content,source.replace('"fg_player"','"go_player"').replace("'fg_web_manager'","'go_manager'"));
 assert.deepEqual(result.after,{manager:'go_manager',player:'go_player'});
 assert.equal(databaseConfigPatch(result.content).content,result.content);
 assert.throws(()=>databaseConfigPatch(source.replace('fg_player','another_project')),/review/);
 assert.throws(()=>databaseConfigPatch(source.replace('    database:','     database:')),/scalar|YAML/);
});
