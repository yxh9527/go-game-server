import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import express from 'express';
import { parse } from 'acorn';
import { mountWeb, publicWsHost, publicHundredWsHost } from '../../hall/src/web.js';
import { browserEndpoints, clientEndpointScript } from '../../shared/client-version.js';
import { toClientMatch } from '../../hall/src/to-client.js';

const config = { game_server: '127.0.0.1:11041', public: {
  hall_url: 'http://172.21.211.216:11042', client_url: 'http://172.21.211.216:4000',
  game_ws_url: 'ws://172.21.211.216:11041', hundred_ws_url: 'ws://172.21.211.216:11041/hundred',
} };

test('one host uses configured public sockets in dev and prod without changing internal targets', () => {
  for (const mode of ['dev', 'prod']) {
    assert.equal(publicWsHost(null, config, mode), '172.21.211.216:11041');
    assert.equal(publicHundredWsHost(null, config, mode), '172.21.211.216:11041/hundred');
  }
  assert.equal(config.game_server, '127.0.0.1:11041');
  assert.equal(toClientMatch({ domain: 'internal:11041' }, { publicGameServer: 'game.example:8445' }).domain, 'game.example:8445');
  assert.deepEqual(browserEndpoints({}), {});
  for (const url of ['file:///x', 'https://u:p@host', 'http://host/path']) {
    assert.throws(() => browserEndpoints({ public: { client_url: url } }));
  }
});

test('IP hall serves configured iframe origin and keeps login parameters without redirect loops', async () => {
  const app = express();mountWeb(app, { config });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const root = await fetch(origin + '/?userId=42&token=issued%2Bvalue', { redirect: 'manual' });
    const target = new URL(root.headers.get('location'));
    assert.equal(target.origin, config.public.hall_url);
    assert.equal(target.searchParams.get('userToken'), 'issued+value');
    assert.equal((await fetch(origin + target.pathname + target.search, { redirect: 'manual' })).status, 200);
    const name = fs.readdirSync(new URL('../../static/hall/_next/static/chunks/pages/', import.meta.url)).find(name => /^_app[-.].*\.js$/.test(name));
    const response = await fetch(origin + '/_next/static/chunks/pages/' + name);
    assert.equal(response.status, 200);
    const source = await response.text();parse(source, { ecmaVersion: 'latest' });
    assert.ok(source.includes('let n=new URL("http://172.21.211.216:4000");let a=n.origin'));
    assert.ok(!source.includes('r[0]="www",n.hostname=r.join(".")'));
  } finally {
    server.closeAllConnections();await new Promise(resolve => server.close(resolve));
  }
});

test('client endpoint bridge uses hall API and respects configured ws and wss', async () => {
  for (const scheme of ['ws', 'wss']) {
    const sockets = [], calls = [];
    class Native { static OPEN = 1; constructor(...args) { sockets.push(args); } }
    function Xhr() {}
    Xhr.prototype.open = function(...args) { calls.push(args); };
    const window = { WebSocket: Native, fetch: async (...args) => calls.push(args) };
    const selected = { public: { ...config.public, game_ws_url: `${scheme}://172.21.211.216:11041`, hundred_ws_url: `${scheme}://172.21.211.216:11041/hundred` } };
    vm.runInNewContext(clientEndpointScript(selected).replace(/^<script>/, '').replace(/<\/script>$/, ''), {
      window, XMLHttpRequest: Xhr, URL, Request, location: new URL(config.public.client_url),
    });
    const socket = new window.WebSocket('wss://172.21.211.216:11041', ['game']);
    new window.WebSocket('wss://172.21.211.216:11041/hundred');
    new window.WebSocket('wss://unrelated.example/');
    assert.ok(socket instanceof Native);assert.equal(window.WebSocket.OPEN, 1);
    assert.equal(sockets[0][0], `${scheme}://172.21.211.216:11041/`);
    assert.equal(sockets[1][0], `${scheme}://172.21.211.216:11041/hundred`);
    assert.equal(sockets[2][0], 'wss://unrelated.example/');
    new Xhr().open('GET', 'https://api.pansu.xyz/internal/v1/do?op=45&token=x%2By');
    assert.equal(calls[0][1], config.public.hall_url + '/api/internal/v1/do?op=45&token=x%2By');
    await window.fetch(new Request(config.public.client_url + '/api/internal/v1/do?op=46'));
    assert.equal(calls[1][0].url, config.public.hall_url + '/api/internal/v1/do?op=46');
  }
});
