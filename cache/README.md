# 本地开发实现

此目录同时容纳需提交的开发源代码和不提交的临时产物。生产包排除此目录。

根目录 `.gitignore` 仅保留下列开发源码目录、`dev.js` 和本文档；日志、截图、报告、Go 编译缓存及隔离后端工作副本不提交，可以在测试完成后清理。历史文档引用的 cache 日志清理后不再保留，验证结论仍记录在 doc 中。

`scripts/build-backend-integration.mjs` 需要临时的 `cache/backend-integration/gogames` 工作副本。清理后须重新准备副本再构建新的后端包；现有 `doc/待应用` 包的校验／应用不受影响。跨语言刮票测试的 Go fixture 可执行文件也需在执行前重新编译。

- rpc/：内存鉴权、余额、配置种子、比赛存储和 Redis/PubSub 替代接口。
- wallet/：独立 LocalWallet 与本地会话兜底。
- holdem/：本地内存牌局回顾的存储、列表与详情序列化。
- game-server/、hall/：本地回顾 HTTP 接口及大厅调用端。
- client-web/、hall/：本地页面调试补丁。
- dev.js：npm run dev 的开发启动器。

生产业务通过 dev 条件按需载入这些模块。业务房间、排行榜、旁观列表和正式 Redis 缓存保留在原服务中。新建本地模拟接口放在这里，不要散落到业务 src。
