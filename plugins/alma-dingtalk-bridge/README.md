# DingTalk Bridge for Alma

钉钉 Stream 机器人消息 → Alma agent → 钉钉回复。插件 ID 固定为 `alma-dingtalk-bridge`。

## 安全默认值与首次配置

插件默认拒绝未经授权的消息。**用户白名单为空时不开放服务**；所有钉钉命令也先鉴权。

1. 配置 `clientId`（AppKey）和可选的 `robotCode`。
2. 在 Alma 命令面板执行「钉钉桥接：设置安全密钥」，在密码框输入 AppSecret。
3. 配置 `allowedStaffIds`：可信用户 ID，逗号分隔。`nick:` 占位身份永不授权。外部用户必须有事件提供的实际 ID 并显式列入名单。
4. 群聊额外配置 `allowedConversationIds`：群的完整 conversationId。空名单拒绝所有群；私聊仍受用户白名单约束。
5. `adminStaffIds` 指定可以使用 `/use`、`/new`、`/allow`、`/deny`、`/access` 的管理员。管理员的普通消息和命令同时受上述两层白名单约束；唯一的首次开群例外是已在用户白名单中的管理员发送 `/allow group`。不会隐式把全部允许用户当管理员。

AppSecret 只从 `context.storage.secrets` 读取。系统 `safeStorage` 加密不可用时拒绝启动，因为当前宿主的 secrets 后端会在此情况下回退到明文。旧普通设置的 `clientSecret` 仅用于一次性迁移：写入安全存储并回读相等后，清空旧普通设置；任一步失败均不启用明文凭据。清空当前设置不等于擦除旧备份或数据库历史。

这里使用的是**插件专属密钥存储**，不是设置页中通过 `alma secret set/list/rm` 管理、注入 Agent 命令环境变量的密钥库；两者不自动同步。更新 AppSecret 请使用插件的「设置安全密钥」命令。

manifest 的 `settings:write` 用于清空旧凭据以及管理员授权命令修改白名单，不用于 `/use`；`/use` 始终使用 `storage.local` 会话覆盖。无效的 `storage:secrets` 权限已移除。独立 `cmd/send.mjs` 已停用，不能绕过授权读取设置文件发信；使用宿主里的 `dingtalk_notify` 工具。

## 群聊与工具

`groupAgentPolicy=refuse` 是默认值：允许授权用户查询命令，但拒绝群内 agent 生成。当前未确认内部 WS 回合会执行宿主的工具拦截钩子，因此**不把提示词或未经验证的钩子当作禁用工具的保证**。旧 `noTools` 值按 `refuse` 处理。

显式设置 `fullTools` 才允许已通过用户和群白名单的成员驱动完整 agent。授权私聊可驱动完整 agent。`single` 模式会让所有授权会话共享上下文；默认 `per-chat`，避免不必要的跨群共享。

发言人 ID 来自钉钉事件，不从正文解析授权。显示名、群名、@ 文本和引用内容均为不可信展示数据，用 JSON 编码且标明来源。正文同格式的伪造身份块会被剥离。此清洗是辅助措施，不能消除所有提示注入；实际访问控制由代码执行。

`dingtalk_notify` 收件人必须在用户白名单内；不再接受「已发过消息的人」兜底。

## 安装与升级

将 `manifest.json`、`main.js` 放入 `~/.config/alma/plugins/alma-dingtalk-bridge/`，在 Alma 插件页刷新。`main.js` 已包含 npm 运行依赖；Electron 由宿主提供。授权清空旧设置所需的 `settings:write` 后检查状态栏。插件升级前须核对白名单，不能沿用旧版「空名单开放」预期。

预打包文件必须和源码一起更新；不要复制 `dashboard/data.json`、运行日志或凭据。

## 配置

所有设置键均以 `dingtalkBridge.` 开头。

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `clientId` | 空 | AppKey |
| `clientSecretSecretKey` | `dingtalk.clientSecret` | 安全存储键名，不是密钥值 |
| `robotCode` | 空 | 留空沿用 clientId |
| `robotName` | `豆豆` | 排除机器人自己的 @ 名称 |
| `allowedStaffIds` | 空 | 空则拒绝所有入站与主动发信 |
| `allowedConversationIds` | 空 | 空则拒绝所有群 |
| `adminStaffIds` | 空 | 空则无人可执行会话管理和授权管理命令 |
| `groupAgentPolicy` | `refuse` | `refuse` / `fullTools` |
| `mode` | `per-chat` | 每会话；另支持 `per-sender`、`single` |
| `almaApiPort` | `23001` | 本地内部 API 端口 |
| `defaultModel` | 空 | 跟随 Alma 默认模型 |
| `workspaceId` | 空 | 跟随默认工作区；`/use` 会话覆盖优先 |
| `streamingReply` | `false` | 累计增量缓冲发送，最多 3 次流式 flush，长消息可能产生更多分块 |
| `replyOnToolUse` | `true` | 一轮最多一次处理提示 |
| `logRawPayload` | `true` | 全量本地载荷归档；包含 webhook 等敏感字段 |

凭据及端口变更会自动重连；启动失败按 2 秒至 60 秒指数退避重试。卸载会取消重试并释放连接。群策略或白名单在消息执行前再次检查。

## 命令与状态

| 命令 | 作用 |
| --- | --- |
| `/help` | 帮助 |
| `/status` | 连接状态 |
| `/ws` | 工作区列表 |
| `/stop` | 请求停止当前生成 |
| `/new [标题]` | 管理员新建会话 |
| `/use <workspaceId>` | 管理员切换当前会话工作区 |

群里需要 @ 机器人，私聊可直接发送。点击 Alma 状态栏查看状态；命令面板另有重连、连通性自检、设置安全密钥。

## 群内授权管理

首次管理员必须在本机同时列入 `allowedStaffIds` 和 `adminStaffIds`，并授予插件 `settings:write`。没有任何「第一位发消息者自动成为管理员」的机制。

在目标群中发送：

```text
@豆豆 /allow group                 授权当前群，可在尚未开放的群执行
@豆豆 /allow @张三                 授权被提及的用户，可同时提及多人
@豆豆 /deny @张三                  撤销用户授权
@豆豆 /allow user <真实用户ID>       明确按 ID 授权
@豆豆 /deny user <真实用户ID>        明确按 ID 撤销
@豆豆 /deny group                  撤销当前群
@豆豆 /access                      查看白名单
```

「授权群」指当前 conversationId，不通过群名或 @ 文本猜群。`/allow 群`、`/allow 当前群` 与 `/allow group` 等价。

用户 @ 授权只接受钉钉结构化 `atUsers[].staffId`，排除机器人自己。若只有昵称、dingtalkId 或缺少某个目标的 staffId，整次拒绝修改并提示使用明确 ID；不推断这几个 ID 必然可互换。允许用户后会加入全局用户白名单，群仍须单独授权。

所有授权管理命令仅管理员可用；只有 `/allow group` 可作为未开放群的入口，其他授权命令必须在已授权群或管理员私聊执行。命令直接由插件处理，不调用 agent。新增管理员、撤销管理员本人的使用权限和开启 `fullTools` 必须在本机配置，不能通过这些聊天命令操作。授权群不会开启群 agent 工具。

白名单修改按顺序持久化并回读验证，重复授权幂等；权限不足或保存未确认时不报告成功。

## 并发、断线与输出

- 每个会话独立 FIFO 队列，从建线程到生成及回复收尾都串行；不同会话互不阻塞。同一 session 并发建线程会合并为一次。
- 单回合有 15 分钟绝对期限，无活动的回合也会被检测。超时先请求 `stop_generation`，通知用户并废弃旧线程映射。停止请求不等于远端已经停止；远端状态不确定时禁止复用旧线程。
- WS 断线时在途回合按失败处理，重连后优先补发待取消请求。晚到的旧线程事件不会进入新线程。队列是内存队列，进程崩溃或重启不会恢复尚未执行的消息。
- 已有线程通过 `context.chat.getThread(id)` 校验，不再每条消息拉全线程列表。
- 流式和收尾都用同一份 `turn.text`；收尾等待进行中的 flush。每块成功才推进原始文本游标，失败不归零。代码围栏跨块时自动闭合并重开，围栏补字符不计入游标。
- HTTP 超时存在远端已收、本地未确认的网络歧义，不能承诺跨网络严格恰好一次投递；失败会保留已确认游标并记录状态。内部协议漏发 text delta 时，插件无法保证回复全文完整。

## 归档与看板

原始载荷保存在 `~/Library/Logs/Alma/dingtalk-payloads-YYYY-MM-DD.jsonl`（UTC 分日），权限 `0600`，不自动删除。里面可能包含敏感 webhook、身份与消息全文；不要公开、上传或提交。

`dashboard/data.json` 是本地私密快照，已加入 `.gitignore`。看板不是持久消息数据库，不应对外开放。引用内容目前仅能从本进程收到的同会话缓存匹配（最多 500 条，每条摘要最多 500 字）；未接入远端引用查询，不据此断言平台不存在查询接口。

## 构建与验证

使用 **Bun 1.3.14**，提交 `bun.lock`。`dingtalk-stream` 的 beta 版本固定为 `2.1.6-beta.1`，直接使用的 `ws` 也显式锁定。

```bash
bun install --frozen-lockfile --ignore-scripts
bun run test:offline
bun run build
bun run check:bundle
```

`check:bundle` 在临时目录重建并与已提交的 `main.js` 逐字节比较，退出前清理自身临时文件。CI **先校验旧产物，不先覆盖 main.js**，可发现源码改了但 bundle 未更新。

仓库根目录的 `.github/workflows/dingtalk-bridge.yml` 支持仓库的 `plugins/alma-dingtalk-bridge/`、旧目录 `plugins/dingtalk-bridge/`、本工作区的 `alma-dingtalk-bridge/` 和独立插件仓库。推送到上游结构时必须把工作流放在仓库根目录；嵌套在插件目录的工作流不会生效。

离线测试包括访问控制、身份、流式、SDK 订阅及 `test/reliability.mjs`：后者用模拟传输驱动实际 `submit → dispatch → finalize`，验证三消息 FIFO、跨群并行、断线隔离、超时、发送竞争、分块失败和密钥迁移。不会使用真实钉钉或执行生产 agent。历史 E2E 脚本不在默认测试入口，不能把旧测试结果当作当前安全策略的线上验收。

## 内部协议限制

`/ws/threads` 与 `/api/*` 是 Alma 内部协议，没有兼容承诺。本地已核验版本为 Alma 0.4.357；升级后需重新验证事件格式与宿主接口。调用集中在 `lib/alma-socket.ts` 和 `lib/alma-api.ts`，保留这层边界便于迁移正式渠道 API。

当前未实现正式渠道 API、可靠的群只读工具模式、图片理解、附件回传。不能把默认拒绝群生成称为「已支持群只读聊天」。
