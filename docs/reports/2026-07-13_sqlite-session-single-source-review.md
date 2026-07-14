# 会话双表示一致性评审

- 日期：2026-07-13
- 分支：`codex/stable-foundation-hardening`
- 状态：已修复并完成完整回归与打包启动测试

## 结论

JSONL 已退出日常读写，但会话仍有两份独立内容：

- `session_messages` 保存界面看到的消息；
- `agent_transcript_messages` 保存模型上下文。

初次实现中，两张表在不同时间、不同事务中写入。只要后端在两个写入点之间退出，界面历史和模型上下文就会不一致。当时只是把第二份数据从 JSONL 搬进 SQLite，还没有形成一个会话真相。

老 JSONL 也没有立即删除。首次导入成功后会改名为 `.migrated`，作为旧数据备份留在磁盘；运行时不会再读写它。

优化后的决定是保留两种结果，但不保留两个真相：`session_messages` 是人类查看的权威历史，Agent transcript 是带基线版本、可以重建的模型投影。

## 修复结果

- 新增 `agent_transcript_state`，记录投影对应的权威历史序号和 revision。
- Agent 开始前核对基线；发现后端退出造成投影落后时，从权威历史重建。
- Agent 正常完成时，运行状态和投影基线在同一事务中提交。
- 同一会话的 Agent、压缩和删除通过会话锁串行执行。
- 删除会话会清理界面消息、运行记录、待处理输入、Agent 投影和投影状态。
- 压缩标记只供界面显示，不参与 Agent 投影重建。
- 新增投影修复、压缩并发和完整删除回归测试。

## 初次评审发现的问题

### P1：界面消息与模型上下文仍会在退出后分叉

证据：

- `server/src/app/chat/agent_chat.js:29` 先把用户消息写入 `session_messages`。
- `server/src/engine/agents/workspace_agent.js:278` 到 `285` 稍后才把 Agent 消息追加到 `agent_transcript_messages`。
- `server/src/app/chat/agent_chat.js:122` 到 `129` 又在 Agent 完成后单独写界面助手消息。
- `server/src/engine/agents/sessionStore.js:74` 到 `90` 只要模型 transcript 非空，就直接采用它，不会与界面消息核对。

已复现：先保留两条模型 transcript，再只写一条新的界面用户消息，模拟后端在 transcript 刷盘前退出。重新读取后，界面有新消息，但模型 transcript 不包含它。

影响：用户能看到自己上一条问题，但下一轮模型不知道这条问题；反方向退出窗口也可能让模型保留一条界面没有显示的助手回复。

建议：建立一份真正的会话事件表作为唯一真相。界面消息和模型消息应从同一事件生成，或至少通过 `turn_id`、`run_id` 和版本号建立可核对、可恢复的投影。不能依靠“两张表都在同一个 SQLite 文件里”来保证一致。

### P1：删除会话后仍保留界面消息和运行记录

证据：

- `server/src/db.js:210` 到 `221` 只删除 `agent_transcript_messages`，然后软删 `sessions`。
- `session_messages`、`agent_runs` 和 `agent_pending_inputs` 没有删除或清空。
- `server/test/transcript-storage.test.mjs:61` 的删除测试没有预先写入界面消息和运行记录，所以没有发现残留。

已复现：删除会话后，模型 transcript 为 0 条，但界面消息仍为 1 条，运行记录仍为 1 条。

影响：用户执行“删除会话”后，对话内容仍保存在 `local.db`。如果这是为了回收站，需要提供恢复入口和保留期限；如果删除表示真正清理，就必须清理全部会话内容。

另外，`server/src/app/session/index.js:128` 在数据库事务提交后才同步删除旧文件。文件删除失败时接口会报错，但数据库里的会话已经删除，之后也无法通过同一个接口重试清理。

### P1：压缩会覆盖压缩期间刚追加的消息

证据：

- `server/src/engine/agents/workspace_agent.js:61` 先读取完整 transcript，`75` 再整份重写。
- `server/src/db.js:182` 到 `197` 的重写事务只能保证“删除加插入”自身原子，不能保护读取到重写之间的窗口。
- `renderer/src/views/agent/AgentConversation.tsx:1401` 到 `1424` 执行 `/compact` 时没有检查 `busy`。
- Server 也没有拒绝正在运行会话的压缩请求。

已复现：压缩读取旧快照后追加一条新消息，再用旧快照重写，新增消息被删除。

建议：压缩必须带 `expected_revision`，只在 transcript 版本未变化时提交；或者对同一会话串行执行 Agent、压缩、删除和导入操作。

### P1：Server 没有限制同一会话只能运行一个 Agent

`agent_runs` 没有“同一会话只能有一个 running”的约束，`agentChat` 也没有会话锁。Renderer 通常会用 `busy` 和队列避免重复发送，但 IPC/HTTP、恢复重试或界面竞态仍可发起两个请求。

两个 Agent 会从相同旧上下文开始，各自生成结果，再按完成顺序追加到一条线性 transcript。单次追加事务不会报错，但最终顺序不代表真实因果关系。

建议：Server 为每个 `session_id` 增加运行锁，并在数据库层增加可验证的运行状态约束。压缩和删除也要使用同一把会话锁。

### P2：旧 JSONL 是改名保留，不是删除

`server/src/engine/agents/sessionStore.js:66` 到 `70` 会把成功导入的文件改成 `.migrated`。这是合理的升级保护，但需要明确保留策略：

- 保留多久；
- 用户在哪里看到并清理；
- 数据目录改名或应用改品牌后，如何继续找到旧目录；
- 损坏行只写控制台警告时，如何让用户知道需要手工恢复。

所以准确说法应是：“JSONL 不再是运行时数据源，旧文件暂时作为迁移备份保留”，不能说“JSON 已经去掉”。

## 初次实现已通过的部分

- `agent_transcript_messages` 有会话外键、严格递增主键和 JSON 有效性检查。
- transcript 追加和整份替换使用 `BEGIN IMMEDIATE`，单次写入失败会完整回滚。
- 老 JSONL 在 SQLite 写入成功后才改名，不会先删旧文件。
- 导出接口能从 SQLite 生成 JSONL。
- 相关 8 个现有测试通过。

这些只能证明单个存储操作可靠，不能证明两种会话表示在退出和并发情况下保持一致。后续修复已补上基线检查、自动恢复和会话锁。

## 建议修正顺序

1. 先确定唯一真相的数据模型，建议使用会话事件表，界面和模型上下文都从它生成。
2. 增加同一会话运行锁，Agent、压缩、删除、迁移必须串行。
3. 补后端退出窗口的恢复检查，并为每轮增加 `turn_id`、`run_id` 和版本号。
4. 明确删除是回收站还是彻底删除，并覆盖消息、运行记录、待处理输入和迁移文件。
5. 增加四类回归：两个写入点之间退出、压缩与追加并发、同会话双请求、旧文件删除失败。
6. 上述测试通过后，再把规格中的“会话双表示一致性”标记为完成。

## 验证记录

```text
初次相关测试：8 passed, 0 failed
退出窗口复现：uiCount=1, transcriptCount=2, transcriptHasNew=false
删除残留复现：uiMessages=1, runs=1, transcript=0
压缩竞态复现：newMessageSurvived=false

修复后根项目检查：passed
Server：37 passed, 0 failed
Renderer：15 passed, 0 failed
Electron：10 passed, 0 failed
扩展示例：2 passed, 0 failed
macOS arm64 目录打包：passed
打包应用、后端 IPC、better-sqlite3 与 SQLite 启动探针：passed
```
