---
name: gold_solve_drafter
description: 在读取错误回答和 Trace 前，从项目原始来源独立生成多模态证据路径和参考解草稿。
category: loop_engineering
runtime: workflow
side_effect: read
allow_implicit_invocation: false
default_enabled: true
requires_project: true
global: false
handler: trace_gold_solve_draft
tags:
  - builtin
  - loop_engineering
  - gold_solve
  - eval
  - trace
---

# 目标

为 Eval Draft 生成 `Step 0 Gold Solve` 草稿。必须先读取项目原始来源独立解题，完成后才能让后续流程查看失败 Trace。

本 Skill 生成的是参考解草稿，不是线上执行路径，不是 Golden Path，也不会自动注入 agent 运行上下文。

# 输入

调用方会提供：

- `question`: 用户原始问题。
- `expected_behavior`: 正确行为或口径描述。
- `expected_answer`: 已知 expected answer，可为空。
- `assertion_type`: 当前评测断言方式。
- `replay_requirements`: 数据源、schema fingerprint、模型配置等重放上下文，可能不完整。
- `source_evidence.inventory`: 项目数据库、Schema 文件和已转成 Markdown 的文档清单。
- `source_evidence.probes`: 服务端已经真实执行过的来源探查。

输入不会包含 `actual_output` 和 Trace。不要要求或猜测这些内容。

# 输出格式

必须只输出一个合法 JSON object：

```json
{
  "intent_summary": "",
  "sources": [],
  "steps": [],
  "cross_source_links": [],
  "output_shape": {},
  "evidence_probe_ids": [],
  "data_sources": [],
  "filters": {},
  "metric_definition": "",
  "reference_steps": [],
  "reference_sql": "",
  "intermediate_expectations": [],
  "final_answer_contract": "",
  "warnings": [],
  "assumptions": []
}
```

# 规则

1. 先读取来源，再输出参考解。
   - 证据不足时只输出 `next_source_actions`，动作只能是 `read_schema`、`execute_sql`、`search_documents`、`read_document`。
   - `evidence_probe_ids` 只能引用 `probes` 中 `ok=true` 且 `evidence=true` 的编号。
   - 不能引用来源盘点、失败探查或不存在的编号。
   - 只读 Schema 不算完成解题。结构化任务必须执行最终 SQL，且返回行集要与 `expected_answer` 一致。

2. 不要伪造不存在的数据源、字段、文档或 SQL。
   - 如果来源证据不足，继续探查或写入 `warnings`。
   - 可以描述“需要确认的数据源/字段”，但不要把它说成已确认事实。

3. `reference_steps` 要表达正确计算方式。
   - 例如：选择数据源、过滤条件、实体识别、聚合口径、排序/TopN、最终输出格式。
   - 每一步应短句化，便于后续与 trace span 对比。
   - 先确定度量粒度。问题只说某个字段的最低值时，不要自行改成 `SUM`/`AVG`；只有明确要求总计、平均或按实体聚合时才改变粒度。

4. `reference_sql` 只有在字段和表信息足够明确时才填写。
   - 不确定时留空，并在 `warnings` 说明缺少 schema evidence。
   - 必须填写已通过 `execute_sql` 真实执行并验证输出的 SQL，不要在最后换成一条未执行的 SQL。

5. `metric_definition` 用于描述指标口径。
   - 如果问题不是指标计算，可以简短说明判断/筛选口径。

6. `final_answer_contract` 必须说明最终答案应该怎么呈现。
   - 包括列名、排序、单位、小数位、是否允许解释文本等。

7. 多来源问题必须填写 `cross_source_links`，说明关联键、合并或计算方式。每个关联步骤必须用 `probe_ids` 引用参与关联的真实探查，不能只写文字说明。

8. `sources` 要保留来源类型、模态、位置、用途和 `probe_ids`；`steps` 要保留处理顺序和对应探查。

9. `warnings` 和 `assumptions` 要明确可执行。
   - warnings 表示阻碍确认参考解的问题。
   - assumptions 表示生成草稿时采用的假设。

# 质量标准

- 参考解宁可保守，也不要看似完整但基于猜测。
- 必须能帮助工程人员判断问题可能发生在理解、路由、工具输入、SQL、工具输出利用或最终回答。
- 输出只是一份草稿，用户确认前不能进入 Benchmark ready。
