import test from 'node:test';
import assert from 'node:assert/strict';
import {adminMatch} from '../../match/src/admin-match.js';
import {lateRegistrationOpen} from '../../shared/tournament-registration.js';

test('admin late signup projection honors level, shifted deadline, and paused state',()=>{
 const row={state:2,start_time:100000,delay_register_time:120,delay_register_level:2};
 const state={clock:{currentBlindLv:2,nextBlindAt:400000,registrationDelayMs:100000}};
 assert.equal(adminMatch(row,state,300000).admin.lateOpen,true);
 assert.equal(adminMatch(row,state,300000).admin.lateDeadline,320000);
 assert.equal(lateRegistrationOpen(row,state.clock,320000),false);
 state.clock.pauseRequested=true;assert.equal(adminMatch(row,state,300000).admin.lateOpen,false);
 state.clock.pauseRequested=false;state.clock.currentBlindLv=3;assert.equal(adminMatch(row,state,300000).admin.lateOpen,false);
});
