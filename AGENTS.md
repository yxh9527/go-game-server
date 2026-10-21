# gogame

后续开发必须以 `doc/开发规则.md` 为准则。实现 hall、game-server、match、管理后台或协议对接前先读该文档。与该文档冲突时以该文档为准。

hall、game-server、match、管理端使用 Node.js。表结构与默认数据在 `D:\project\gogames\app\tables\gogame`。服务进程常驻，业务模块按热更新方式替换。
