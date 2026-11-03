# DingTalk Bridge for Alma

钉钉 Stream 机器人消息 → Alma agent → 钉钉回复。插件 ID 固定为 `alma-dingtalk-bridge`。

## 安全默认值与首次配置

插件默认拒绝未经授权的消息。**用户白名单为空时不开放服务**；所有钉钉命令也先鉴权。

1. 配置 `clientId`（AppKey）和可选的 `robotCode`。
2. 在 Alma 命令面板执行「钉钉桥接：设置安全密钥」，在密码框输入 AppSecret。
3. 配置 `allowedUnionIds`：钉钉事件中的可信 UnionID，逗号分隔。`nick:` 占位身份永不授权。内部和外部用户都必须有事件提供的 `senderUnionId` 并显式列入名单。
4. 群聊额外配置 `allowedConversationIds`：群的完整 conversationId。空名单拒绝所有群；私聊仍受用户白名单约束。
5. `adminUnionIds` 指定可以使用 `/use`、`/new`、`/allow`、`/deny`、`/access` 的管理员。管理员的普通消息和命令同时受上述两层白名单约束；唯一的首次开群例外是已在用户白名单中的管理员发送 `/allow group`。不会隐式把全部允许用户当管理员。

AppSecret 只从 `context.storage.secrets` 读取。系统 `safeStorage` 加密不可用时拒绝启动，因为当前宿主的 secrets 后端会在此情况下回退到明文。旧普通设置的 `clientSecret` 仅用于一次性迁移：写入安全存储并回读相等后，清空旧普通设置；任一步失败均不启用明文凭据。清空当前设置不等于擦除旧备份或数据库历史。

这里使用的是**插件专属密钥存储**，不是设置页中通过 `alma secret set/list/rm` 管理、注入 Agent 命令环境变量的密钥库；两者不自动同步。更新 AppSecret 请使用插件的「设置安全密钥」命令。

manifest 的 `settings:write` 用于清空旧凭据以及管理员授权命令修改白名单，不用于 `/use`；`/use` 始终使用 `storage.local` 会话覆盖。无效的 `storage:secrets` 权限已移除。独立 `cmd/send.mjs` 已停用，不能绕过授权读取设置文件发信；使用宿主里的 `dingtalk_notify` 工具。

## 群聊与工具

`groupAgentPolicy=refuse` 是默认值：允许授权用户查询命令，但拒绝群内 agent 生成。当前未确认内部 WS 回合会执行宿主的工具拦截钩子，因此**不把提示词或未经验证的钩子当作禁用工具的保证**。旧 `noTools` 值按 `refuse` 处理。

显式设置 `fullTools` 才允许已通过用户和群白名单的成员驱动完整 agent。授权私聊可驱动完整 agent。`single` 模式会让所有授权会话共享上下文；默认 `per-chat`，避免不必要的跨群共享。

发言人身份只取钉钉事件的 `senderUnionId`，不从正文解析授权。显示名、群名、@ 文本和引用内容均为不可信展示数据，用 JSON 编码且标明来源。正文同格式的伪造身份块会被剥离。此清洗是辅助措施，不能消除所有提示注入；实际访问控制由代码执行。

`dingtalk_notify` 只接收 `unionId`，先按 `allowedUnionIds` 鉴权，再用官方接口解析企业内 userId 作为投递地址；解析后再次验权。staffId/userId 不参与授权。跨组织 UnionID 可能无法解析企业内投递地址，此时主动私聊明确失败；原群内互动不需要这个转换。

## 安装与升级

将 `manifest.json`、`main.js` 放入 `~/.config/alma/plugins/alma-dingtalk-bridge/`，在 Alma 插件页刷新。`main.js` 已包含 npm 运行依赖；Electron 由宿主提供。授权清空旧设置所需的 `settings:write` 后检查状态栏。插件升级前须核对白名单，不能沿用旧版「空名单开放」预期。

预打包文件必须和源码一起更新；不要复制 `dashboard/data.json`、运行日志或凭据。

## UnionID 迁移（2.0.0）

用户和管理员鉴权均只认 UnionID；不再读取 `allowedStaffIds` / `adminStaffIds`，不回退到 `senderStaffId`、`senderId` 或昵称。旧名单不能直接改名复制：必须从同一机器人/开发者范围的真实事件核实每人的 `senderUnionId`，再写入 `allowedUnionIds` / `adminUnionIds`。无法核实时保持拒绝，不静默放行。

`/allow user <ID>` 与 `/deny user <ID>` 保留为 UnionID 命令别名，参数不再解释为 staffId；建议使用明确的 `union` 写法。群白名单仍使用 conversationId。`per-chat` 会话保持不变；旧 `per-sender` 的 staffId 会话键不会自动复用，新消息按 UnionID 建立隔离会话。

钉钉发送接口需要 userId 的场景仍保留投递地址：私聊图片使用原事件中的 senderStaffId，主动通知通过 UnionID 查询 userId；这些地址不能授予权限，也不能反向冒充 UnionID。聊天正文或群昵称不用于转换身份。

## 配置

所有设置键均以 `dingtalkBridge.` 开头。

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `clientId` | 空 | AppKey |
| `clientSecretSecretKey` | `dingtalk.clientSecret` | 安全存储键名，不是密钥值 |
| `robotCode` | 空 | 留空沿用 clientId |
| `robotName` | `豆豆` | 排除机器人自己的 @ 名称 |
| `allowedUnionIds` | 空 | 空则拒绝所有入站与主动发信 |
| `allowedConversationIds` | 空 | 空则拒绝所有群 |
| `adminUnionIds` | 空 | 空则无人可执行会话管理和授权管理命令 |
| `groupAgentPolicy` | `refuse` | `refuse` / `fullTools` |
| `mode` | `per-chat` | 每会话；另支持 `per-sender`、`single` |
| `almaApiPort` | `23001` | 本地内部 API 端口 |
| `defaultModel` | 空 | 跟随 Alma 默认模型 |
| `workspaceId` | 空 | 跟随默认工作区；`/use` 会话覆盖优先 |
| `streamingReply` | `false` | 累计增量缓冲发送，最多 3 次流式 flush，长消息可能产生更多分块 |
| `replyOnToolUse` | `true` | 一轮最多一次处理提示 |
| `logRawPayload` | `true` | 全量本地载荷归档；包含 webhook 等敏感字段 |

WebSocket 的 `text_append` 同时承载正文和推理块。插件只接纳明确标记 `partType=text` 的增量；`reasoning` 及未知类型不进入最终回复或流式缓冲，避免发送过程内容。

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

首次管理员必须在本机同时列入 `allowedUnionIds` 和 `adminUnionIds`，并授予插件 `settings:write`。没有任何「第一位发消息者自动成为管理员」的机制。

在目标群中发送：

```text
@豆豆 /allow group                 授权当前群，可在尚未开放的群执行
@豆豆 /allow @张三                 授权被提及的用户，可同时提及多人
@豆豆 /deny @张三                  撤销用户授权
@豆豆 /allow union <UnionID>        明确按 UnionID 授权
@豆豆 /deny union <UnionID>         明确按 UnionID 撤销
@豆豆 /deny group                  撤销当前群
@豆豆 /access                      查看白名单
```

「授权群」指当前 conversationId，不通过群名或 @ 文本猜群。`/allow 群`、`/allow 当前群` 与 `/allow group` 等价。

用户 @ 授权只接受钉钉结构化 `atUsers[].unionId`，排除机器人自己。若只有昵称、dingtalkId、staffId 或缺少某个目标的 unionId，整次拒绝修改并提示使用明确 UnionID；不推断这几个 ID 必然可互换。允许用户后会加入全局用户白名单，群仍须单独授权。

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

`dashboard/data.json` 是本地私密快照，已加入 `.gitignore`。看板不是持久消息数据库，不应对外开放。引用内容优先读取事件的 `text.repliedMsg.content.text`，保留正文和换行；缺失时才匹配同会话缓存（最多 500 条，每条摘要最多 500 字）。两者均无内容时明确标记引用原文缺失。未接入远端引用查询，不据此断言平台不存在查询接口。

## 生成图片回传

Agent 生成图片后调用 `alma send photo`，将图片挂到当前 Alma 线程。插件在本回合中捕获明确的 `file` 附件，读取本机图库缓存，调用钉钉媒体上传接口，再以同一个机器人向原群或原私聊发送 `sampleImageMsg`。只在收到有效 `processQueryKey` 后报告钉钉发送接口已接受，不等同于用户已读。

- 支持 PNG、JPEG、GIF、BMP，每张最多 20MB，每轮最多 4 张；同一 URL 的重复事件只发送一次。
- 仅加载当前回合的 Alma 图库附件，不扫描正文里的路径，不抓取任意 URL，不读取任意本地文件。
- 发送前以及上传后再次检查用户/群白名单和群工具策略；不会改用其它账号或其它会话。
- 收到附件后暂缓剩余流式文本，待图片发送结果确定后收尾。失败时返回错误说明，不沿用 Agent 的「图片已发送」说法；不自动重试状态不确定的发送，避免重复图片。
- `alma send` 的 “Sent photo to thread” 仅表示本机附件就绪。插件补充的钉钉发送回执才表示机器人接口已接受。
- 此能力使用应用机器人的媒体上传/发消息权限；如钉钉拒绝权限或群目标，必须按实际错误处理。一般文件、音频和视频附件暂不支持。

接口依据：[图片模板与 mediaId](https://open.dingtalk.com/document/development/robot-message-type.md)、[上传媒体文件](https://open.dingtalk.com/document/development/upload-media-files.md)、[机器人群消息](https://open.dingtalk.com/document/development/the-robot-sends-a-group-message.md)。

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

当前未实现正式渠道 API、可靠的群只读工具模式、图片理解和通用文件附件回传。不能把默认拒绝群生成称为「已支持群只读聊天」。
