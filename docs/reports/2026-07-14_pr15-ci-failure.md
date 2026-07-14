# PR #15 CI 失败分析

日期：2026-07-14

## 结论

PR #15 首轮 CI 中，macOS、CodeQL 和 GitGuardian 已通过；Windows 与 Linux 的失败来自跨平台检查脚本，不是 yiTrace 运行逻辑失败。两处问题已经修复，正在等待新一轮 CI 验证。

## Windows

失败步骤：`npm run config:check`

Git 在 Windows checkout 时把文本文件转换为 CRLF。`scripts/generate-app-config.mjs` 使用 LF 生成目标内容，并直接按完整字符串比较，因此把内容相同、换行符不同的三个生成文件误判为过期：

- `electron/generated-app-config.cjs`
- `server/src/generated/app-config.js`
- `renderer/src/generated/app-config.ts`

最小修复：比较前统一 CRLF 和 LF；生成内容仍统一写成 LF。

## Linux

失败步骤：`xvfb-run --auto-servernum npm run smoke:package`

Electron 找到了 `chrome-sandbox`，但 GitHub Runner 无法把它设置成 root 所有且权限为 4755，Chromium 因此拒绝启动。

最小修复：只在 Linux CI 的安装目录 smoke 中传入 `--no-sandbox`。正式安装包和普通用户启动不使用这个参数。

## 后续步骤

1. 完成上述两处小范围修改。已完成。
2. 本地运行配置检查、脚本语法检查和现有测试。已完成：配置检查通过，两个脚本语法检查通过，Electron 10 项测试全部通过，`git diff --check` 通过。
3. 提交并推送修复。
4. 等待 PR #15 三平台 CI 全部通过。
5. 合并到 `main`，不打 tag，不创建 Release。
