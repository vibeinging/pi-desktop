# QueryAgent hardcode 审查

日期：2026-07-18

> 后续决策：`complete_sql` 也属于不必要的 SQL 专用完成协议，已经从新方案中删除。工具只产生证据，QueryAgent 通过 pi-agent 原生 `stop` 和最终消息完成任务。本文中把 `complete_sql` 视为保留机制的内容仅记录当时实现，不再是当前结论。最终边界见 [离线数据准备与在线问答边界](../specs/2026-07-18_offline-data-preparation-and-online-query.md)。

## 结论

本轮改动同时包含正常的机制修复和明显的题目型 hardcode。

应该保留的机制修复：WorkspaceAgent 自主委派、稳定 `source_id`、只读工作区、真实 SQL 执行和证据记录、数据源完整删除、失败原因透传、Trace 使用真实 run 时间。

应该删除或重构的写死逻辑：按中英文关键词判断聚合含义、按 `which/who/哪个` 删除数值列、生产 Trace 识别 KDD 格式提示、按 `service:` 字符串拆工具 id、用“项目是否包含结构化源”决定整个 QueryAgent 的完成方式，以及把具体 KDD/化学例子长期放进生产 system prompt。

补充确认：强制用当前 `user_message` 覆盖 WorkspaceAgent 委派的 `params.question` 也属于错误控制。当前轮次文字不一定等于结合历史上下文后的真实任务，委派内容应由 WorkspaceAgent 决定。该项已在本轮修复。

## 高风险 hardcode

### 1. 用问题关键词否决 SQL

文件：`server/src/engine/agents/query_tool_adapter.js`

当前代码识别 `lowest/highest/最低/最高`，问题中没有 `total/sum/合计` 时，只要 SQL 出现 `SUM(` 就拒绝完成。

问题：

- “哪个项目成本最低”在很多业务里本来就指每个项目的总成本。
- 中文、英文之外的语言不支持。
- 同义词、缩写和领域术语覆盖不全。
- 只用 SQL 文本搜索 `SUM(`，不知道这个 SUM 聚合的是哪个字段、在哪个子查询。
- 这条规则直接针对 task 25 的失败形态，属于题目型修补。

判定：应删除。聚合口径应来自项目规则、字段描述、已保存的口径说明；存在多种合理解释时由 Agent 调用 `ask_user`，不能由通用工具猜。

### 2. 用 `which/who/哪个` 强制删除数值列

文件：`server/src/engine/agents/query_tool_adapter.js`

当前代码在选择型问题返回多列且存在数值列时拒绝完成。

问题：用户问“哪个活动成本最低”时，同时展示活动和成本通常是合理答案；当前实现为了 KDD gold 只有一列而禁止这种输出。

判定：应删除。最终列应由显式输出契约决定。普通产品问答默认允许“对象 + 支撑数值”；只有 eval 明确要求精确列时才传入 eval 专用输出约束。

### 3. 生产 Trace 识别 KDD 提示文字

文件：`server/src/app/traces/yitrace_service.js`

当前代码用 `请按以下明确规则`、`额外格式要求` 截断 Trace 名称。

问题：评测提示泄漏进生产 Trace 服务；真实用户问题包含相同文字时会被错误截断。

判定：应删除。创建 run 时直接保存 `display_name` 或原始用户消息的首个内容块；Trace 层不解析提示内容。

### 4. 按 `service:` 字符串拆 tool id

文件：`server/src/app/traces/yitrace_service.js`

当前实现把 `service:父调用:真实调用` 按冒号切开并取最后一段。

问题：依赖内容 id 的编码格式；如果真实 tool id 自己包含冒号会被破坏。

判定：短期兼容可接受，长期应由事件显式携带 `tool_call_id`、`parent_tool_call_id` 和 `content_id`，Trace 只使用真实 `tool_call_id`。

### 5. 用 `has_structured` 决定完成协议

文件：`server/src/engine/agents/query_agent.js`

当前项目只要绑定任何结构化数据源，就要求本轮必须 `complete_sql`。混合项目里即使用户只问 Markdown 文档，也会被当成 SQL 问题。

判定：应重构。完成协议应由本轮实际使用的证据决定：执行过 SQL 就必须用 `complete_sql`；纯文档读取可以自然完成并附带文件证据；混合查询则需要 SQL 终态或统一的结果提交协议。

## 中风险写死

### 6. 生产 prompt 包含具体 KDD/化学例子

`atoms`、`molecule_id`、`phosphorus`、`bromine`、`first_name/last_name/full_name` 等例子会长期影响所有项目。

通用原则本身合理，但具体失败样例不应进入全局 prompt。应改成简短的通用规则，领域规则保存在项目 `knowledge.md` 或项目规则中。

### 7. `knowledge.md` 只注入 `query_agent`

这是 eval 代码，不影响生产，但它假设所有题都由 QueryAgent 消费。以后 DocAgent 单独运行时会再次失效。

应让 eval 根据实际路由目标注入，或把 knowledge 作为项目级上下文文件，由所有项目 Agent 按需读取。

### 8. Schema 注释长度 `300/600`

这是固定策略，不是题目型 hardcode，但属于魔法数字。它不会改变查询语义，只影响上下文大小，风险较低。建议提取成命名常量或配置项，并记录截断标记。

## 不属于 hardcode 的改动

- 本轮只读数据源清单同时展示 schema 路径和稳定 `source_id`，`execute_sql` 明确指定数据源。
- SQL 和文档工具只产生证据，不承担结束任务的职责。
- QueryAgent 用 pi-agent 原生 `stop` 和非空最终答案完成任务。
- eval 复用项目时调用真实删除接口，清理 DuckDB 文件、文档和元数据。
- QueryAgent 返回 `model_timeout`、`stop_reason`、`model_turns` 给外层。
- Trace 列表使用 `agent_runs.created_at/finished_at` 计算墙钟耗时。

## 建议重构方向

1. 删除 `validateFinalSqlContract()` 和完成工具；只读 SQL、结果可序列化、数据源授权放在执行工具中检查。
2. WorkspaceAgent 通过任务包传递答案要求，QueryAgent 自己搜索和决定查询步骤，不在运行时硬编码题型。
3. 聚合口径由项目规则和 schema 描述提供；缺少口径时 `ask_user`，不在工具层猜 `MIN` 还是 `SUM`。
4. 完成状态使用通用原生停止；SQL 和文件读取记录作为 trace 证据交给外层观察，不作为专用终止门槛。
5. Trace 事件增加独立的 `content_id`、`tool_call_id`、`parent_tool_call_id`，去掉字符串解析。
6. Trace 名称在 run 创建时持久化，不在读取阶段解析问题文字。
7. 全局 prompt 只保留通用约束，KDD 和领域样例移回 eval/project knowledge。

## 已立即修复

`query_agent_service` 不再读取父上下文的当前 `user_message` 覆盖委派参数。QueryAgent 现在只接收 WorkspaceAgent 调用 `query_project_data` 时传入的 `params.question`。工具说明也改为：WorkspaceAgent 应结合当前轮次、历史上下文和项目状态形成完整委派任务，而不是逐字复制当前消息。

## 优先级

第一优先级：删除聚合正则和列裁剪正则。它们会直接改变用户答案。

第二优先级：修正混合数据源完成条件和 Trace 的 KDD 文案识别。

第三优先级：显式化 tool id 字段、清理 prompt 样例、配置化 Schema 截断长度。
