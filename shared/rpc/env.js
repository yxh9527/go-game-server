import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const ecosystemFile = fileURLToPath(new URL('../../ecosystem.config.cjs', import.meta.url));

// Startup-only configuration: PM2 snapshot first, otherwise the central file.
// --config retains explicit legacy YAML support for external tools and fixtures.
export function loadServiceConfig(service, { argv = process.argv, environment = process.env } = {}) {
  if (!['hall', 'match', 'client-web', 'game-server'].includes(service)) throw new Error('Unknown service: ' + service);
  const index = argv.indexOf('--config');
  let config;
  if (index >= 0) {
    const file = argv[index + 1];
    if (!file) throw new Error('--config requires a file path');
    config = yaml.load(fs.readFileSync(path.resolve(file), 'utf8'));
  } else if (environment.GOGAME_SERVICE_CONFIG) {
    config = JSON.parse(environment.GOGAME_SERVICE_CONFIG);
  } else {
    const app = require(ecosystemFile).apps.find(app => app.name === `gogame-${service}`);
    const mode = String(environment.GOGAME_ENV || environment.NODE_ENV || '').toLowerCase();
    const production = environment.IS_DEV === '0' || environment.IS_DEV !== '1' && ['prod', 'production', 'online', '0'].includes(mode);
    const selected = production ? app.env : app.env_development || app.env;
    config = JSON.parse(selected.GOGAME_SERVICE_CONFIG);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid service configuration');
  return config;
}

let isDevMode = true;
let rpcConfig = {};
loadEnv();

export function loadEnv(config = {}) {
  rpcConfig = config || {};
  const raw = String(process.env.GOGAME_ENV || config.env || process.env.IS_DEV || process.env.NODE_ENV || "dev").toLowerCase();
  isDevMode = raw !== "prod" && raw !== "production" && raw !== "online" && raw !== "0";
  if (raw === "0" || raw === "false") {
    isDevMode = false;
  }
  if (process.env.IS_DEV === "1") {
    isDevMode = true;
  }
  if (process.env.IS_DEV === "0") {
    isDevMode = false;
  }
}

export const env = {
  get isDev() {
    return isDevMode;
  },
  get config() {
    return rpcConfig;
  },
};
