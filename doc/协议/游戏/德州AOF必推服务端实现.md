# 德州 AOF 必推服务端实现

日期：2026-11-11。Node game-server 复用 HoldemGame/SeatGame、原德州引擎、底池计算、机器人房间生命周期、统计及权威钱包，不复制房间、资金或机器人循环。保留工作区原修改，未重启常驻服务、提交代码、迁移数据库或访问真人资金。

## 原版规则依据

原版中文帮助贴图 static/client/2.0.1279/assets/holdemGame_zh_cn_common/native/13/130512abc.440df.png 中，aofbt_help 区域明确：无大小盲，每局所有玩家按房间固定必推筹码投入，不能超过固定额度；拿到手牌后牌局自动进行。该规则与通用 AOF“全押或弃牌”帮助不同，不能套用普通加注操作。

贴图来源由 Holdem/config.55219.json 的 layout/prefabs/gameAofBituiHelpPanel，以及中文 SpriteFrame aofbt_help 的纹理引用核对。既有抓包《德州必推游戏消息及游戏流程分析文档》确认入口模式 8、房内模式 9、固定 operation=12 下注和全员结算亮牌。

## 房间与牌局

- 大厅原四档配置 1927、121、123、1920 的入口 playMode=8 映射为房间 9；固定 aofBet 分别 100、500、5000、30000。完整房间身份保留 aofBet、秀牌、straddle 和合法零 initialBet，不混入普通或暴击桌。
- 建房前要求固定额度为正安全整数、initialBet=0、carryMin 不小于固定额度；不足一份固定额度的成员不发牌，结算后沿用公共低筹码站起规则。
- 每人每局只付一份固定额度，operation=12；刚好用完携带筹码时 operation=9。禁止再收大小盲或普通前注，机器人和真人同价。
- 自动阶段从底牌到翻牌、转牌、河牌再结算，独立 resident aofNextAt 每次 tick 最多前进一个阶段，默认每段间隔 1 秒；不使用阻塞等待或重抽循环。
- 固定投入后无行动者、不推私有下注控制。普通加注、跟注、弃牌、超时机器人动作均不能改变该自动牌局；离线也保留原已投注归属继续结算。
- 结算前才通过原 3441 广播每位参与者的 holeCardList、cardTypeInfo；进行中仅本人能收到真实底牌，旁观及其他玩家保持掩码。5 张公共牌、边池／结算、原回顾继续复用德州代码。
- room/hand 保留固定额度、牌序、公共牌、投入及下一阶段时间，业务热更新不重抽牌、不重复扣款。原现金桌 8 小时、下局站起后主动退出等公共规则不变；保险保持关闭。

资金仍由原席位 member.point 的统一拦截走 Bet、PrePay/Settlement，实际 carry token 和修订号随原动作更新。所选 Lottery 房型的同一局不另写现金 debit/credit，所有派彩确认后才投递成功结果。AOF 是 roomType=19 的一种玩法，不新增资金 gameId 映射或 Go RPC；实际正式映射、finance_level 和发布配置仍需按环境核对。

## 验证

Node 全量 1153 项通过，0 失败，日志 cache/aof-final-node-tests.log，包含剔除 test/cache 的生产包加载检查。

专项覆盖四档列表／分房、固定投入、无盲注、无普通行动控件、所有动作拒绝、自动发牌和完整亮牌、旁观与重连底牌权限、资金守恒、少筹码不发牌、重复 tick 不重复结算、热更新时间及对象保留，以及真实权威钱包适配的每席位 Bet/Settlement/carry 一致性。

原版浏览器使用临时 hall/game-server 与本机既有静态资源服务，执行 node test/browser/check-holdem-critical.mjs --aof；无修改原版 static，不重启现有进程。已通过实际大厅选 AOF、旁观入房、主动入座带入、自动固定投注、连续两局、牌面结算、回顾面板和下局站起后退出。日志 cache/aof-browser-tests.log 的 ERRORS=[]，脚本退出码 0；截图 test/browser/holdem-critical-aof-settle.png。

初次浏览器回顾测试暂停在下一手中途，直接退出被既有站起保护正确阻止；测试随后按原协议站起、完成该手再退出，最终通过，业务退出规则未放宽。

## 同轮发现的三公资金边界

全量测试随机产生三条时，三公额外奖励会从其他席位再次扣筹码，而结果 xiaZhuData 只含原下注，触发权威钱包“实际扣款与结算投注不一致”。本轮在 sgay/engine.js 把结算相对已下注后余额的实际额外负变动加入投注统计，score 和最终余额算法不变；不按 bonus 总额虚增下注。

确定性三条用例验证每人实际已付 Bet 合计与 Settlement.betAmount 一致，带入筹码／钱包余额一致，玩家总余额加原税收守恒。该修复没有改牌型、奖励倍率或税率。

上述浏览器与资金测试使用开发账户／受控权威接口，不替代正式 MySQL、Redis、真人资金和分布式部署验收。当前后端应用包只读校验仍为 0 个待应用。
