---
name: smart_query
display_name: 项目数据查询
description: 基于当前问数项目中已接入的数据回答统计、明细、排序、分组、图表和 SQL 类自然语言问题。不要用于导入文件、创建项目或连接数据库。
category: analysis
runtime: service
side_effect: read
allow_implicit_invocation: true
default_enabled: true
requires_project: true
global: false
handler: query_agent
tool_name: query_project_data
tags:
  - builtin
  - data
  - nl2sql
---

# 目标

当用户在问数项目中提出数据查询、统计、指标分析、SQL、图表或可视化问题时,通过 query_project_data 调用 QueryAgent 问数服务。

# 执行契约

- 本 Skill 是 service runtime,不作为普通 prompt Skill 加载。
- 调用方只需要调用 query_project_data;具体 schema 召回、NL2SQL、SQL 执行和结果格式化由 QueryAgent 负责。
- QueryAgent 是 WorkspaceAgent 托管的叶子执行器。查询答案和证据返回 WorkspaceAgent,不会自动结束父任务。
- WorkspaceAgent 必须结合原始对话判断用户意图是否完成;不完整时继续调用工具,完整后由 WorkspaceAgent 给出本轮最终回答。
- QueryAgent 的自然答案、结构化 answer_table 和 result_views 都是工具证据。WorkspaceAgent 可以按用户意图重新组织展示,但变化必须由证据支持,不能无依据改变数值、单位、列含义或记录数量。
- 不用于创建项目、连接数据库、导入文件或修改数据资产。
