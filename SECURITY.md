# 安全说明

## 支持范围

PI Desktop 当前是开发者预览版，尚未发布稳定版本。`main` 分支只接受尽力维护，不代表已经通过生产安全审计。

## 报告安全问题

请不要为未修复漏洞创建公开 Issue。请使用 [GitHub 私密漏洞报告](https://github.com/vibeinging/pi-desktop/security/advisories/new)；该入口只对报告者和维护者可见。

报告请包含：

- 受影响的 commit 或版本；
- 最小复现步骤；
- 可访问的数据或可执行的操作；
- 是否需要模型输出、网页、MCP 服务或本地文件参与；
- 建议的修复或缓解方式（如果有）。

## 信任边界

- 模型文本、Markdown、网页内容、MCP 返回、Skill 内容和导入文件都属于不可信输入。
- Electron preload 是网页与本机能力之间的边界。不要把任意命令、任意文件路径或通用 IPC 直接暴露给 Renderer。
- 本地工具可能读写文件或执行命令。用户取消后，后端任务也必须停止，不能只停止界面输出。
- 模型密钥、MCP 环境变量和数据库文件都属于敏感信息。密钥通过 Electron `safeStorage` 加密，SQLite 只保存引用；数据库本身仍未加密，不要共享 `~/.pi-desktop/`。
- Linux 必须使用 Secret Service。检测到 `basic_text` 时应用拒绝保存密钥，不会静默降级。

## HTTP 调试接口

桌面主路径使用进程 IPC。独立启动后端或设置 `PI_TCP=1` 时，HTTP 只绑定 `127.0.0.1`，但浏览器页面仍可能尝试访问本机端口。

允许浏览器访问时必须同时设置：

- `PI_ALLOWED_ORIGINS`：精确来源列表，例如 `http://127.0.0.1:52731`；多个值用英文逗号分隔。
- `PI_HTTP_TOKEN`：足够长的随机令牌。

浏览器请求还需携带 `X-PI-Desktop-Token`。不要使用通配来源，不要把令牌写入前端仓库或日志。没有 `Origin` 的请求只用于受控的本机进程、curl、eval 和 CI。

## 发布前最低要求

- 对模型 Markdown/HTML 做可靠清洗，并限制窗口跳转和新窗口。
- 为 Electron 启用合适的 sandbox 与内容安全策略。
- 确认系统凭据迁移完成，SQLite 中不存在旧明文密钥。
- 验证取消操作能中止模型和工具执行。
- 在干净环境运行 `npm run setup` 和 `npm run check`。
- 审核生产依赖和所有随包分发的第三方许可证。
