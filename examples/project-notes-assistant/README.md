# 项目笔记助手扩展示例

这个示例展示如何在 PI Desktop 上增加一个完整能力，而不是只放一段伪代码。它包含 Server 用例、路由、SQLite 迁移、测试、Renderer API 与页面、Prompt Skill，以及可单独启动的 `stdio` MCP Server。

## 文件对应关系

| 文件 | 接入位置 |
| --- | --- |
| `server/notes.js` | 复制到 `server/src/app/notes/index.js` |
| `server/registry.notes.js` | 复制到 `server/src/transport/registry.notes.js`，再合并到 `registry.js` |
| `server/migration.sql` | 合并到 schema，并在 `server/src/db.js` 增加下一个迁移版本 |
| `renderer/notes-api.ts` | 复制到 `renderer/src/api/notes.ts` |
| `renderer/ProjectNotesPage.tsx` | 放到 views，并在路由中注册 |
| `skills/project-notes/SKILL.md` | 在 App 设置中创建同名 Prompt Skill |
| `mcp/server.mjs` | 安装依赖后，以 `node <绝对路径>/server.mjs` 注册 stdio MCP |

## 接入步骤

1. 先合并数据库 schema 和迁移，并运行迁移失败回滚测试。
2. 接入 Server 用例与 registry；业务代码只依赖 `ctx`，不直接依赖 IPC 或 HTTP。
3. 运行 `node --test examples/project-notes-assistant/server/notes.test.mjs`。
4. 接入 Renderer API 和页面。请求会自动走 Electron IPC；浏览器调试才走受保护的 loopback HTTP。
5. 创建 Prompt Skill，白名单只给 `read`、`grep` 和 `mcp_project_notes_*`。代码层会拦截不在名单中的写文件或 Shell 工具。
6. 在 MCP 设置中注册 `stdio` Server。生产项目应让 MCP 调用同一个本地 API 或独立数据文件；示例使用内存数组，便于直接运行。

## 失败、取消和权限

- 用例在查询前检查 `ctx.signal.aborted`，取消后抛出 `AbortError`。
- 标题为空、笔记不存在、项目不存在都返回清楚错误，不返回空成功。
- Renderer 使用统一请求层，因此后端退出、超时和恢复提示与主应用一致。
- Skill 白名单不能代替用户审批；如果后来给 Skill 增加 `write`、`edit` 或 `bash`，仍会走桌面确认。
- 所有 SQL 都使用参数，不拼接用户输入。

## 本地验证

```bash
npm run lint:node
npm run test:examples
npm run check
```
