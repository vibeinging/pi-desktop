# 外部 Skill 固化测试：Thesis Tracker

日期：2026-07-22

## 结论

使用 Anthropic 公开的 `thesis-tracker` Skill 做了真实适配测试。测试证明，一个描述完整业务流程的外部 Skill 可以在 YiW 中变成多页面产品，并让产品页面与专属 Agent 共用同一份结构化数据。

后续又补做了真实用户流程：用户只在 YiW 对话中说“帮我下载 thesis-tracker Skill，把它做成小程序并嵌入 App”，页面内容由 YiW 内的 Agent 根据下载到的 `SKILL.md` 自动生成。测试没有在脚本里提供页面 JSON。下载和安装分别经过 App 确认卡，最终在真实 Electron 窗口的侧边栏中打开了产品。

这次测试不是只检查表单。生成的产品包含：

- 观点总览
- 论点记分卡
- 催化剂日历
- 证据更新
- 专属 Agent 研究工作台

## 样本来源

- Skill：[Anthropic thesis-tracker](https://github.com/anthropics/financial-services/blob/main/plugins/vertical-plugins/equity-research/skills/thesis-tracker/SKILL.md)
- 仓库：[Anthropic financial-services](https://github.com/anthropics/financial-services)
- 许可证：[Apache License 2.0](https://github.com/anthropics/financial-services/blob/main/LICENSE)

选择它的原因：

1. 它描述的是完整的投资研究方向，不是一个单次提示词。
2. 它包含长期状态：投资观点、论点、风险、证据、催化剂、信心等级和复核时间。
3. 它不强制依赖某个外部 MCP，可以单独验证 YiW 的 Skill Product 底座。
4. 它与“股票模块参考成熟股票软件设计”的产品设想一致。

## 适配关系

| Skill 业务步骤 | 产品页面 | 后端数据 |
| --- | --- | --- |
| 定义或读取投资观点 | 观点总览、研究工作台 | `thesis-tracker / product_data` |
| 记录新证据和动作 | 证据更新、研究工作台 | 同一条结构化观点数据 |
| 持续维护论点状态 | 论点记分卡 | `pillars[]` |
| 跟踪未来事件 | 催化剂日历 | `catalysts[]` |
| 形成会议或风控结论 | 研究工作台 | 固化的 Skill 指令与专属会话 |

## 测试暴露的问题

原实现可以固定 Skill 指令、工具范围、页面和会话，但 Agent 不能直接读写产品自己的结构化数据。这不满足原 Skill 提出的“跨会话保存和持续更新”。

本次补充了两个受限工具：

- `skill_product_state_get`：读取当前产品自己的数据。
- `skill_product_state_set`：写入当前产品自己的数据，写入前需要用户确认。

它们只在已经安装的 Skill Product 专属会话中可用。每次调用都会重新检查：

- 当前用户
- 产品、版本和 Skill 绑定
- 专属会话绑定
- `storage:<module-key>` 权限

写入支持 `expected_revision`，旧版本数据不能覆盖新版本数据。单条数据限制为 128KB。

当 Skill 声明这两个产品数据工具时，生成产品会自动加入自己的 storage 权限，不需要调用方手工补权限。

## 底座回归链

自动测试使用临时 SQLite 数据库，执行了以下完整链路：

1. 创建来自公开 Skill 的 App Skill 定义。
2. 生成 5 个产品页面和页面导航。
3. 自动声明产品运行权限和产品数据权限。
4. 校验草稿并生成预览令牌。
5. 安装不可变版本。
6. 创建第一个专属产品会话。
7. 使用产品数据后端写入一份 ACME 测试观点。
8. 页面通过模块动作读取同一份数据。
9. 使用错误 revision 写入，确认被拒绝。
10. 使用伪造的产品会话读取，确认被拒绝。
11. 创建第二个专属会话，确认能继续读取第一会话保存的数据。

执行命令：

```bash
cd server
/opt/homebrew/bin/node --test \
  src/engine/modules/module_validator.test.js \
  src/engine/modules/module_registry.test.js \
  src/engine/modules/skill_product.test.js \
  src/engine/agents/product_tool_catalog.ui_modules.test.js
```

结果：`17 passed, 0 failed`。

页面运行回归：

```bash
cd renderer
/opt/homebrew/bin/node node_modules/vitest/vitest.mjs run \
  src/modules/ModuleHost.test.ts \
  src/modules/SchemaRenderer.test.ts
```

结果：`4 passed, 0 failed`。

## 真实用户流程

用户原话：

> 帮我下载 thesis-tracker Skill。请把这个 Skill 做成一套投资观点跟踪小程序，嵌入到 YiW App 内。需要长期保存观点、论点、反证、催化剂和更新日志。请先下载，再由你根据 Skill 内容自动生成前端页面和后端数据逻辑，预览后安装。不要让我提供页面 JSON。

YiW 内的 Agent 实际完成了：

1. `skill_registry_search` 搜索公开来源。
2. 展示 `skill_download` 确认卡，确认后下载真实 `SKILL.md`。
3. 根据 Skill 工作流生成产品草稿；第一次参数结构错误被校验器拒绝，Agent 随后自行重试。
4. 校验草稿并生成预览。
5. 展示 `ui_module_draft_install` 确认卡，确认后安装。
6. Electron 界面侧边栏显示 `Thesis Tracker v1.0.0`，点击后打开产品。

来源审计结果：

- 仓库：`anthropics/financial-services`
- 文件：`plugins/vertical-plugins/equity-research/skills/thesis-tracker/SKILL.md`
- SHA-256：`6b4ce2967c5e01c6b42f5c140fa1e94dee2713b5d2de3eb71957ff5a5c11469b`
- 导入方式：只读取 `SKILL.md`，不执行仓库代码

安装结果：

- 模块状态：`active`
- 页面：`dashboard`、`scorecard`、`catalysts`、`updates`、`workspace`、`overview`
- 页面后端动作：`load_product_data`
- 权限：`skill-product:thesis-tracker:run`、`storage:thesis-tracker`
- App Skill 工具：`skill_product_state_get`、`skill_product_state_set`

执行命令：

```bash
node eval/lib/skill-product-user-flow.mjs
node eval/lib/skill-product-ui-verify.mjs
```

两条测试都通过。界面测试还从真实页面调用了 `load_product_data`，返回 HTTP 200；当前为首次安装，所以 `exists=false`。

本次修改后的核心回归结果：`12 passed, 0 failed`；Renderer TypeScript 检查通过。

## 现场发现并修复的问题

真实窗口第一次没有显示已安装模块。原因不是安装失败，而是旧版本在浏览器存储中留下了仍然有效的随机用户 token；Agent 流程使用固定本地用户安装模块，界面却仍以旧用户读取模块列表。

现在 Electron 启动时会主动刷新为固定本地用户，不再只判断 token 是否为空。修复后真实界面使用用户 `00000000-0000-0000-0000-000000000000`，侧边栏和 Agent 安装结果属于同一用户。

## 当前边界

- 这次已经验证 App 接收用户原话、搜索和下载真实 `SKILL.md`、由 App Agent 自动推导页面、校验、预览、确认安装、侧边栏展示和页面读取。
- 测试脚本只发送用户原话和点击允许的确认卡，没有传入页面 JSON；草稿页面来自模型在 App 内的真实工具调用。
- 草稿创建、校验、预览令牌、权限确认、安装、版本快照和产品数据读写使用的都是 App 正式内部实现，不是测试替身。
- 没有调用真实股票行情接口；测试数据使用虚构的 ACME 标的。
- 本次使用了 App 已配置的真实模型。第一次页面参数错误后能自动恢复，但不同模型生成的页面质量仍会有差异。
- 现场界面验证了产品数据读取；跨会话写入、revision 冲突和会话隔离由底座自动测试覆盖。
- 接入行情、财报或新闻后，可以继续把同一个 Skill 绑定到 `query_project_data` 或只读 MCP Provider。
