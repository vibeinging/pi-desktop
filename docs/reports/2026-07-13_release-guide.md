# PI Desktop 发布手册

- 适用版本：`0.1.0` 起
- 正式发布入口：推送 `v<version>` tag
- 默认结果：GitHub Draft Release，人工确认后再公开

## 1. 版本规则

根 `package.json` 是唯一版本来源。修改版本使用：

```bash
npm run version:set -- 0.2.0
npm run version:check
```

- Patch：兼容的修复，不删除 API、字段或扩展能力。
- Minor：向后兼容的新能力、可前向执行的 SQLite 新迁移。
- Major：删除或修改公开 API、扩展格式、数据含义等不兼容变化。

数据库迁移只允许按 `PRAGMA user_version` 向前执行；每次改 schema 都必须同时更新新库 schema、旧库迁移和失败回滚测试。正式升级前备份 `~/.pi-desktop/local.db`。当前不提供自动降级迁移。

公开扩展能力至少提前一个 Minor 版本标记废弃，并在 CHANGELOG、类型和运行日志中给出替代方法；真正删除放到下一个 Major 版本。

## 2. 合并与回归检查

CI 在 macOS、Windows、Linux 上执行：

1. 依赖安装、版本检查、静态检查和测试；
2. 生成当前平台 unpacked 应用；
3. 启动实际 Electron 可执行文件并等待 Renderer 与 preload 加载完成；
4. 通过主进程 IPC 创建临时工作区、会话和消息；
5. 经 Renderer 和 preload 保存文本附件，并创建本地无密钥模型、Prompt Skill 和禁用的 MCP 配置；
6. 使用只在 smoke 进程内监听的本机假模型完成一轮真实 pi Agent 流式对话；
7. 重启内置 Server，确认 Agent 消息、模型、Skill、MCP 和附件都可以恢复；
8. 删除临时模型、Skill、MCP、会话和工作区，并确认数据库记录不可再读取；
9. 正常退出应用。

PR 构建不签名。macOS 的 unpacked 检查会关闭 hardened runtime 和公证，避免把开发探针误当成正式产物。

正式版本必须先合并到 `main`，再等待该提交触发的 `push` CI 完成三平台回归。不能从功能分支直接打 tag，也不能先打 tag、出包后再补合并。

Release workflow 在出包前还会检查：

1. tag 指向的提交已经包含在 `origin/main` 中；
2. 同一个提交存在成功的 `main` push CI；
3. tag 与根 `package.json` 版本一致。

任一条件不满足时，四个平台的出包任务都不会启动。

## 3. 正式发布密钥

GitHub Actions 需要配置：

| Secret | 用途 |
| --- | --- |
| `MAC_CSC_LINK` | Developer ID Application `.p12` 的 base64 或安全地址 |
| `MAC_CSC_KEY_PASSWORD` | `.p12` 密码 |
| `APPLE_API_KEY` | App Store Connect API `.p8` 内容 |
| `APPLE_API_KEY_ID` | API Key ID |
| `APPLE_API_ISSUER` | API Issuer ID |
| `WIN_CSC_LINK` | Windows OV/EV 可导出证书 |
| `WIN_CSC_KEY_PASSWORD` | Windows 证书密码 |

证书和密码不能写进仓库、构建日志或 Release。任何必需值缺失时，tag workflow 会在构建前失败。

## 4. 产物

- macOS arm64/x64：DMG 和 ZIP，签名、公证并验证 stapling。
- Windows x64：NSIS 安装包，并验证 Authenticode 状态为 `Valid`。
- Linux x64：AppImage 和 deb。
- 附件：SHA-256、Server/Renderer/Electron CycloneDX SBOM、MIT License、第三方声明和 CHANGELOG。

## 5. 发布步骤

1. 完成 CHANGELOG 的 Unreleased 内容。
2. 运行 `npm run check`。
3. 运行 `npm run version:set -- x.y.z`，再次检查 CHANGELOG 链接。
4. 通过 PR 把发布提交合并到 `main`。
5. 等待该 `main` 提交的 macOS、Windows、Linux CI 全部成功。
6. 人工回归启动、真实模型首次对话、工具确认与取消、Skill 激活和白名单、MCP 工具调用、附件预览、会话恢复、后端退出恢复。
7. 确认本地 `main` 与远端一致，在刚完成回归的提交上创建并推送 `vx.y.z` tag。
8. 等待 Release workflow 先验证合并状态、同提交回归结果和版本，再完成四个平台出包。
9. 下载 Draft Release，至少在一台干净的 macOS、Windows、Linux 机器安装并启动。
10. 核对签名、公证、SHA-256、版本、许可证和 SBOM 后，人工发布 Draft。

发布顺序固定为：合并 `main` → 自动和人工回归 → 打 tag → 出包 → 安装验收 → 公开 Release。

## 6. 回滚

- Draft 有问题：保持 Draft 或删除 Draft 和错误 tag，修复后使用新的 Patch 版本，不能用同一正式版本覆盖已公开产物。
- 已公开但应用有问题：在 Release 中标记问题，撤下受影响附件，立即发布新的 Patch；不要重写旧 tag。
- 数据迁移有问题：停止分发新版本，保留用户数据库副本，用升级前备份恢复旧应用；修复迁移后用新 Patch 发布。
- 签名密钥泄露：立刻在 Apple/Microsoft 或证书机构吊销，删除 GitHub Secret，轮换密钥，并检查 Secret Scanning 告警。
