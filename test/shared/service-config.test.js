import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { loadServiceConfig } from '../../shared/rpc/env.js';
import { validateProductionFinance } from '../../shared/finance-policy.js';

const ecosystem = createRequire(import.meta.url)('../../ecosystem.config.cjs');

test('all four services read the central config in direct and PM2 startup modes', () => {
  for (const service of ['hall', 'match', 'client-web', 'game-server']) {
    const app = ecosystem.apps.find(app => app.name === `gogame-${service}`);
    const development = loadServiceConfig(service, { argv: [], environment: {} });
    const production = loadServiceConfig(service, { argv: [], environment: { GOGAME_ENV: 'prod', IS_DEV: '0' } });
    assert.equal(development.env, 'dev');
    assert.equal(development.wallet.mode, 'local');
    assert.equal(production.env, 'prod');
    assert.equal(production.wallet.mode, 'online');
    assert.equal(production.wallet.local_balance, undefined);
    assert.deepEqual(production, loadServiceConfig(service, { argv: [], environment: app.env }));
    assert.deepEqual(development, loadServiceConfig(service, { argv: [], environment: app.env_development }));
    assert.equal(app.exec_mode, 'fork');
    assert.equal(app.instances, 1);
  }
  const hall = loadServiceConfig('hall', { argv: [], environment: {} });
  const client = loadServiceConfig('client-web', { argv: [], environment: {} });
  assert.deepEqual(hall.public, client.public);
  assert.equal(client.client_web_workers, 'auto');
  assert.equal(client.client_web_port, 4000);
  hall.public.client_url = 'mutated';
  assert.notEqual(loadServiceConfig('hall', { argv: [], environment: {} }).public.client_url, 'mutated');
  validateProductionFinance(loadServiceConfig('game-server', { argv: [], environment: { GOGAME_ENV: 'prod' } }));
});

test('invalid snapshots and unknown services fail rather than silently falling back', () => {
  for (const raw of ['{broken', 'null', '[]', '"config"']) {
    assert.throws(() => loadServiceConfig('hall', { argv: [], environment: { GOGAME_SERVICE_CONFIG: raw } }));
  }
  assert.throws(() => loadServiceConfig('unknown'), /Unknown service/);
  assert.throws(() => loadServiceConfig('hall', { argv: ['--config'], environment: {} }), /requires a file path/);
});
