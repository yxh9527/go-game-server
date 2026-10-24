# 本地开发实现

此目录是需提交的开发源代码，不是可随时删除的缓存数据。生产包排除此目录。

- rpc/：内存鉴权、余额、配置种子、比赛存储和 Redis/PubSub 替代接口。
- wallet/：独立 LocalWallet 与本地会话兜底。
- holdem/：本地内存牌局回顾的存储、列表与详情序列化。
- game-server/、hall/：本地回顾 HTTP 接口及大厅调用端。
- client-web/、hall/：本地页面调试补丁。
- dev.js：npm run dev 的开发启动器。

生产业务通过 dev 条件按需载入这些模块。业务房间、排行榜、旁观列表和正式 Redis 缓存保留在原服务中。新建本地模拟接口放在这里，不要散落到业务 src。
