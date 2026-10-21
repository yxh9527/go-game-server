import assert from "node:assert/strict";
import test from "node:test";
import { isGameStaticHost, isHallApiPath } from "./static-proxy.js";

test("www and game-h5 hosts are the game static site", () => {
  assert.equal(isGameStaticHost("www.localhost:11042"), true);
  assert.equal(isGameStaticHost("www.zhouerbao.top"), true);
  assert.equal(isGameStaticHost("game-h5.localhost:4000"), true);
  assert.equal(isGameStaticHost("lobby.localhost:11042"), false);
  assert.equal(isGameStaticHost("localhost:11042"), false);
});

test("hall API paths stay on the hall even for www host", () => {
  assert.equal(isHallApiPath("/api/internal/v1/do?op=49"), true);
  assert.equal(isHallApiPath("/2.0.1279/assets/Holdem/index.js"), false);
});
