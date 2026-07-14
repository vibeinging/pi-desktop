# PI Desktop 公开发布检查

- 更新日期：2026-07-14
- 检查范围：当前源码、构建与打包输入、测试、GitHub 仓库设置

## 结论

PI Desktop 当前定位为通用的 pi-agent 桌面应用底座，保留 Electron、React、本地 Server、SQLite、模型配置、Skills、MCP、附件、工具调用和会话历史等基础能力。

项目维护者已为有权许可的内容选择 MIT 许可证，可以作为开源底座供开发者继续开发。第三方内容继续使用各自许可证。Skill 权限、会话双表示一致性、后端恢复、系统凭据、统一版本、发布流程、GitHub 安全和二次开发入口已完成代码实施。

当前源码和本机 macOS arm64 unpacked 产物已达到公开开发底座要求。macOS x64、Windows、Linux 和正式签名安装包仍需由新 CI/Release workflow 首次运行确认，因此在首个 tag 成功前不应宣称三平台正式安装包已经发布。

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
- macOS、Windows 和 Linux CI 会从空 checkout 执行完整检查、unpacked 打包和真实启动探针。
- 根 `app.config.json` 统一生成 Electron、Server、Renderer 和启动页配置。
- 项目笔记助手示例覆盖 Server、Renderer、SQLite、Skill、MCP、取消、权限和测试。

## GitHub 仓库现状

- `main` 已由 active ruleset 保护：必须通过 PR，必须通过 macOS、Ubuntu、Windows 三项检查，禁止删除和 force-push，并要求线性历史。
- 远端 `main` 当前仍停在 `fc80ce6`。本轮稳定化工作位于本地 `codex/stable-foundation-hardening`，当前有 46 个已跟踪改动和 33 个未跟踪路径，尚未形成 PR，因此远端还没有验证本轮新代码和新发布流程。
- 远端 `main` 的三平台源码检查已成功，但当时的 workflow 只执行 `setup` 和 `check`，尚未包含本轮新增的 unpacked 打包与启动探针。
- 当前远端公开历史没有旧业务内容；两个含旧历史的归档分支只在本地，禁止使用 `git push --all`。
- GitHub 还没有 Release 和 tag；tag workflow 会先创建 Draft Release。
- GitHub Actions 当前没有配置发布密钥，macOS 签名、公证和 Windows 签名流程暂时无法真实运行。
- Secret Scanning、Push Protection、Dependabot alerts、安全更新和私密漏洞报告已经开启。
- CodeQL default setup 已启用，首次 JavaScript/TypeScript 扫描成功。
- 非 Provider patterns 和 validity checks 在当前仓库仍显示不可用，未记为已开启。

## 本地验证

```bash
npm run setup
npm run check
npm run package:dir
```

检查范围包括配置同步、版本同步、Server/Renderer/Electron/示例测试、Renderer TypeScript、三端 ESLint、vendored pi 构建和 Renderer 构建。

本轮通过 37 个 Server 测试、15 个 Renderer 测试、10 个 Electron 测试和 2 个扩展示例测试。macOS arm64 目录产物已通过真实 Electron smoke：Renderer 与 preload 加载完成，经主进程 IPC 创建工作区、会话、消息、本地无密钥模型、Prompt Skill 和禁用的 MCP 配置；文本附件经过 Renderer → preload → 主进程 IPC 保存。打包后的 Server 使用真实 pi Agent 调用只在 smoke 期间监听的本机假模型，完成首轮流式对话并保存用户与助手消息。内置 Server 重启后，3 条 SQLite 消息、模型、Skill、MCP 和附件均能恢复；删除后相关数据库记录不可再读取。SQLite 新库迁移到 `user_version=4`。三平台正式安装包尚未验证。

## 已完成的稳定化工作

1. Skill 只开放真实支持的 Prompt 类型，`use_skill` 和工具白名单在执行层生效。
2. SQLite 是唯一正式存储；其中保留两种用途不同的会话表示：`session_messages` 是给人查看的权威历史，Agent transcript 是带版本基线、可自动重建的模型投影。旧 JSONL 只导入一次或用于主动导出。
3. 后端具备 ready、超时、退出失败返回、1/2/5 秒有限重启和 Renderer 状态提示。
4. 模型与 MCP 密钥使用 Electron `safeStorage`，SQLite 只保存引用，旧明文可迁移。
5. 四个 package 和三个 lockfile 统一为 `0.1.0`，CI 检查漂移。
6. 三平台安装包、启动探针、签名、公证、校验和、SBOM 和 Draft Release 流程已写入仓库。
7. GitHub 安全开关、CodeQL、固定 Actions SHA 和 main ruleset 已确认。
8. 统一应用配置、完整扩展示例和 Node 静态检查已接入根检查。

## 0.1.0 前必须完成

1. **把当前工作区变成可审查的 PR。** 先按存储与安全、发布流程、文档与开发体验整理提交，再推送当前分支并创建 PR。远端 `main` 目前不包含本轮稳定化代码，不能直接打 tag。
2. **让新 CI 在三平台真实首跑。** macOS、Windows、Linux 都必须从空 checkout 完成 `setup`、完整检查、unpacked 打包和启动探针；失败后在 PR 内修复，不能用本机 macOS 结果代替。
3. **继续增加安装包级关键流程回归。** 当前 smoke 已覆盖 Renderer、preload、工作区和会话 API、SQLite 写入、本地无密钥模型、pi Agent 首轮流式对话、Prompt Skill 配置、MCP 配置、文本附件、后端重启恢复和删除。还需要覆盖工具确认与取消、Skill 激活和白名单，以及真正启动 stdio MCP 并调用工具；正式发布前仍需人工使用至少一个真实模型服务回归。
4. **验证真实安装和卸载。** 分别安装 DMG/ZIP、NSIS、AppImage/deb，检查首次启动、数据目录、协议注册、升级覆盖安装和卸载后数据保留策略。现有 workflow 只启动 unpacked 目录，不等于安装包可用。
5. **配置签名与公证密钥。** Actions 当前没有发布 secrets。需要配置 Apple 签名证书、App Store Connect API 信息和 Windows 签名证书，先生成 Draft Release，再人工确认后公开。
6. **文档漂移已修正。** README、规格和发布手册已经同步系统凭据与增强后的打包探针；合并前继续由 `git diff --check` 和人工评审确认。

## 首个版本后优先开发

1. **完整备份和恢复。** 目前只能导出 Agent transcript。需要提供 SQLite 一致性备份、项目文件备份、恢复前校验、失败回滚和版本兼容说明；凭据默认不导出，只提示用户重新配置。
2. **自动升级。** 当前能生成 Release 产物和 blockmap，但没有 `autoUpdater` 或升级界面。建议首个手工安装版本稳定后，再增加检查更新、下载进度、签名校验、安装确认和失败回滚。
3. **稳定扩展接口。** 当前示例适合 fork 后改源码，但还没有不改核心代码即可安装的扩展协议。需要定义扩展清单、生命周期、权限、配置、数据库迁移、版本兼容和脚手架。
4. **整组升级 Renderer 工具链。** 生产依赖审计为 0；开发依赖仍有 1 个 critical、3 个 high、6 个 moderate。现有 Vite 8 Dependabot 更新会与 React SWC 插件产生 peer dependency 冲突，应把 Vite、Vitest、React SWC 和 SVG 工具作为一组升级，而不是逐个合并。
5. **补 UI 和 Electron 端到端测试。** Renderer 当前主要测试流式 reducer、HTML 清洗和翻译覆盖；Electron 主要测试后端进程和凭据。需要覆盖页面导航、设置保存、preload IPC 边界、窗口恢复、深链和真实交互。
6. **诊断与支持包。** 增加本地结构化日志、日志轮转、隐私清洗、崩溃后的恢复提示和用户主动导出的诊断包；默认不上传遥测。
7. **性能和界面质量。** 拆分约 1.75 MB 的 Renderer 主 JS 包，处理现有 12 条 Fast Refresh 警告，并补键盘操作、焦点、屏幕阅读器和高缩放测试。

## 可选能力，不阻塞 0.1.0

- MCP Streamable HTTP、OAuth 和远程连接权限。
- Service Skill、Workflow Skill；需要先定义真实执行协议，不能只恢复界面选项。
- Windows arm64、Linux arm64 和更多发行版安装包。
- 扩展市场、云同步、团队账号和远程数据库。

## 建议执行顺序

1. 冻结 0.1.0 范围，整理当前工作区并创建 PR。
2. 修复新三平台 CI，完成安装包关键流程回归。
3. 配置签名密钥，生成并人工验证 0.1.0 Draft Release。
4. 发布后先做备份恢复、自动升级和稳定扩展接口。
5. 再处理工具链升级、包体积、更多 MCP 与 Skill 类型。
