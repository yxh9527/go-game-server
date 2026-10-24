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
