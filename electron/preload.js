// Electron preload —— 经 contextBridge 把安全的原生能力暴露到 window.electronAPI。
// 前端检测 window.electronAPI 即知运行在桌面壳内。
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const MAX_PATH_LENGTH = 32 * 1024;
const MAX_BODY_LENGTH = 32 * 1024 * 1024;
const ALLOWED_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);

function optionalPath(value) {
  if (value === null || value === undefined || value === '') return null;
  const candidate = String(value);
  if (candidate.length > MAX_PATH_LENGTH || candidate.includes('\0')) throw new TypeError('路径参数无效');
  return candidate;
}

function requiredPath(value) {
  const candidate = optionalPath(value);
  if (!candidate) throw new TypeError('路径参数不能为空');
  return candidate;
}

function normalizeHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value);
  if (entries.length > 100) throw new TypeError('请求头数量过多');
  const headers = {};
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName);
    const headerValue = String(rawValue ?? '');
    if (['__proto__', 'constructor', 'prototype'].includes(name.toLowerCase()) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || /[\r\n]/.test(headerValue) || headerValue.length > 8192) {
      throw new TypeError('请求头参数无效');
    }
    headers[name] = headerValue;
  }
  return headers;
}

function normalizeRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('请求参数无效');
  const method = String(value.method || 'GET').toUpperCase();
  const url = String(value.url || '/');
  if (!ALLOWED_METHODS.has(method)) throw new TypeError('请求方法不受支持');
  if (url.length > 8192 || /[\u0000-\u001f\u007f]/.test(url) || !/^\/api(?:[/?#]|$)/.test(url)) {
    throw new TypeError('只能访问应用本地 API');
  }
  const body = value.body === null || value.body === undefined ? null : String(value.body);
  if (body !== null && body.length > MAX_BODY_LENGTH) throw new TypeError('请求内容过大');
  const bodyEncoding = value.bodyEncoding === undefined ? undefined : String(value.bodyEncoding);
  if (bodyEncoding !== undefined && bodyEncoding !== 'base64') throw new TypeError('请求编码不受支持');
  return { method, url, headers: normalizeHeaders(value.headers), body, bodyEncoding };
}

function normalizeNetworkSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('网络设置参数无效');
  const settings = {
    httpProxy: String(value.httpProxy || '').trim(),
    noProxy: String(value.noProxy || '').trim(),
    customCert: String(value.customCert || '').trim(),
  };
  if (Object.values(settings).some((item) => item.length > MAX_PATH_LENGTH)) throw new TypeError('网络设置内容过长');
  return settings;
}

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  getPathForFile: (file) => {
    try { return webUtils?.getPathForFile ? webUtils.getPathForFile(file) : ''; } catch { return ''; }
  },
  // 原生文件/文件夹选择
  pickPaths: (defaultPath) => ipcRenderer.invoke('pick-paths', optionalPath(defaultPath)),
  pickFolder: (defaultPath) => ipcRenderer.invoke('pick-folder', optionalPath(defaultPath)),
  // 在 Finder / 资源管理器中显示
  revealInFinder: (p) => ipcRenderer.invoke('reveal-in-finder', requiredPath(p)),
  // 工作区本地目录路径
  workspacePath: (wsId) => {
    const id = String(wsId || '').trim();
    if (!id || id.length > 160 || !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(id)) throw new TypeError('工作区标识无效');
    return ipcRenderer.invoke('workspace-path', id);
  },
  // 默认本地数据根目录: ~/.pi-desktop
  defaultDataRoot: () => ipcRenderer.invoke('default-data-root'),
  // 注册当前会话允许渲染的本地工作区根(pi-desktop-file:// 只读图片协议使用)
  registerLocalFileRoot: (rootPath) => ipcRenderer.invoke('register-local-file-root', requiredPath(rootPath)),
  // 将超长粘贴文本保存成当前工作区内的 txt 附件。
  savePastedTextAttachment: (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('附件参数无效');
    const content = String(payload.content || '');
    const projectId = String(payload.projectId || '');
    const sessionId = String(payload.sessionId || '');
    if (!content || content.length > MAX_BODY_LENGTH || projectId.length > 4096 || sessionId.length > 512) {
      throw new TypeError('附件参数无效');
    }
    return ipcRenderer.invoke('save-pasted-text-attachment', { projectId, sessionId, content });
  },
  // 网络设置需要主进程在启动后端前读取,因此保存到 Electron userData。
  loadNetworkSettings: () => ipcRenderer.invoke('network-settings-load'),
  saveNetworkSettings: (settings) => ipcRenderer.invoke('network-settings-save', normalizeNetworkSettings(settings)),
  getBackendStatus: () => ipcRenderer.invoke('backend-status'),
  restartBackend: () => ipcRenderer.invoke('backend-restart'),
  onBackendState: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('后端状态回调必须是函数');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('pi-desktop-backend-state', listener);
    return () => ipcRenderer.removeListener('pi-desktop-backend-state', listener);
  },
  // REST 请求经主进程转发到本地后端进程(axios adapter 用,不直连 HTTP)
  apiRequest: (req) => ipcRenderer.invoke('api-request', normalizeRequest(req)),
  // SSE 流式:主进程从本地后端进程拉,逐块经 `pi-desktop-stream:<id>` 推回;onMsg 收 {type:'head'|'data'|'end'|'error'}。
  // 返回 dispose():移除监听 + 取消上游(供前端 AbortSignal / 组件卸载)。
  streamStart: (req, onMsg) => {
    if (typeof onMsg !== 'function') throw new TypeError('流回调必须是函数');
    const request = normalizeRequest(req);
    const randomPart = globalThis.crypto?.randomUUID?.().replace(/[^a-zA-Z0-9-]/g, '') || Math.random().toString(36).slice(2);
    const id = `${Date.now()}-${randomPart}`;
    const channel = `pi-desktop-stream:${id}`;
    const listener = (_e, msg) => {
      onMsg(msg);
      if (msg && (msg.type === 'end' || msg.type === 'error')) ipcRenderer.removeListener(channel, listener);
    };
    ipcRenderer.on(channel, listener);
    ipcRenderer.invoke('stream-start', { ...request, id }).catch((error) => {
      ipcRenderer.removeListener(channel, listener);
      onMsg({ type: 'error', error: error?.message || '无法启动请求' });
    });
    return () => {
      ipcRenderer.removeListener(channel, listener);
      ipcRenderer.send('stream-abort', id);
    };
  },
});
