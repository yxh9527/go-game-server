# 测试

全部自动化测试集中在此，目录对应业务服务，不再混在 src 内。

- 全量：npm test
- 某服务：npm test --workspace=game-server（hall、match、client-web 同理）
- 结构及生产隔离：node test/run.js structure
- 浏览器退出回归：node test/browser/check-hall-return.mjs <Chromium 可执行文件路径>

测试启动器递归发现 *.test.js，工作目录统一为仓库根目录。测试依赖 cache 的本地模拟实现和 static 的原始客户端资源。test/ 不进入生产包。
