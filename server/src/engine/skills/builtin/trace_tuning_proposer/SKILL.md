---
name: trace_tuning_proposer
description: 基于 Trace 诊断、Gold Solve 和 evidence path 生成可验证、可回滚的调优方案。
category: loop_engineering
runtime: workflow
side_effect: read
allow_implicit_invocation: false
default_enabled: true
requires_project: true
global: false
handler: trace_tuning_propose
tags:
  - builtin
  - loop_engineering
  - trace
  - proposal
  - eval
---

# 目标

基于一次 Trace 诊断结果，生成下一轮可以人工确认的调优方案。

本 Skill 只产出方案。是否临时应用、接受或回滚由外层自动优化流程根据安全门禁和 Benchmark 结果决定。

# 输入

调用方会提供：

- `draft`: 当前用例草稿，包含 question、expected、actual output、assertion type、tuning notes。
- `gold_solve`: 已生成或确认的 Step 0 参考解。
- `diagnosis`: Trace 诊断结果，包含 failure_stage、summary、evidence、evidence_path、trace_gaps、recommended_actions、trace_debugger。
- `trace_evidence_pack`: 服务端抽取的少量证据 span。
- `recent_attempts`: 当前用例最近的调试记录。

# 输出格式

必须只输出一个合法 JSON object：

```json
{
  "hypothesis": "",
  "change_type": "document_desc | agent_rule | none | tool_schema | tool_logic | metadata | benchmark_assertion | trace_instrumentation | manual_check",
  "target": "",
  "proposal": "",
  "why": "",
  "risk": "",
  "validation_plan": "",
  "benchmark_focus": [],
  "manual_steps": [],
  "evidence_path": [
    { "span_id": "", "observation": "" }
  ],
  "document_id": "",
  "new_description": "",
  "agent_type": "",
  "new_rule": "",
  "requires_user_action": "",
  "warnings": []
}
```

# 规则

1. 先判断 `failure_stage`。
   - `intent`、`routing`、`tool_selection` 更可能对应 prompt/routing/skill 描述。
   - `tool_input` 更可能对应 tool schema、参数生成约束或元数据。
   - `sql_generation` 更可能对应 SQL 生成规则、字段/指标元数据或工具实现。
   - `sql_execution` 更可能对应执行环境、连接、SQL 兼容性。
   - `tool_output_usage`、`final_answer` 更可能对应最终回答格式和结果使用规则。
   - `trace_incomplete` 优先提出补埋点或人工检查，不要假装知道根因。

2. 方案必须可验证。
   - `validation_plan` 必须说明跑哪些 Benchmark 或如何复现。
   - `benchmark_focus` 必须是下一轮需要覆盖的问题类型。
   - 必须检查 `recent_attempts`。如果上一条规则的 Benchmark 失败，从 `verification.final_columns` 和 `checks` 找到剩余差距，不得重复同一条规则。

3. 方案必须可确认和回滚。
   - `proposal` 用短段落描述具体改什么。
   - `manual_steps` 给出 2 到 5 个操作步骤。
   - 自动优化只允许外层试写 `document_desc` 或 `agent_rule`；其它修改保持人工处理。

4. 必须引用证据。
   - 优先复用 `diagnosis.evidence_path`。
   - 如果没有 span 证据，`change_type` 应偏向 `manual_check` 或 `trace_instrumentation`，并在 `warnings` 说明证据不足。

5. 不要编造文件路径、函数名、字段名或 schema。
   - 如果输入里没有明确目标，`target` 写业务对象或阶段名，例如 `sql_generation`、`execute_sql`、`final_answer_contract`。

6. 多模态问题按可修复边界处理。
   - `document_recall` 且 Trace 已证明目标文档存在时，可以输出 `document_desc`，必须填写真实 `document_id` 和可复用的 `new_description`。
   - `source_parsing`、OCR、转写或源数据缺失时，必须输出 `none` 和 `requires_user_action`，不能伪装成 Prompt 或题目规则。
   - 文档描述不得包含完整问题、标准答案、样本编号或题目专属查询。

7. SQL 生成或结果完整性属于可复用的 QueryAgent 行为缺口时，可以输出 `agent_rule`。
   - `agent_type` 必须是 `query_agent`。
   - `new_rule` 必须是一条不依赖本题名称、标准答案、样本编号和具体结果值的通用规则。
   - 适合的例子：极值查询没有明确要求单条时保留全部并列结果；先检查真实枚举值再过滤。
   - 不适合的例子：写入某道题的正确 SQL、正确事件名或答案数字。
   - 只有 Trace Span 明确证明问题发生在 QueryAgent 的 SQL/结果处理阶段时才能选择它。
   - 优先修复 `first_divergence`，不要只修复后面的表现。例如 Gold 在行级字段上取最小值，Trace 却先 `SUM` 后取最小值时，规则必须先约束度量粒度，不能只补“保留并列项”。
   - 如果 Gold 限定了最终列形状，规则应同时要求只返回用户询问的列，不要把计算用的值列带入最终答案。

# 质量标准

- 输出要短而具体。
- 不能把风险写成空话。
- 每个方案都要能进入下一轮 attempt，然后通过 Benchmark 验证。
