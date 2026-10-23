import assert from "node:assert/strict";
import test from "node:test";
import { emptySeat, memberListSeats, publicObserver, publicSeat } from "./member.js";

test("publicSeat nests uid under userInfo", () => {
  const seat = publicSeat({ uid: 10001, name: "dev", pos: 0, point: 2000, state: 1 });
  assert.equal(seat.uid, 10001);
  assert.equal(seat.userInfo.uid, 10001);
  assert.equal(seat.userInfo.name, "dev");
  assert.match(seat.userInfo.icon, /^\/avator\/(?:10002\.jpg|900(?:0[7-9]|1\d|2[0-4])\.png)$/);
  assert.equal(seat.pos, 0);
});

test("publicObserver nests userInfo.uid", () => {
  const ob = publicObserver({ uid: 10001, name: "dev", point: 999 });
  assert.equal(ob.userInfo.uid, 10001);
  assert.equal(ob.point, 999);
});

test("memberListSeats fills empty chairs up to maxPeople", () => {
  const list = memberListSeats([
    { uid: 1, name: "a", pos: 0, point: 100, state: 1 },
  ], 3);
  assert.equal(list.length, 3);
  assert.equal(list[0].userInfo.uid, 1);
  assert.deepEqual(list[1], emptySeat(1));
  assert.deepEqual(list[2], emptySeat(2));
});
