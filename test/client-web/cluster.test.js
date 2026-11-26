import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function launch(t, workers) {
  const directory = await fs.mkdtemp(path.join(root, '.tmp-client-cluster-'));
  const port = await freePort();
  const config = path.join(directory, 'config.yaml');
  await fs.writeFile(config, yaml.dump({ env: 'dev', server_ip: '127.0.0.1', client_web_port: port, client_web_workers: workers }));
  const child = spawn(process.execPath, ['client-web/src/boot.js', '--config', config], {
    cwd: root, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, GOGAME_ENV: 'dev', IS_DEV: '1' },
  });
  let output = '', status;
  const closed = new Promise(resolve => child.once('close', code => { status = code; resolve(code); }));
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  async function waitFor(predicate) {
    const end = Date.now() + 20000;
    while (!predicate(output)) {
      if (status !== undefined || Date.now() > end) throw new Error('Cluster did not reach expected state: ' + output);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  async function stop() {
    if (status !== undefined) return status;
    if (child.connected) child.send({ type: 'client-web:shutdown' });
    else child.kill();
    return closed;
  }
  t.after(async () => {
    await stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { child, port, waitFor, stop, closed, output: () => output };
}

test('client-web workers share one port, serve adapted resources, replace a crashed worker and exit together', { timeout: 45000 }, async t => {
  const service = await launch(t, 2);
  const readyPids = output => [...output.matchAll(/worker ready slot=\d+ pid=(\d+)/g)].map(match => Number(match[1]));
  await service.waitFor(output => readyPids(output).length === 2);
  const initial = readyPids(service.output());
  assert.equal(new Set(initial).size, 2);
  assert.ok(!initial.includes(service.child.pid));
  const origin = `http://127.0.0.1:${service.port}`;
  for (const resource of ['/2.0.1279/', '/2.0.1279/assets/main/index.88f4e.js']) {
    const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(origin + resource, { headers: { Connection: 'close' } })));
    for (const response of responses) {
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.ok(body.length > 100);
      if (resource.endsWith('/')) assert.ok(body.includes('GOGAME-DEV'));
    }
  }
  process.kill(initial[0], 'SIGKILL');
  await service.waitFor(output => readyPids(output).length === 3);
  const replacement = readyPids(service.output())[2];
  assert.ok(!initial.includes(replacement));
  assert.equal((await fetch(origin + '/2.0.1279/', { headers: { Connection: 'close' } })).status, 200);
  assert.equal(await service.stop(), 0);
  // A closed primary must also release its shared listening port.
  await assert.rejects(fetch(origin + '/', { signal: AbortSignal.timeout(2000) }));
});

test('client-web supports explicit single-process mode', { timeout: 30000 }, async t => {
  const service = await launch(t, 1);
  await service.waitFor(output => output.includes('[client-web] listening'));
  assert.ok(!service.output().includes('worker starting'));
  const response = await fetch(`http://127.0.0.1:${service.port}/2.0.1279/`);
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(await service.stop(), 0);
});

test('client-web rejects invalid worker counts before spawning or listening', { timeout: 30000 }, async t => {
  const service = await launch(t, 0);
  assert.equal(await service.closed, 1);
  assert.match(service.output(), /client_web_workers must be auto or an integer/);
  assert.ok(!service.output().includes('worker starting'));
});
