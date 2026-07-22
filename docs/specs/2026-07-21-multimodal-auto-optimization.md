# YiW 多模态自动优化需求

## 1. 背景

YiW 的自动优化流程已经能从会话复盘生成用例、参考解、Trace 诊断和调优方案，但参考解仍以表和 SQL 为中心，而且生成参考解时会读取错误回答和 Trace。这会让错误路径污染正确解法，也无法覆盖 Markdown、PDF、图片等来源。

## 2. 目标

1. 查看失败回答和 Trace 前，先从项目原始来源独立完成正确解法。
2. 用统一证据路径保存数据库、文件、文档、图片处理结果和跨来源计算。
3. 每条证据必须来自真实执行过的来源探查，并保存稳定的探查编号。
4. 参考解确认后才能读取 Trace，并定位第一次分歧。
5. 只自动应用可验证、可精确回滚的配置；解析、OCR、转写或源数据缺失时停止自动修改。
6. 保留已有 `data_sources`、`reference_steps`、`reference_sql` 字段，兼容历史结构化用例。

## 3. 正确流程

```text
读取问题与 expected
  -> 盘点项目原始来源
  -> 用只读 SQL 或 Markdown 读取执行来源探查
  -> 完成提取、过滤、关联、计算和输出形状
  -> 保存并确认证据路径
  -> 读取失败回答和 Trace
  -> 定位第一次分歧
  -> 生成最小修改
  -> 临时应用、重跑 Benchmark、接受或精确回滚
```

独立解题阶段禁止向模型提供 `actual_output`、`trace_snapshot`、Trace 摘要和历史错误 SQL。

## 4. 来源处理

| 来源 | 读取方式 | 位置引用 |
| --- | --- | --- |
| 数据库、CSV、Excel、JSON | 只读 SQL | 数据源、SQL、表和字段 |
| Markdown、TXT、HTML | 文本查找或分段读取 | 文件、行号、片段 |
| DOCX、PDF | 已生成的 Markdown | 原文件、页码或章节、Markdown 行号 |
| 图片、扫描 PDF | 已配置 OCR 或副模型生成的 Markdown | 文件、页码或区域、处理方式 |
| 音频、视频 | 已配置转写或副模型生成的 Markdown | 文件、时间段、处理方式 |

本次不新增 OCR、视觉或转写模型。项目没有现成处理结果时，根因记为 `source_parsing`，配置落点为 `none`。

## 5. 证据路径

参考解保存：

- `sources`：来源类型、名称、模态、位置、用途和探查编号。
- `steps`：提取、过滤、关联、聚合、换算、排序和合并步骤。
- `cross_source_links`：多个来源如何对齐。
- `output_shape`：字段、顺序、单位和空结果处理。
- `evidence_probe_ids`：支持正确答案的真实来源探查。
- `source_probes`：探查动作、结果摘要、位置和执行状态。

不存在、失败或仅盘点来源的探查不能作为答案证据。

## 6. Trace 诊断

参考解未确认时，服务端拒绝 Trace 诊断。诊断必须返回第一次分歧，并覆盖：

- `source_recall` / `document_recall`
- `schema_semantics`
- `source_parsing`
- `cross_source_alignment`
- `filtering` / `calculation` / `unit_conversion` / `sorting`
- 既有意图、路由、工具、SQL、最终回答和评测断言问题

第一次分歧必须引用真实存在的 Trace Span。

## 7. 修改与回滚

- `document_recall` 可以提出 `document_desc` 修改。
- `source_parsing` 只能返回 `none`，并说明需要用户补充的处理能力。
- 文档描述试写时保存旧值；回滚只能在当前值仍等于试写值时执行，避免覆盖并发修改。
- 修改内容不得包含完整问题、标准答案、样本编号或题目专属完整查询。
- 调试轮次通过不代表整体优化成功，最终以新的 Benchmark 重跑结果为准。

## 8. 验收标准

1. 纯文档参考解无需表和 SQL，也能形成已证明证据路径。
2. 数据库加文档参考解能保存两个来源和跨来源步骤。
3. 未执行或失败的探查编号会被拒绝。
4. 参考解确认前，Trace 诊断被服务端拒绝。
5. `document_recall -> document_desc` 能试写并精确回滚。
6. `source_parsing -> none` 不会生成 Prompt 或题目专属规则。
7. 原有结构化字段和历史数据继续可读。

## 9. 实施任务

- [x] 独立来源探查循环
- [x] 通用证据路径持久化
- [x] Trace 状态门禁与第一次分歧
- [x] 多模态根因和配置落点
- [x] 文档描述试写、接受和回滚
- [x] 前端证据与修改状态展示
- [x] 单元测试和回归测试

## 10. 实施结果

### 10.1 独立参考解

- 新增受控来源探查循环，支持 Schema、只读 SQL、Markdown 查找和按行读取。
- 生成参考解时不向模型提供失败回答、失败 SQL 或 Trace。
- 数据库和文档使用同一套 `source_probes`、`sources`、`steps`、`cross_source_links` 和 `output_shape`。
- 只有真实执行成功的探查编号可以进入 `evidence_probe_ids`；不存在或失败的编号会被服务端拒绝。
- 保留 `data_sources`、`reference_steps` 和 `reference_sql`，旧数据不需要迁移重做。

### 10.2 诊断和修改

- 参考解状态不是 `verified` 时，服务端拒绝读取 Trace 进行诊断。
- 直接运行 Benchmark 失败用例时，如果没有独立参考解，也不会读取 Trace，而是记录阻塞原因。
- 第一次分歧必须绑定已观察并真实存在的 Trace Span；伪造或不存在的 Span 会被移除，并将诊断降级为 `trace_incomplete`。
- 新增文档描述试写、接受和精确回滚接口。回滚要求当前描述仍等于试写值，避免覆盖并发修改。
- `source_parsing` 只能生成 `none`，不会自动写 Prompt、规则或题目专属元数据。
- 前端展示来源、证据编号、跨来源路径、第一次分歧、试写状态和回滚入口。

### 10.3 验证结果

- 自动优化核心回归：16/16 通过。
- 前端类型检查：通过。
- 前端测试：40/40 通过。
- 全量 Node 测试：147 项中 146 项通过。
- 唯一失败项为 `eval/tests/suspended-run-runtime.test.mjs` 的暂停任务恢复断言；单独运行仍为 4 项中 3 项通过。该失败不经过本次自动优化代码，本次没有扩大范围修改它。

## 11. 单题自动优化闭环补充

以 KDD `task_25`（`Which event has the lowest cost?`）完成了真实闭环验证：

1. 基线回答错误地按活动 `SUM(expense.cost)`，返回 31 个总成本为 0 的活动。
2. Gold Solve 先读取 Schema，再执行只读 SQL。只有返回标准答案三行的已执行 SQL 才被认定为证据；只读 Schema、只返回一个并列项或模型未执行的 SQL 都不能证明 Gold。
3. Trace 诊断把第一次偏离定位到真实 `execute_sql` Span，确认错误发生在明细粒度被改成活动聚合粒度时。
4. 自动优化采用有上限的循环。每轮读取前一轮 Benchmark 的最终列和失败检查，生成新的通用规则。
5. 前两轮没有保留全部并列项，Benchmark 失败后精确回滚；第三轮返回全部三个事件，Benchmark 通过后才接受规则。

最终接受的规则只描述通用的极值粒度、并列项和输出列约束，不包含题号、问题原文、标准答案值或专用 SQL。

同时修复两类误判：

- `list_match` 只检查最终 Markdown 表格，不再从中间工具输出中找答案。
- 自动优化响应中的 `attempt` 返回最终状态，不再保留容易误导前端的 `running` 快照。

完整记录见 `docs/reports/2026-07-21_task25-auto-optimization-loop.md`。

## 12. 剩余 15 道错题批量验证

2026-07-22 对其余 15 道历史错题完成真实串行验证：

- 8 题基线严格通过。
- 7 题进入失败处理，其中 1 题自动优化后通过。
- 3 题因 Gold 证据不足停止，1 题因第一次偏离 Span 无效阻塞，2 题连续三轮 Benchmark 失败后完整回滚。
- 自动优化对基线错题的本轮修复率为 1/7。
- 48 项相关回归测试全部通过。

本轮确认后续重点不是扩大可修改范围，而是提高 Gold Agent 的完整求解能力、Trace Span 自校验、工具边界感知和失败反馈利用。完整逐题证据见 `docs/reports/2026-07-22_kdd-remaining15-auto-optimization.md`。
