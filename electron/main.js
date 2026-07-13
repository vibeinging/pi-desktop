// PI Desktop —— Electron 主进程。
//
// 职责:
// 1. 创建主窗口(尺寸/背景/自定义标题栏);
// 2. 起本地 Node 后端(app/server),app 退出时 kill;
// 3. ipcMain 提供原生文件/文件夹选择,preload 暴露给前端;
// 4. dev 加载 vite(52731),prod 加载 app/renderer/dist。
//
// 后端进程模型:dev 用系统 node 直跑;prod 用 Electron 自身以 Node 模式运行本地后端。

const { app, BrowserWindow, ipcMain, dialog, screen, shell, nativeImage, Menu, protocol, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { fileURLToPath } = require('node:url');
const { spawn } = require('node:child_process');

const isDev = !app.isPackaged;
// 打包后后端和原生依赖位于 app.asar 外，避免 better-sqlite3 无法加载或被临时解包。
// Electron 壳与 renderer 仍放在 app.asar 内。
const SERVER_DIR = isDev
  ? path.join(__dirname, '..', 'server')
  : path.join(process.resourcesPath, 'server');
const DIST_INDEX = isDev
  ? path.join(__dirname, '..', 'renderer', 'dist', 'index.html')
  : path.join(app.getAppPath(), 'renderer', 'dist', 'index.html');
const DEV_URL = process.env.PI_DEV_URL || 'http://localhost:52731';
const APP_ICON = path.join(__dirname, 'icons', 'icon.png'); // 应用图标
const APP_NAME = 'pi-desktop';
const APP_DISPLAY_NAME = 'PI Desktop';
const LEGACY_USER_DATA_DIR_NAME = 'pi-desktop';
const LOCAL_FILE_SCHEME = 'pi-desktop-file';
const DATA_ROOT = path.join(os.homedir(), '.pi-desktop');
const PROJECTS_ROOT = path.join(DATA_ROOT, 'projects');
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const localFileRoots = new Set();
const DEFAULT_NO_PROXY = ['localhost', '127.0.0.1', '::1'];
const CHAT_PID = '__chat__';
const PASTE_ATTACHMENTS_DIR = 'pasted-text';

protocol.registerSchemesAsPrivileged([
  { scheme: LOCAL_FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function getLegacyUserDataPath() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', LEGACY_USER_DATA_DIR_NAME);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), LEGACY_USER_DATA_DIR_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), LEGACY_USER_DATA_DIR_NAME);
}

app.setName(APP_NAME);
app.setPath('userData', getLegacyUserDataPath());

let mainWindow = null;
let backendProc = null;
let isQuitting = false;
let closePromptOpen = false;
let backendStopping = null;
let backendStoppedForQuit = false;
let trustedRendererDocument = false;
const pending = new Map(); // id → (msg)=>void:后端进程消息按 id 路由(api-request 收集 / stream 转发)
let reqSeq = 0;
const CLOSE_BEHAVIOR_VALUES = new Set(['ask', 'minimize', 'quit']);
const BACKEND_GRACEFUL_SHUTDOWN_MS = 5000;
const BACKEND_SIGTERM_SHUTDOWN_MS = 2500;
const MIN_WINDOW_WIDTH = 900;
const MIN_WINDOW_HEIGHT = 600;
const MAX_IPC_PATH_LENGTH = 32 * 1024;
const MAX_IPC_BODY_BYTES = 32 * 1024 * 1024;
const ALLOWED_API_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
let windowStateSaveTimer = null;

function isTrustedRendererUrl(rawUrl) {
  try {
    const candidate = new URL(String(rawUrl || ''));
    if (isDev) {
      const dev = new URL(DEV_URL);
      return (candidate.protocol === 'http:' || candidate.protocol === 'https:') && candidate.origin === dev.origin;
    }
    if (candidate.protocol !== 'file:') return false;
    return path.resolve(fileURLToPath(candidate)) === path.resolve(DIST_INDEX);
  } catch {
    return false;
  }
}

function isAllowedExternalUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function openExternalSafely(rawUrl) {
  if (!isAllowedExternalUrl(rawUrl)) return;
  shell.openExternal(String(rawUrl)).catch((error) => {
    console.warn('[electron] 无法打开外部链接:', error?.message || error);
  });
}

function guardMainFrameNavigation(event, targetUrl) {
  if (isTrustedRendererUrl(targetUrl)) return;
  event.preventDefault();
  openExternalSafely(targetUrl);
}

function assertTrustedIpcSender(event) {
  const contents = mainWindow?.webContents;
  if (!contents || contents.isDestroyed() || event.sender !== contents) {
    throw new Error('IPC 请求来源不是当前应用窗口');
  }
  if (event.senderFrame && event.sender.mainFrame && event.senderFrame !== event.sender.mainFrame) {
    throw new Error('IPC 请求只能来自应用主页面');
  }
  // BrowserRouter 在 file:// 页面内 pushState 后，Electron 会把当前 URL 显示为
  // file:///agent 一类路由地址。这里信任已经从 DIST_INDEX 启动且未发生整页导航的文档，
  // 整页外部跳转仍由 will-navigate / will-redirect 拦截。
  if (!trustedRendererDocument) throw new Error('IPC 请求来源页面未受信任');
}

function handleTrustedIpc(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedIpcSender(event);
    return handler(event, ...args);
  });
}

function onTrustedIpc(channel, handler) {
  ipcMain.on(channel, (event, ...args) => {
    try {
      assertTrustedIpcSender(event);
      handler(event, ...args);
    } catch (error) {
      console.warn(`[electron] 已拒绝 ${channel}:`, error?.message || error);
    }
  });
}

function optionalIpcPath(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const candidate = String(value);
  if (candidate.length > MAX_IPC_PATH_LENGTH || candidate.includes('\0')) throw new Error('路径参数无效');
  return candidate;
}

function requiredIpcPath(value) {
  const candidate = optionalIpcPath(value);
  if (!candidate) throw new Error('路径参数不能为空');
  return candidate;
}

function normalizeIpcHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error('请求头数量过多');
  const headers = {};
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName);
    const headerValue = String(rawValue ?? '');
    if (['__proto__', 'constructor', 'prototype'].includes(name.toLowerCase()) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || /[\r\n]/.test(headerValue) || headerValue.length > 8192) {
      throw new Error('请求头参数无效');
    }
    headers[name] = headerValue;
  }
  return headers;
}

function normalizeBackendRequest(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求参数无效');
  const method = String(value.method || 'GET').toUpperCase();
  if (!ALLOWED_API_METHODS.has(method)) throw new Error('请求方法不受支持');
  const url = String(value.url || '/');
  if (url.length > 8192 || /[\u0000-\u001f\u007f]/.test(url) || !/^\/api(?:[/?#]|$)/.test(url)) {
    throw new Error('只能访问应用本地 API');
  }
  const body = value.body === null || value.body === undefined ? null : String(value.body);
  if (body !== null && Buffer.byteLength(body, 'utf8') > MAX_IPC_BODY_BYTES) throw new Error('请求内容过大');
  const bodyEncoding = value.bodyEncoding === undefined ? undefined : String(value.bodyEncoding);
  if (bodyEncoding !== undefined && bodyEncoding !== 'base64') throw new Error('请求编码不受支持');
  return { method, url, headers: normalizeIpcHeaders(value.headers), body, bodyEncoding };
}

function networkSettingsPath() {
  return path.join(app.getPath('userData'), 'agent-network-settings.json');
}

function closeBehaviorPath() {
  return path.join(app.getPath('userData'), 'window-close-behavior.json');
}

function windowStatePath() {
  return path.join(app.getPath('userData'), 'main-window-state.json');
}

function defaultWindowBounds() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  return {
    width: Math.max(MIN_WINDOW_WIDTH, Math.min(1400, Math.round(sw * 0.92))),
    height: Math.max(MIN_WINDOW_HEIGHT, Math.min(900, Math.round(sh * 0.92))),
  };
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function intersectsDisplay(bounds, display) {
  const area = display.workArea || display.bounds;
  if (!area) return false;
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  const areaRight = area.x + area.width;
  const areaBottom = area.y + area.height;
  return right > area.x + 80 && bounds.x < areaRight - 80 && bottom > area.y + 80 && bounds.y < areaBottom - 80;
}

function normalizeWindowState(raw = {}) {
  const fallback = defaultWindowBounds();
  const primaryArea = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.max(MIN_WINDOW_WIDTH, Math.min(numberOrNull(raw.width) || fallback.width, primaryArea.width));
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.min(numberOrNull(raw.height) || fallback.height, primaryArea.height));
  const x = numberOrNull(raw.x);
  const y = numberOrNull(raw.y);
  const state = {
    width,
    height,
    isMaximized: raw.isMaximized === true,
    hasPosition: false,
  };
  if (x !== null && y !== null) {
    const positioned = { x, y, width, height };
    if (screen.getAllDisplays().some((display) => intersectsDisplay(positioned, display))) {
      state.x = x;
      state.y = y;
      state.hasPosition = true;
    }
  }
  return state;
}

function loadWindowState() {
  try {
    return normalizeWindowState(JSON.parse(fs.readFileSync(windowStatePath(), 'utf8')));
  } catch {
    return normalizeWindowState();
  }
}

function saveWindowState(win = mainWindow) {
  if (!win || win.isDestroyed() || win.isFullScreen()) return;
  const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
  const state = normalizeWindowState({ ...bounds, isMaximized: win.isMaximized() });
  fs.mkdirSync(path.dirname(windowStatePath()), { recursive: true });
  fs.writeFileSync(windowStatePath(), JSON.stringify({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    isMaximized: state.isMaximized,
  }, null, 2));
}

function scheduleSaveWindowState(win = mainWindow) {
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null;
    saveWindowState(win);
  }, 300);
}

function normalizeNetworkSettings(value = {}) {
  return {
    httpProxy: String(value.httpProxy || '').trim(),
    noProxy: String(value.noProxy || '').trim(),
    customCert: String(value.customCert || '').trim(),
  };
}

function loadNetworkSettings() {
  try {
    return normalizeNetworkSettings(JSON.parse(fs.readFileSync(networkSettingsPath(), 'utf8')));
  } catch {
    return normalizeNetworkSettings();
  }
}

function saveNetworkSettings(settings) {
  const normalized = normalizeNetworkSettings(settings);
  fs.mkdirSync(path.dirname(networkSettingsPath()), { recursive: true });
  fs.writeFileSync(networkSettingsPath(), JSON.stringify(normalized, null, 2));
  return normalized;
}

function loadCloseBehavior() {
  try {
    const raw = JSON.parse(fs.readFileSync(closeBehaviorPath(), 'utf8'));
    const behavior = String(raw?.behavior || 'ask');
    return CLOSE_BEHAVIOR_VALUES.has(behavior) ? behavior : 'ask';
  } catch {
    return 'ask';
  }
}

function saveCloseBehavior(behavior) {
  const normalized = CLOSE_BEHAVIOR_VALUES.has(behavior) ? behavior : 'ask';
  fs.mkdirSync(path.dirname(closeBehaviorPath()), { recursive: true });
  fs.writeFileSync(closeBehaviorPath(), JSON.stringify({ behavior: normalized }, null, 2));
  return normalized;
}

function normalizeProxyUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const withScheme = value.includes('://') ? value : `http://${value}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function splitNoProxy(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergedNoProxy(value) {
  return [...new Set([...DEFAULT_NO_PROXY, ...splitNoProxy(value)])].join(',');
}

function applyNetworkEnv(env, settings = loadNetworkSettings()) {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    delete env[key];
  }
  const proxyUrl = normalizeProxyUrl(settings.httpProxy);
  if (proxyUrl) {
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.ALL_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    env.all_proxy = proxyUrl;
  }

  const noProxy = mergedNoProxy(settings.noProxy);
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;

  delete env.NODE_EXTRA_CA_CERTS;
  const certPath = String(settings.customCert || '').trim();
  if (certPath && fs.existsSync(certPath)) {
    env.NODE_EXTRA_CA_CERTS = certPath;
  } else if (certPath) {
    console.warn(`[electron] 自定义证书不存在,已跳过: ${certPath}`);
  }
}

async function applyRendererNetworkProxy(settings = loadNetworkSettings()) {
  const proxyUrl = normalizeProxyUrl(settings.httpProxy);
  try {
    if (!proxyUrl) {
      await session.defaultSession.setProxy({ mode: 'direct' });
      return;
    }
    await session.defaultSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: `http=${proxyUrl};https=${proxyUrl}`,
      proxyBypassRules: mergedNoProxy(settings.noProxy),
    });
  } catch (e) {
    console.warn('[electron] 应用渲染层代理失败:', e?.message || e);
  }
}

function normalizeLocalFileRoot(rootPath) {
  const raw = String(rootPath || '').trim();
  if (!raw) return null;
  const resolved = path.resolve(raw);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function registerLocalFileRoot(rootPath) {
  const root = normalizeLocalFileRoot(rootPath);
  if (!root) return null;
  localFileRoots.add(root);
  return root;
}

function isInsideRoot(filePath, rootPath) {
  return filePath === rootPath || filePath.startsWith(rootPath + path.sep);
}

function realPathForExisting(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function safeWorkspaceSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 160);
}

function decodeFolderPid(pid) {
  try {
    const b64 = String(pid).slice('folder:'.length).replace(/-/g, '+').replace(/_/g, '/');
    const p = Buffer.from(b64, 'base64').toString('utf8');
    return p || null;
  } catch {
    return null;
  }
}

function isExistingDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function pasteAttachmentWorkspaceRoot(projectId, sessionId) {
  const pid = String(projectId || '').trim();
  if (pid.startsWith('folder:')) {
    const decoded = decodeFolderPid(pid);
    if (decoded && isExistingDirectory(decoded)) return path.resolve(decoded);
    return path.join(DATA_ROOT, 'folder-pastes', safeWorkspaceSegment(pid) || 'folder');
  }
  if (pid === CHAT_PID) {
    const sid = safeWorkspaceSegment(sessionId) || 'draft';
    return path.join(PROJECTS_ROOT, CHAT_PID, sid);
  }
  const safePid = safeWorkspaceSegment(pid) || 'default';
  return path.join(PROJECTS_ROOT, safePid);
}

function savePastedTextAttachment(payload = {}) {
  const content = String(payload.content || '');
  if (!content) throw new Error('粘贴内容为空');
  const workspaceRoot = pasteAttachmentWorkspaceRoot(payload.projectId, payload.sessionId);
  const dir = path.join(workspaceRoot, PASTE_ATTACHMENTS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  registerLocalFileRoot(workspaceRoot);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  const name = `pasted-text-${stamp}-${suffix}.txt`;
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return {
    path: filePath,
    name,
    size: Buffer.byteLength(content, 'utf8'),
  };
}

registerLocalFileRoot(PROJECTS_ROOT);

function configureApplicationIdentity() {
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      version: app.getVersion(),
      iconPath: APP_ICON,
    });
  }
}

function configureApplicationMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  const closeBehavior = loadCloseBehavior();
  const setCloseBehavior = (behavior) => {
    saveCloseBehavior(behavior);
    configureApplicationMenu();
  };

  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: '关闭按钮行为',
          submenu: [
            {
              label: '每次询问',
              type: 'radio',
              checked: closeBehavior === 'ask',
              click: () => setCloseBehavior('ask'),
            },
            {
              label: '最小化',
              type: 'radio',
              checked: closeBehavior === 'minimize',
              click: () => setCloseBehavior('minimize'),
            },
            {
              label: '关闭应用',
              type: 'radio',
              checked: closeBehavior === 'quit',
              click: () => setCloseBehavior('quit'),
            },
          ],
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerLocalFileProtocol() {
  protocol.registerFileProtocol(LOCAL_FILE_SCHEME, (request, callback) => {
    try {
      const url = new URL(request.url);
      const encoded = url.hostname === 'local'
        ? (url.pathname || '').replace(/^\/+/, '')
        : `${url.hostname}${url.pathname || ''}`.replace(/^\/+/, '');
      const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
      const filePath = Buffer.from(b64, 'base64').toString('utf8');
      const resolved = path.resolve(filePath);
      const ext = path.extname(resolved).toLowerCase();
      const real = realPathForExisting(resolved);
      const allowed = [...localFileRoots].some((root) => isInsideRoot(real, root));
      if (!IMAGE_EXTS.has(ext) || !allowed) {
        callback({ error: -10 });
        return;
      }
      callback({ path: real });
    } catch {
      callback({ error: -2 });
    }
  });
}

// ── 后端生命周期 ──
function startBackend() {
  const entryRel = path.join('src', 'index.js');
  // dev:系统 node;prod:Electron 自身以 Node 模式跑(自包含,需 electron-rebuild 原生模块)
  const cmd = isDev ? (process.env.PI_NODE_BIN || 'node') : process.execPath;
  const args = isDev ? [entryRel] : [path.join(SERVER_DIR, entryRel)];
  const env = { ...process.env };
  applyNetworkEnv(env);
  if (isDev) env.PI_TCP = '1'; // dev:后端同时听 TCP,便于 eval 复用运行中的实例;prod 走纯进程通道(零端口)
  if (!isDev) env.ELECTRON_RUN_AS_NODE = '1';
  try {
    // stdio 第 4 个 'ipc':建进程消息通道(process.send/on('message')),ZCode 式传输(无端口/socket)
    const child = spawn(cmd, args, { cwd: SERVER_DIR, env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    backendProc = child;
    child.on('error', (e) => console.error('[electron] 后端启动失败:', e?.message || e));
    child.on('exit', (code, sig) => {
      if (backendProc === child) backendProc = null;
      console.log(`[electron] 后端退出 code=${code} sig=${sig}`);
    });
    // 后端回传的消息按 id 路由到对应等待者
    child.on('message', (m) => { if (m && m.id != null) { const h = pending.get(m.id); if (h) h(m); } });
    console.log(`[electron] 后端已启动 (${cmd} ${args.join(' ')}, pid=${child.pid})`);
  } catch (e) {
    console.error('[electron] 无法启动后端:', e?.message || e);
  }
}

function waitForBackendExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
    };
    child.once('exit', onExit);
  });
}

function rejectPendingBackendRequests(message = '后端正在关闭') {
  for (const [id, handler] of pending) {
    try {
      handler({ id, type: 'error', error: message });
    } catch {
      /* ignore */
    }
  }
  pending.clear();
}

async function stopBackend() {
  if (backendStopping) return backendStopping;
  const child = backendProc;
  if (!child) return;
  rejectPendingBackendRequests();
  backendProc = null;
  backendStopping = (async () => {
    if (child.connected) {
      try { child.disconnect(); } catch { /* ignore */ }
      if (await waitForBackendExit(child, BACKEND_GRACEFUL_SHUTDOWN_MS)) return;
    }
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    if (await waitForBackendExit(child, BACKEND_SIGTERM_SHUTDOWN_MS)) return;
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    await waitForBackendExit(child, 1000);
  })().finally(() => {
    if (backendStopping) backendStopping = null;
  });
  return backendStopping;
}

function stopBackendSync() {
  rejectPendingBackendRequests();
  try { backendProc?.kill('SIGTERM'); } catch { /* ignore */ }
  backendProc = null;
}
function backendSend(msg) { try { backendProc?.send(msg); } catch { /* backend down */ } }

function minimizeMainWindow(win = mainWindow) {
  try {
    if (win && !win.isDestroyed() && !win.isMinimized()) win.minimize();
  } catch {
    /* ignore */
  }
}

function quitApplication() {
  isQuitting = true;
  app.quit();
}

async function handleMainWindowCloseRequest(win = mainWindow) {
  if (!win || win.isDestroyed() || closePromptOpen) return;
  const behavior = loadCloseBehavior();
  if (behavior === 'minimize') {
    minimizeMainWindow(win);
    return;
  }
  if (behavior === 'quit') {
    quitApplication();
    return;
  }

  closePromptOpen = true;
  try {
    const result = await dialog.showMessageBox(win, {
      type: 'question',
      title: '关闭 PI Desktop？',
      message: '要关闭应用还是最小化到后台？',
      detail: '最小化会保留本地服务和当前会话；关闭应用会停止后台进程。',
      buttons: ['最小化', '关闭应用', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      checkboxLabel: '不再询问，记住我的选择',
      checkboxChecked: false,
    });
    if (result.response === 0) {
      if (result.checkboxChecked) {
        saveCloseBehavior('minimize');
        configureApplicationMenu();
      }
      minimizeMainWindow(win);
    } else if (result.response === 1) {
      if (result.checkboxChecked) {
        saveCloseBehavior('quit');
        configureApplicationMenu();
      }
      quitApplication();
    }
  } finally {
    closePromptOpen = false;
  }
}

// ── 主窗口(1200x800 基准、背景 #36313f、自定义标题栏保留交通灯)──
function createWindow() {
  const windowState = loadWindowState();
  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    ...(windowState.hasPosition ? { x: windowState.x, y: windowState.y } : {}),
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    backgroundColor: '#36313f',
    title: APP_DISPLAY_NAME,
    icon: APP_ICON, // Windows/Linux 任务栏图标(macOS 用下方 app.dock.setIcon)
    // macOS:隐藏标题栏但保留交通灯;配合前端 -webkit-app-region:drag。
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => guardMainFrameNavigation(event, url));
  mainWindow.webContents.on('will-redirect', (event, url) => guardMainFrameNavigation(event, url));
  mainWindow.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) trustedRendererDocument = isTrustedRendererUrl(url);
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  if (!windowState.hasPosition) mainWindow.center();
  if (windowState.isMaximized) mainWindow.maximize();
  lockPageZoom(mainWindow);
  if (!isDev) {
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      mainWindow?.loadFile(DIST_INDEX);
    });
  }
  if (isDev) {
    mainWindow.loadURL(DEV_URL);
  } else {
    mainWindow.loadFile(DIST_INDEX);
  }
  mainWindow.on('close', (event) => {
    saveWindowState(mainWindow);
    if (isQuitting) return;
    event.preventDefault();
    handleMainWindowCloseRequest(mainWindow);
  });
  mainWindow.on('resize', () => scheduleSaveWindowState(mainWindow));
  mainWindow.on('move', () => scheduleSaveWindowState(mainWindow));
  mainWindow.on('maximize', () => scheduleSaveWindowState(mainWindow));
  mainWindow.on('unmaximize', () => scheduleSaveWindowState(mainWindow));
  mainWindow.on('closed', () => {
    trustedRendererDocument = false;
    mainWindow = null;
  });
}

function lockPageZoom(win) {
  const resetZoom = () => {
    try { win.webContents.setZoomLevel(0); } catch { /* ignore */ }
    try { win.webContents.setZoomFactor(1); } catch { /* ignore */ }
  };
  resetZoom();
  win.webContents.on('did-finish-load', resetZoom);
  win.webContents.on('zoom-changed', (event) => {
    event.preventDefault();
    resetZoom();
  });
  try {
    win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  } catch {
    /* ignore */
  }
}

// ── ipc:原生文件/文件夹选择;返回 {path,isDir} 与前端契约一致 ──
handleTrustedIpc('pick-paths', async (_e, defaultPath) => {
  const safeDefaultPath = optionalIpcPath(defaultPath);
  const res = await dialog.showOpenDialog(mainWindow ?? undefined, {
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    defaultPath: safeDefaultPath,
  });
  if (res.canceled) return [];
  return res.filePaths.map((p) => {
    let isDir = false;
    try { isDir = fs.statSync(p).isDirectory(); } catch { isDir = false; }
    return { path: p, isDir };
  });
});

handleTrustedIpc('pick-folder', async (_e, defaultPath) => {
  const safeDefaultPath = optionalIpcPath(defaultPath);
  const res = await dialog.showOpenDialog(mainWindow ?? undefined, {
    properties: ['openDirectory'],
    defaultPath: safeDefaultPath,
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

handleTrustedIpc('reveal-in-finder', async (_e, p) => {
  try { shell.showItemInFolder(requiredIpcPath(p)); return true; } catch { return false; }
});

// 工作区本地目录:项目 = ~/.pi-desktop/projects/<id>
handleTrustedIpc('workspace-path', async (_e, wsId) => {
  const rawId = String(wsId || '').trim();
  const safeId = safeWorkspaceSegment(rawId);
  if (!rawId || rawId !== safeId || rawId === '.' || rawId === '..') throw new Error('工作区标识无效');
  const root = path.join(PROJECTS_ROOT, safeId);
  registerLocalFileRoot(root);
  return root;
});

handleTrustedIpc('register-local-file-root', async (_e, rootPath) => {
  const root = requiredIpcPath(rootPath);
  if (!path.isAbsolute(root)) throw new Error('本地文件根目录必须是绝对路径');
  return Boolean(registerLocalFileRoot(root));
});

handleTrustedIpc('save-pasted-text-attachment', async (_e, payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('附件参数无效');
  const content = String(payload.content || '');
  if (Buffer.byteLength(content, 'utf8') > MAX_IPC_BODY_BYTES) throw new Error('粘贴内容过大');
  const projectId = String(payload.projectId || '');
  const sessionId = String(payload.sessionId || '');
  if (projectId.length > 4096 || sessionId.length > 512) throw new Error('附件工作区参数无效');
  return savePastedTextAttachment({ projectId, sessionId, content });
});

handleTrustedIpc('default-data-root', async () => DATA_ROOT);
handleTrustedIpc('network-settings-load', async () => loadNetworkSettings());
handleTrustedIpc('network-settings-save', async (_e, settings) => {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('网络设置参数无效');
  const normalized = normalizeNetworkSettings(settings);
  if (Object.values(normalized).some((value) => value.length > MAX_IPC_PATH_LENGTH)) throw new Error('网络设置内容过长');
  const saved = saveNetworkSettings(normalized);
  await applyRendererNetworkProxy(saved);
  return saved;
});

// ── ipc:REST 请求 → 进程消息通道交给后端 registry,收集成一次性响应 ──
// req = { method, url(/api/...?query), headers, body(string|null) };返回 { status, statusText, headers, json|body }。
handleTrustedIpc('api-request', async (_e, req) => {
  const request = normalizeBackendRequest(req);
  return new Promise((resolve) => {
    const id = `q${++reqSeq}`;
    let status = 0;
    let statusText = '';
    let headers = {};
    let binary = false;
    const chunks = [];
    pending.set(id, (m) => {
      if (m.type === 'head') { status = m.status; statusText = m.statusText; headers = m.headers || {}; }
      else if (m.type === 'data') { if (m.b64) binary = true; chunks.push(m.chunk); }
      else if (m.type === 'error') { pending.delete(id); resolve({ status: status || 0, statusText: m.error || '', headers, body: chunks.join('') }); }
      else if (m.type === 'end') {
        pending.delete(id);
        if (binary) {
          // 二进制(blob 下载):各块 base64 解码后拼接,整体再 base64 给前端还原 Blob
          const buf = Buffer.concat(chunks.map((c) => Buffer.from(c, 'base64')));
          resolve({ status, statusText, headers, bodyB64: buf.toString('base64') });
          return;
        }
        const text = chunks.join('');
        const ct = String(headers['content-type'] || '');
        let json;
        let body;
        if (/application\/json/i.test(ct)) { try { json = JSON.parse(text); } catch { body = text; } }
        else body = text;
        resolve({ status, statusText, headers, json, body });
      }
    });
    backendSend({ id, ...request });
  });
});

// ── ipc:SSE 流式 → 进程消息通道;后端 res.write 的每块经 message 回传,转给渲染层 ──
// payload = { id, url, method, headers, body };向 `pi-desktop-stream:<id>` 推 {type:'head'|'data'|'end'|'error'}。
handleTrustedIpc('stream-start', async (e, payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('流请求参数无效');
  const id = String(payload.id || '');
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(id) || pending.has(id)) throw new Error('流请求标识无效');
  const request = normalizeBackendRequest(payload);
  const send = (msg) => { try { if (!e.sender.isDestroyed()) e.sender.send(`pi-desktop-stream:${id}`, msg); } catch { /* renderer gone */ } };
  pending.set(id, (m) => {
    send(m);
    if (m.type === 'end' || m.type === 'error') pending.delete(id);
  });
  backendSend({ id, ...request });
  return true;
});
onTrustedIpc('stream-abort', (_e, rawId) => {
  const id = String(rawId || '');
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new Error('流请求标识无效');
  pending.delete(id);
  backendSend({ id, type: 'abort' });
});

// ── app 生命周期 ──
app.whenReady().then(async () => {
  configureApplicationIdentity();
  configureApplicationMenu();
  registerLocalFileProtocol();
  // macOS Dock 图标(dev 下不设会显示默认 Electron 图标)
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(nativeImage.createFromPath(APP_ICON)); } catch { /* ignore */ }
  }
  await applyRendererNetworkProxy();
  startBackend();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      return;
    }
    try {
      if (mainWindow?.isMinimized()) mainWindow.restore();
      mainWindow?.show();
      mainWindow?.focus();
    } catch {
      /* ignore */
    }
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', (event) => {
  isQuitting = true;
  if (!backendProc || backendStoppedForQuit) return;
  event.preventDefault();
  stopBackend().finally(() => {
    backendStoppedForQuit = true;
    app.quit();
  });
});
process.once('SIGINT', () => {
  isQuitting = true;
  stopBackend().finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  isQuitting = true;
  stopBackend().finally(() => process.exit(0));
});
process.on('exit', stopBackendSync);
