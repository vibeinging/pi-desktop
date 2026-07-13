// L0 传输适配层(HTTP 侧):薄 express,把 TCP 请求喂进**同一个 registry/usecase/信封**。
// 仅用于 eval/CI(独立启动 或 PI_TCP=1);app 路径走 ipc_server,不经这里。
// 与 ipc_server 共享 router/envelope/ctx —— eval 测的就是 app 跑的同一份用例代码。
import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { makeRouter } from './router.js';
import { okBody, failBody } from './envelope.js';
import { makeCtx } from '../ctx.js';
import { ApiError } from '../errors.js';
import { ROUTES } from './registry.js';
import { createStreamEvent, StreamEventType } from './agent_stream_protocol.js';

const match = makeRouter(ROUTES);

function configuredBrowserAccess() {
  const origins = new Set(
    String(process.env.PI_ALLOWED_ORIGINS || '')
      .split(',')
      .map((value) => value.trim().replace(/\/$/, ''))
      .filter(Boolean),
  );
  const configuredToken = String(process.env.PI_HTTP_TOKEN || '').trim();
  return {
    origins,
    token: configuredToken || randomBytes(32).toString('base64url'),
    configuredToken: Boolean(configuredToken),
  };
}

function tokenMatches(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function installBrowserBoundary(app) {
  const access = configuredBrowserAccess();
  app.use((req, res, next) => {
    const rawOrigin = String(req.headers.origin || '').trim();
    if (!rawOrigin) return next(); // curl / CI / 本机进程不属于浏览器跨域请求。

    const origin = rawOrigin.replace(/\/$/, '');
    if (!access.origins.has(origin)) {
      return res.status(403).json(failBody('不允许的浏览器来源', 403));
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-PI-Desktop-Token');
    if (req.method === 'OPTIONS') return res.status(204).end();

    if (!tokenMatches(req.headers['x-pi-desktop-token'], access.token)) {
      return res.status(403).json(failBody('本地访问令牌无效', 403));
    }
    return next();
  });

  if (access.origins.size && !access.configuredToken) {
    console.warn('[server] 已配置 PI_ALLOWED_ORIGINS，但未配置 PI_HTTP_TOKEN；浏览器请求将无法取得本次随机令牌');
  }
}

export function startHttpServer(port) {
  const app = express();
  installBrowserBoundary(app);
  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: true, limit: '20mb' }));

  app.all('/api/*', async (req, res) => {
    const hit = match(req.method, req.path);
    if (!hit) return res.status(404).json(failBody(`接口未找到: ${req.method} ${req.path}`, 404));
    const { route, params } = hit;
    try {
      const input = { params, query: req.query || {}, body: req.body || {}, headers: req.headers || {} };

      // 流式 SSE
      if (route.stream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const controller = new AbortController();
        const onResponseClosed = () => {
          if (!res.writableEnded) controller.abort();
        };
        res.once('close', onResponseClosed);
        const emit = (event) => { try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* closed */ } };
        try {
          await route.fn(makeCtx({ signal: controller.signal }), input, emit);
        } catch (e) {
          const m = e instanceof ApiError ? e.message : '服务错误: ' + (e?.message || e);
          emit(createStreamEvent({
            type: StreamEventType.MESSAGE_DELTA,
            visibility: 'primary',
            payload: {
              block_id: 'transport:error',
              channel: 'error',
              format: 'error',
              mode: 'replace',
              content: m,
              title: '错误',
            },
          }));
          emit(createStreamEvent({ type: StreamEventType.RUN_FAILED, payload: { status: 'failed', message: m } }));
        } finally {
          res.off('close', onResponseClosed);
          try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* closed */ }
        }
        return;
      }

      const result = await route.fn(makeCtx({}), input);
      // 二进制下载
      if (result && result._binary) {
        const buf = Buffer.isBuffer(result.data) ? result.data : Buffer.from(result.data ?? '');
        if (result.headers) for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
        return res.status(result.status || 200).send(buf);
      }
      const data = result && typeof result === 'object' && 'data' in result ? result.data : (result ?? null);
      const message = (result && result.message) || '操作成功';
      res.json(okBody(data, message));
    } catch (e) {
      if (e instanceof ApiError) return res.status(e.status).json(failBody(e.message, e.code));
      console.error('[http usecase]', route.m, route.p, e?.message || e);
      res.status(500).json(failBody('服务错误: ' + (e?.message || e), 500));
    }
  });

  // 仅绑 loopback:HTTP server 专供本机 eval/CI 复用运行中的 server 实例,不暴露到局域网。
  const srv = app.listen(port, '127.0.0.1', () => console.log(`🟢 desktop server (node) HTTP(eval/CI) on http://127.0.0.1:${port}`));
  srv.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') console.warn(`[server] TCP ${port} 已占用,跳过监听`);
    else throw e;
  });
  return srv;
}
