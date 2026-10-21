let isDevMode = true;
let rpcConfig = {};

export function loadEnv(config = {}) {
  rpcConfig = config || {};
  const raw = String(config.env || process.env.GOGAME_ENV || process.env.IS_DEV || "dev").toLowerCase();
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
