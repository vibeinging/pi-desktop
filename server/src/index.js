// PI Desktop 本地后端，只负责启动通用传输层。
//
//   app 路径   :渲染层 → ipc → 主进程 process.send → transport/ipc_server(registry 用例),零 express。
//   eval/CI 路径:独立启动 或 PI_TCP=1 → transport/http_server(薄 express,跑同一 registry)。
//
//   业务通过 transport/registry.js 按需挂载。
import "./config/network.js";
import { closeDb, queryOne } from './db.js';
import { ensureDbModelConfigProvider } from './engine/core/model_config_provider.js';

ensureDbModelConfigProvider({ queryOne });

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e?.message || e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e?.message || e));

const shutdown = () => {
  try { closeDb(); } catch { /* ignore */ }
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("disconnect", shutdown);

const PORT = Number(process.env.SERVER_PORT || 52838);

// ── app 路径:被 Electron 主进程以 ipc 通道 fork(process.send 可用)→ 进程消息派发到 registry 用例 ──
// app 内实例零 HTTP/端口/express;仅当独立启动 或 PI_TCP=1 时下方再起 TCP(给 eval/CI)。
if (typeof process.send === "function") {
  import("./transport/ipc_server.js").then(({ handleIpcMessage, abortIpcStream }) => {
    process.on("message", (msg) => {
      if (!msg || msg.id == null) return;
      if (msg.type === "abort") { abortIpcStream(msg.id); return; }
      handleIpcMessage(msg, (m) => { try { process.send(m); } catch { /* main 退出 */ } });
    });
    console.log("🟢 desktop server (node) ready on process IPC channel (registry, express-free app path)");
  });
}

// ── eval/CI 路径:独立启动(无 ipc 通道)或 PI_TCP=1 → 薄 express 跑同一 registry,监听 TCP ──
if (typeof process.send !== "function" || process.env.PI_TCP === "1") {
  import("./transport/http_server.js").then(({ startHttpServer }) => startHttpServer(PORT));
}
