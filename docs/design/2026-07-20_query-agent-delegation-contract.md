# QueryAgent 委派契约优化

日期：2026-07-20

## 当前问题

`smart_query` 是 service runtime Skill。WorkspaceAgent 调用 `query_project_data` 时，先由 WorkspaceAgent 生成：

- `question`
- `resolved_context`
- `answer_requirements`
- `source_hints`
- `presentation_hint`

服务层把这些参数拼成 `delegatedTask`，然后创建 QueryAgent。嵌入模式下 QueryAgent 不加载父会话历史，子上下文里的 `user_message` 和 `enhanced_user_query` 都等于 `delegatedTask`，`session_context` 为空。

因此 QueryAgent 看不到用于核对的父会话。WorkspaceAgent 一旦把完整问题缩成“先看 schema”，QueryAgent 无法知道后面还有统计任务。

同时，service Skill 原先把 QueryAgent 的答案放进 `finalAnswer`，触发 `handoff.kind=final`。QueryAgent 的自然答案会直接结束父 Agent 本轮，WorkspaceAgent 无法判断原始意图是否完成，也无法继续第二次查询。

## 不采用的方案

### 用当前轮 user_message 覆盖 params.question

不采用。当前轮消息可能只是“继续”“按刚才口径”或补充条件，不一定是完整真实意图。这样会破坏 WorkspaceAgent 结合历史解决指代的能力。

### 用字符串规则判断委派任务是否完整

不采用。检查是否包含“schema”“查询”等词无法判断任务是否完整，容易形成新的 hardcode。

## 已采用方案

### 基础 Agent 的判断标准

对照项目内 vendored pi-agent 的 `agent-loop.ts` 后，WorkspaceAgent 不应该被限制成“只能原样转发数据”。基础 loop 的真实规则是：

1. assistant 发起工具调用；
2. 工具输出以 `toolResult` 消息回到同一个 Agent 上下文；
3. Agent 可以继续推理、再次调用工具，或生成自然语言回答；
4. 只有外层 assistant 以 `stop` 结束的消息，才是这一层的最终回答。

因此需要约束的是事实完整性和终态归属，不是禁止父 Agent 改变展示。WorkspaceAgent 可以根据用户意图做重命名、排序、汇总、转置、合并和解释；但每项变化都必须能从工具证据推导，不能无依据改变数值、单位、列含义或记录数量。

### 1. WorkspaceAgent 托管 QueryAgent

QueryAgent 定位为 WorkspaceAgent 托管的叶子执行器：

- WorkspaceAgent 结合当前轮、历史和项目状态，决定本次委派的数据查询任务。
- QueryAgent 在自己的 loop 内完成 schema 查找、SQL、跨源处理和结果说明。
- QueryAgent 返回 `status`、`answer`、`answer_table`、`result_views`、`evidence`、`sources`、`artifacts`、模型和停止原因。
- QueryAgent 的 `completed` 只是工具执行完成，不再触发父 Agent 的 final handoff。
- WorkspaceAgent 收到结果后继续运行，核对原始用户意图是否已经满足；不满足时继续调用 QueryAgent 或其他工具。
- 最终由 WorkspaceAgent 结束本轮并回答用户。

### 2. 不再把叶子完成等同于父任务完成

service 仍使用通用的 `createServiceToolResult`，但 QueryAgent 路径不再传入：

- `finalAnswer`
- `handoffReceipt`
- final handoff 的 source 信息

只有 QueryAgent 需要用户补充输入时，才保留 `terminate`，让已有的暂停/恢复流程继续生效。

### 3. WorkspaceAgent 的完成责任

WorkspaceAgent system prompt 和 Skill 契约明确要求：

- 不能因为 QueryAgent 返回 `completed` 就认为原始任务完成。
- 如果结果只包含 schema、字段定位或部分计算，必须继续执行。
- 必须结合父会话中的原始意图判断完成状态。
- 最终答案由 WorkspaceAgent 组织。它可以按用户意图调整展示形态，但不得无证据改变 QueryAgent 已确认的数值、单位、列含义和记录。

### 4. 子 Agent 展示块不是父任务终答

QueryAgent 内部的 `format_result` 仍可以生成表格、图表等展示块，但这些块进入父会话时统一标记为 `tool_result`，并保留：

- `parent_tool_call_id`
- `child_msg_category`
- `child_final=true`

这样前端仍可展示和保存叶子工件，但 trace、评测器和父 Agent 不会把它误认成 WorkspaceAgent 的最终回答。

### 5. 工具结果增加机器可读证据

不恢复 `complete_sql`，也不新增人工完成工具。QueryAgent 继续通过 pi-agent 的自然停机结束。

服务边界增加两个只读证据字段：

- `answer_table`：从 QueryAgent 最终自然答案里的最后一个 Markdown 表格确定性解析；
- `result_views`：从 QueryAgent 实际生成的最终表格展示块中提取列、行、总行数和截断状态。

WorkspaceAgent 同时拿到自然语言和结构化证据，既能像基础 Agent 一样继续推理，也不需要重新猜测一行两列之类的数据形态。

### 6. 可查询状态与离线增强状态分开

结构化数据源清单不再把后台描述增强写成 `content_status=preparing`：

- `raw_status` 表示原始数据库能否查询；
- `content_status` 表示 Schema 快照是否 ready/stale/missing；
- `enrichment_status` 单独表示描述、样例等增强进度。

增强失败或仍在运行时，只要原始库和 Schema 可用，QueryAgent 仍应继续查询。

## 后续优化

### 双通道输入

当前改动先恢复父 Agent 托管。后续可以让 QueryAgent 同时接收：

1. WorkspaceAgent 生成的 `delegated_goal`。
2. 框架直接提供的只读 `conversation_evidence`。

这两者必须分开，不能用当前轮 user message 覆盖 WorkspaceAgent 判断出的任务。会话证据只用于核对指代、口径和遗漏。

### 数据源提示不能成为边界

`source_hints` 改为明确的“优先检查来源”：

- 不确定时省略。
- QueryAgent 发现提示来源缺字段时，必须继续检查项目数据源清单。
- 只有检查过所有合理来源后，才能回答“数据不存在”。
- trace 记录实际检查的数据源，便于判断是数据缺失还是提前停止。

可以把传给 QueryAgent 的标题从“已知数据源”改成“优先检查的数据源（非范围限制）”，减少模型锚定。

### 最终答案契约校验

WorkspaceAgent 输出最终答案前可以增加轻量结构校验：

- 用户明确要求 Markdown 表格时，终答必须包含可解析表格。
- 用户明确要求列名或列数时，终答只能保留这些列。
- 用户要求保留并列时，不能用无依据的 `LIMIT 1`。
- 校验失败时，WorkspaceAgent 可以直接修正展示，或把具体数据问题再次交给 QueryAgent。

这里只校验显式输出契约，不用 gold，不写业务答案 hardcode。

## 代码调整位置

### `workspace_agent.js`

- system prompt 明确 QueryAgent 是被托管的叶子执行器。
- 收到查询结果后检查原始用户意图，不完整时继续调用工具。
- 最后由 WorkspaceAgent 输出用户可见答案。

### `query_agent_service.js`

- `params.question` 继续由 WorkspaceAgent 决定，不被当前 user message 覆盖。
- QueryAgent 的 answer、answer_table、result_views 和诊断信息作为普通工具结果返回父 Agent。
- 不再创建 QueryAgent final handoff。
- 叶子 `final_result` 流式块在父会话中降为 `tool_result`，保留父工具调用关系。
- `needs_input` 仍可暂停父任务。

### `service_skill_contract.js`

- 通用 final handoff 能力保持不变，其他 service Skill 仍可使用。
- 只有 QueryAgent service 不再声明 final handoff。

## 验证用例

### 单元测试

1. WorkspaceAgent 决定的 query question 不被当前轮 user message 覆盖。
2. QueryAgent `completed` 结果不包含 handoff。
3. QueryAgent answer、sources 和 evidence 能被 WorkspaceAgent 读取。
4. `needs_input` 仍能暂停父任务。
5. 通用 service final handoff 契约不受影响。
6. QueryAgent Markdown 表格能生成 `answer_table`。
7. 叶子最终展示块不能抢占 WorkspaceAgent 最终答案。
8. Schema 可用时，enrichment 进行中不会把数据源标成不可查询。

### 回归题

优先重跑：

- 多数据源委派：`task_214`、`task_243`、`task_249`、`task_257`、`task_259`、`task_303`
- 最终格式：`task_27`、`task_283`、`task_287`、`task_305`

验收不只看最终分数，还要检查 trace：

- WorkspaceAgent 委派的是完整目标。
- QueryAgent 搜索了所有合理数据源。
- QueryAgent 自己完成跨源查询和合并。
- WorkspaceAgent 在 QueryAgent 返回后继续托管，并输出满足原始意图的最终答案。
