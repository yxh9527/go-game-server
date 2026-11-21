# open-api 登录凭证传递

2026-11-21。用户明确：以 open-api 生成的 token 为准。

- open-api 继续生成 `/game?...&userId=...&token=...`，不修改签发内容。
- hall 将非空 token 原值映射到原客户端读取的 userToken；若两字段冲突，token 优先。
- 原 token 参数保留，使用 URLSearchParams 编解码，不手工拼接或改变凭证中的特殊字符。
- `/game`、带版本入口和直接 `/21/0` 入口统一处理；直接入口存在冲突时先重定向到一致参数，再输出页面。
- 只有 userToken 的既有链接继续兼容。该映射只解决参数传递，不能代替服务端鉴权，也不保证不同凭证来源实际有效。

验证：真实本机 HTTP 跳转覆盖三入口，最终均返回页面且无重定向循环；单位测试覆盖缺失别名、dev／旧别名、特殊字符及幂等转换。没有修改 open-api 签发逻辑、测试注资、生产配置或重启服务。

大厅／热更新专项11项、Node全量1625项通过，分别见 cache/open-api-token-scoped.log 和 cache/open-api-token-full-node.log。重新运行玩家流程审计脚本，loginMismatch=false；其余未修问题仍照常记录，不因本项通过而关闭。
