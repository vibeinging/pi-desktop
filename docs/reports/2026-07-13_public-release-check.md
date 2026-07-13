# PI Desktop 公开发布检查

- 更新日期：2026-07-13
- 检查范围：当前源码、构建与打包输入、测试、GitHub 仓库设置

## 结论

PI Desktop 当前定位为通用的 pi-agent 桌面应用底座，保留 Electron、React、本地 Server、SQLite、模型配置、Skills、MCP、附件、工具调用和会话历史等基础能力。

项目维护者已为有权许可的内容选择 MIT 许可证，可以作为开源的技术预览供开发者审阅和继续开发。第三方内容继续使用各自的许可证。项目尚未发布稳定安装包，因此仍不应描述为稳定版本。

本轮没有发现阻止源码开源的 P0 问题。要成为稳定、可直接复用的桌面底座，仍需先解决 Skill 权限、会话双存储、后端异常恢复、系统凭据存储和跨平台打包验证。

## 已检查

- README、架构、贡献、安全和第三方代码说明只描述当前项目。
- 根 `LICENSE`，以及根、Electron、Renderer、Server 四个 package 和三个 lockfile 的根条目已统一标记为 MIT。
- 2026-07-13，仓库维护者明确选择 MIT 作为本项目所拥有内容的开源许可证。
- README 明确关联上游 `earendil-works/pi`，并说明 PI Desktop 是独立社区项目。
- 桌面应用 ID 使用项目自己的 `io.github.vibeinging.pi-desktop`，不占用上游命名空间。
- 已记录 `vue-element-admin` 图片和图标的来源、版权与 MIT 许可证副本；打包配置会带上根许可证和第三方许可证。
- 发布内容不包含内部计划、过程记录、本地数据库、日志、构建产物和测试输出。
- 应用名称、包名、协议、数据目录、环境变量和界面内部标识统一使用 PI Desktop 或通用 Agent 命名。
- `better-sqlite3` 继续用于项目、会话、消息、模型、Skills、MCP 和 Agent run 持久化。
- JSON Schema、模型结构化输出、MCP input schema 和 embedding 属于通用 Agent 能力，继续保留。
- vendored pi 已更新到 `v0.80.6`，来源 commit、本地修改和 MIT 许可证副本已经记录。
- macOS、Windows 和 Linux CI 会从空 checkout 执行依赖安装和完整检查。

## GitHub 仓库现状

- `main` 已由 active ruleset 保护：必须通过 PR，必须通过 macOS、Ubuntu、Windows 三项检查，禁止删除和 force-push，并要求线性历史。
- 当前远端公开历史没有旧业务内容；两个含旧历史的归档分支只在本地，禁止使用 `git push --all`。
- GitHub 还没有 Release 和 tag。根 `LICENSE` 合入 `main` 后，GitHub 才会识别仓库的 MIT 许可证。
- Secret Scanning、Push Protection、Dependabot Security Updates 和 CodeQL 尚未启用。
- `SECURITY.md` 要求使用 GitHub 私密漏洞报告，但仓库尚未开启该入口，长期安全联系方式也没有填写。

## 本地验证

```bash
npm run setup
npm run check
npm run package:dir
```

检查范围包括 Server 测试、Renderer 测试、TypeScript、ESLint、Renderer 构建和 Electron 目录打包。

本轮还验证了 macOS arm64 目录产物可以启动，后端 IPC ready，SQLite 新库迁移到 `user_version=2`，并通过 Electron smoke。三平台正式安装包尚未验证。

## P1：稳定底座前应先完成

1. **让 Skill 权限真正生效。** 界面允许选择 Prompt、Service、Workflow，但运行时只使用 Prompt；`allowed_tools` 目前只写进提示词，没有在工具调用层拦截。稳定前应先隐藏未实现类型，并在执行层强制检查工具白名单。证据：`renderer/src/views/skills/components/SkillEditor.tsx:325`、`server/src/engine/agents/workspace_agent.js:186-193`、`server/src/engine/agents/pi_skill_registry.js:691`。
2. **处理会话的两套数据源。** SQLite 保存界面消息，JSONL 保存模型上下文；JSONL 写入失败会被忽略，删除会话也没有删除 JSONL。需要明确唯一数据源，或补齐双向校验、导出、恢复、彻底删除和失败测试。证据：`server/src/engine/agents/sessionStore.js:4-63`、`server/src/engine/agents/workspace_agent.js:205`、`server/src/app/session/index.js:110`。
3. **补后端异常恢复。** 后端进程退出后，当前普通 IPC 请求没有超时，也不会统一失败或自动恢复，界面请求可能一直等待。需要增加 ready 握手、请求超时、退出时统一失败、有限重启和可见的恢复提示。证据：`electron/main.js:611`、`electron/main.js:680`、`electron/main.js:885`。
4. **把密钥移到系统凭据存储。** 模型 `api_key` 和 MCP `env` 仍明文保存到 SQLite。需要接入 macOS Keychain、Windows Credential Manager、Linux Secret Service，并迁移已有明文数据。证据：`server/db/schema.sql:86`、`server/db/schema.sql:152`。
5. **统一版本来源。** 根 package 是 `0.0.1`，Electron package 是 `0.1.0`，开发版、打包版、产物名和 tag 可能显示不同版本。需要建立单一版本来源、CHANGELOG、SemVer 和数据库/扩展兼容规则。
6. **建立跨平台打包和发布链路。** 当前三平台 CI 只运行源码检查，没有生成并启动 Electron 产物；打包配置只验证了未签名的 macOS 目录。需要增加 macOS、Windows、Linux 打包与启动 smoke，并补签名、公证、安装包、校验和、SBOM、GitHub Release 和升级流程。

## P2：开源体验继续完善

- 为 Server、Electron 主进程、preload 和打包脚本增加静态检查与单测；现有 lint/typecheck 主要覆盖 Renderer。
- 扩充打包产物 E2E：模型配置、首轮对话、工具确认与取消、Skills、MCP、附件、重启后会话恢复。
- 开启 GitHub 私密漏洞报告、Secret Scanning、Push Protection、Dependabot Security Updates 和 CodeQL；把 Actions 固定到完整 commit SHA。
- 升级 Renderer 开发依赖。当前生产依赖审计为 0，但 Renderer 开发依赖仍有 1 个 critical、3 个 high、6 个 moderate，主要来自 Vite、Vitest 和旧 SVG 插件依赖链。
- 增加统一的应用配置，集中管理产品名、App ID、协议、数据目录、图标、默认提示词和默认工具，降低二次开发改品牌的成本。
- 增加一个完整扩展示例，覆盖后端用例、路由、Renderer 调用、Skill/MCP、权限、取消、错误和数据库迁移。
- 按实际需求补 MCP Streamable HTTP、OAuth 和连接权限说明；本地 `stdio` 已能满足当前技术预览。
- 补 Issue/PR 模板、支持渠道、行为准则、英文入口和各平台构建前置条件；可以把 GitHub 仓库设为 Template repository。
- 继续减少 Renderer 主包体积，并处理现有 Fast Refresh 警告。

## 建议顺序

1. Skill 真权限、会话一致性、后端异常恢复。
2. 系统凭据存储、统一版本、三平台打包启动 CI。
3. 正式 Release 流程、安全开关和生产依赖许可证清单。
4. 集中应用配置、扩展示例、社区文档和性能优化。
