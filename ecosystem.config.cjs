const path = require('node:path');

// 四个服务的唯一默认配置入口；不再读取各服务目录的 config.yaml。
// 项目使用 ESM，PM2 配置必须使用 .cjs 后缀。
const root = __dirname;
// 生产构建会将此值改为 false，移除 PM2 开发环境入口。
const developmentEnabled = true;

// 公共内部依赖。填写主机:端口，不带 http:// 或 ws://。
const common = {
  data_center: '127.0.0.1:50051',
  // 可直接填写，也可通过 GOGAME_DATA_CENTER_TOKEN 环境变量提供；不要提交真实凭证。
  data_center_token: process.env.GOGAME_DATA_CENTER_TOKEN || '',
  redis: { host: ['172.21.211.214:6379'], user: '', pwd: '' },
  // 生产权威资金 gRPC 地址；支持原有 lottery.nodes/agents 映射。
  lottery: process.env.GOGAME_LOTTERY_ADDRESS || '',
  log: '',
};

// 浏览器使用的对外地址：最外层 nginx 的地址，不是 Node 内部监听端口。
const publicProduction = {
  // 不带 /21/0 和查询参数。
  hall_url: 'https://game.example.com',
  // 不带版本目录，大厅自动拼接；nginx 转发到 client-web:4000。
  client_url: 'https://game.example.com:8444',
  // nginx 转发到 game-server:11041，/hundred 区分第二条连接。
  game_ws_url: 'wss://game.example.com:8445',
  hundred_ws_url: 'wss://game.example.com:8445/hundred',
};
// npm run dev / PM2 --env development 使用；生产不要使用开发凭证。
const publicDevelopment = {
  hall_url: 'http://172.21.211.216:11042',
  client_url: 'http://172.21.211.216:4000',
  game_ws_url: 'ws://172.21.211.216:11041',
  hundred_ws_url: 'ws://172.21.211.216:11041/hundred',
};

const services = {
  hall: {
    // 同机 nginx 可改为 127.0.0.1；跨机器代理需监听可达的内网地址。
    server_ip: '0.0.0.0', server_port: 11042,
    // 服务间连接；hall 与 game-server/match 跨机器时改成对应内网 IP。
    game_server: '127.0.0.1:11041',
    hundred_server: '127.0.0.1:11041',
    match_server: '127.0.0.1:11040',
  },
  'client-web': {
    server_ip: '0.0.0.0',
    // 多个 worker 共用该端口；nginx 只需一个 upstream。
    client_web_port: 4000,
    // auto 按 CPU 数选择，最多 4 个；也可填 1～64，1 为单进程。
    client_web_workers: 'auto',
  },
  'game-server': {
    server_ip: '0.0.0.0', server_port: 11041,
    // 与 match 的密钥必须相同；也可以在两处填写同一随机密钥。
    match_control_secret: process.env.GOGAME_MATCH_CONTROL_SECRET || '',
    finance: {
      provider: 'lottery',
      // 全部现金玩法必须覆盖，刮刮乐使用原票务接口。
      room_types: [19, 24, 25, 26, 27, 28, 30, 31, 32, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 62],
    },
  },
  match: {
    server_ip: '0.0.0.0', server_port: 11040,
    // 原 match 配置保留项；Node 业务不使用它直连 ES，查询仍经 data-center。
    elastic: { hosts: ['http://172.21.211.214:9200'], username: 'elastic', password: '000000' },
    game_server: '127.0.0.1:11041',
    match_control_secret: process.env.GOGAME_MATCH_CONTROL_SECRET || '',
    // 独立的管理凭证，不是玩家 userToken。生产启用前必须填写。
    admin_token: process.env.GOGAME_ADMIN_TOKEN || '',
    // 可添加 { agent_id: 真实代理ID, token: '独立代理凭证' }，各凭证必须唯一。
    admin_agents: [],
    tournament_scheduler: true,
  },
};

function configuration(service, development) {
  return {
    ...common, ...services[service],
    env: development ? 'dev' : 'prod',
    wallet: development ? { mode: 'local', local_balance: 1000000 } : { mode: 'online' },
    // hall 与 client-web 使用同一组 public，避免两份地址不一致。
    ...(['hall', 'client-web'].includes(service)
      ? { public: development ? publicDevelopment : publicProduction } : {}),
  };
}

function environment(service, development) {
  return {
    NODE_ENV: development ? 'development' : 'production',
    GOGAME_ENV: development ? 'dev' : 'prod',
    IS_DEV: development ? '1' : '0',
    // PM2 将完整配置快照传给对应服务；client-web worker 继承同一快照。
    GOGAME_SERVICE_CONFIG: JSON.stringify(configuration(service, development)),
  };
}

module.exports = {
  apps: ['game-server', 'match', 'client-web', 'hall'].map(service => ({
    name: `gogame-${service}`,
    cwd: root,
    script: path.join(root, service, 'src', 'boot.js'),
    interpreter: process.execPath,
    // client-web owns its own Node cluster; PM2 manages only its primary.
    exec_mode: 'fork',
    instances: 1,
    // Business modules already hot reload without dropping resident connections.
    watch: false,
    autorestart: true,
    min_uptime: 30000,
    max_restarts: 5,
    restart_delay: 5000,
    // client-web drains requests for up to 10s; allow cluster cleanup to finish.
    kill_timeout: 15000,
    time: true,
    env: environment(service, false),
    ...(developmentEnabled ? { env_development: environment(service, true) } : {}),
  })),
};
