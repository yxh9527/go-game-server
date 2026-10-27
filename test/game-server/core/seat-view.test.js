import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSeatMessage, restoreSeatRequest, needsSeatViewRefresh } from '../../../game-server/src/core/seat-view.js';

for (const gameId of ['zjh', 'niuniu']) {
  test(`${gameId}: sparse spectator seats and all position pushes use the same projection`, () => {
    const table = { kind: 'normal', gameId, agentId: 1, roomId: 1, roomRules: { maxPeople: 7 },
      members: [{ uid: 11, pos: 2, point: 1000 }, { uid: 12, pos: 6, point: 1000 }] };
    const session = { userId: 99 };
    const original = structuredClone(table);
    const info = { memberList: Array.from({ length: 7 }, (_, pos) => ({ pos,
      userInfo: table.members.find(m => m.pos === pos) && { uid: table.members.find(m => m.pos === pos).uid } })),
      OBmemberList: [{ uid: 99 }], currentInning: 3 };
    const mapped = projectSeatMessage(table, session, 2206, info);
    assert.equal(mapped.memberList[0].userInfo.uid, 11);
    assert.deepEqual(mapped.memberList.map(m => m.pos), [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(mapped.OBmemberList, info.OBmemberList);
    assert.ok(!mapped.memberList.some(m => m.userInfo?.uid === 99));
    for (const id of [2202, 3741]) assert.equal(projectSeatMessage(table, session, id, { uid: 12, pos: 6 }).pos, 4);
    for (const id of [3606, 3610, 3732]) {
      const cards = [{ uid: 11, pos: 2, cardList: [] }, { uid: 12, pos: 6, cardList: [] }];
      assert.deepEqual(projectSeatMessage(table, session, id, cards).map(m => m.pos), [0, 4]);
      assert.deepEqual(cards.map(m => m.pos), [2, 6]);
    }
    assert.equal(projectSeatMessage(table, session, 3731, { bankerId: 12, bankerPos: 6 }).bankerPos, 4);
    const snapshot = { memberDeskInfos: [{ uid: 11, pos: 2, handPais: [] }, { uid: 12, pos: 6, handPais: [] }], uidList: [11, 12] };
    const projected = projectSeatMessage(table, session, 3260, snapshot);
    assert.deepEqual(projected.memberDeskInfos.map(m => m.pos), [0, 4]);
    assert.deepEqual(projected.uidList, [11, 12]);
    assert.deepEqual(projected.memberDeskInfos.map(m => m.handPais), [[], []]);
    for (let pos = 0; pos < 7; pos++) {
      assert.equal(restoreSeatRequest(table, session, 5003, { position: pos }).position, (pos + 2) % 7);
    }
    assert.equal(restoreSeatRequest(table, session, 5003, { position: -1 }).position, -1);
    assert.deepEqual(table, original, 'projection never mutates real seats or hand records');
    assert.equal(info.memberList[2].pos, 2);
    const history = { playBackList: [{ pos: 6 }] };
    assert.equal(projectSeatMessage(table, session, 3746, history), history, 'history is not a live seat protocol');
  });

  test(`${gameId}: views stay stable during hand/sit/stand and re-anchor between hands`, () => {
    const table = { kind: 'normal', gameId, roomId: 1, roomRules: { maxPeople: 7 },
      members: [{ uid: 11, pos: 2, point: 1000 }, { uid: 12, pos: 6, point: 1000 }] };
    const session = { userId: 99 };
    projectSeatMessage(table, session, 2206, {});
    table.hand = { players: table.members };
    table.members = table.members.slice(1);
    assert.equal(needsSeatViewRefresh(table, session), false, 'mid-hand departure cannot move remaining cards');
    projectSeatMessage(table, session, 2206, {});
    assert.equal(projectSeatMessage(table, session, 3260, { memberDeskInfos: [{ pos: 6 }] }).memberDeskInfos[0].pos, 4);
    table.hand = null;
    assert.equal(needsSeatViewRefresh(table, session), true);
    projectSeatMessage(table, session, 2206, {});
    assert.equal(projectSeatMessage(table, session, 2202, { pos: 6 }).pos, 0);
    table.members.push({ uid: 99, pos: 1, point: 0, carryDeadline: 100 });
    projectSeatMessage(table, session, 2206, {});
    assert.equal(session.seatView.offset, 6, 'explicit sit and carry keep the established coordinates');
    table.members.pop();
    const other = { userId: 100, seatView: { key: `0/${gameId}/1`, offset: 2 } };
    assert.equal(projectSeatMessage(table, other, 2202, { pos: 6 }).pos, 4);
    assert.equal(projectSeatMessage(table, session, 2202, { pos: 6 }).pos, 0);
    const fresh = { userId: 101 };
    table.hand = { players: table.members };
    projectSeatMessage(table, fresh, 2206, {});
    assert.equal(fresh.seatView.offset, 6, 'mid-hand spectator entry anchors to a real player');
    const differentRoom = { ...table, roomId: 2, members: [{ uid: 13, pos: 3, point: 1000 }], hand: null };
    projectSeatMessage(differentRoom, session, 2206, {});
    assert.equal(session.seatView.offset, 3, 'room identity isolates old view state');
  });
}

test('seat projection leaves other games untouched', () => {
  const table = { kind: 'normal', gameId: 'holdem' }, session = { userId: 99 };
  const payload = { memberList: [{ uid: 11, pos: 2 }] };
  assert.equal(projectSeatMessage(table, session, 2206, payload), payload);
  assert.equal(restoreSeatRequest(table, session, 5003, { position: 2 }).position, 2);
  assert.equal(needsSeatViewRefresh(table, session), false);
});
