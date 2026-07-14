const { EventEmitter } = require('node:events');

class BackendProcessManager extends EventEmitter {
  constructor({
    spawnProcess,
    startupTimeoutMs = 15_000,
    requestTimeoutMs = 30_000,
    streamIdleTimeoutMs = 300_000,
    restartDelaysMs = [1_000, 2_000, 5_000],
    stableAfterMs = 30_000,
    gracefulShutdownMs = 5_000,
    sigtermShutdownMs = 2_500,
  }) {
    super();
    if (typeof spawnProcess !== 'function') throw new TypeError('spawnProcess 必须是函数');
    this.spawnProcess = spawnProcess;
    this.startupTimeoutMs = startupTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.streamIdleTimeoutMs = streamIdleTimeoutMs;
    this.restartDelaysMs = restartDelaysMs;
    this.stableAfterMs = stableAfterMs;
    this.gracefulShutdownMs = gracefulShutdownMs;
    this.sigtermShutdownMs = sigtermShutdownMs;
    this.child = null;
    this.pending = new Map();
    this.restartAttempts = 0;
    this.restartTimer = null;
    this.startupTimer = null;
    this.stableTimer = null;
    this.stopping = false;
    this.state = { status: 'stopped', attempt: 0, error: null };
  }

  getState() {
    return { ...this.state };
  }

  _setState(status, extra = {}) {
    this.state = { status, attempt: this.restartAttempts, error: null, ...extra };
    this.emit('state', this.getState());
  }

  async start() {
    if (this.state.status === 'ready') return this.getState();
    if (this.child) return this.getState();
    this.stopping = false;
    return this._launch(this.restartAttempts > 0);
  }

  _launch(isRestart) {
    this._setState(isRestart ? 'restarting' : 'starting');
    let child;
    try {
      child = this.spawnProcess();
    } catch (error) {
      this._handleCrash(null, error);
      return Promise.reject(error);
    }
    this.child = child;

    return new Promise((resolve, reject) => {
      let settled = false;
      const settleReady = () => {
        if (settled) return;
        settled = true;
        resolve(this.getState());
      };
      const settleFailed = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      child.on('message', (message) => {
        if (message?.type === 'backend-ready') {
          if (this.child !== child || this.stopping) return;
          clearTimeout(this.startupTimer);
          this.startupTimer = null;
          this._setState('ready');
          clearTimeout(this.stableTimer);
          this.stableTimer = setTimeout(() => {
            if (this.child === child && this.state.status === 'ready') this.restartAttempts = 0;
          }, this.stableAfterMs);
          settleReady();
          return;
        }
        if (message?.type === 'credential-request') {
          this.emit('backend-message', message, child);
          return;
        }
        this._routeMessage(message);
      });
      child.once('error', (error) => {
        settleFailed(error);
        this._handleCrash(child, error);
      });
      child.once('exit', (code, signal) => {
        const error = new Error(`后端已退出 (code=${code ?? 'null'}, signal=${signal || 'none'})`);
        error.code = 'BACKEND_EXITED';
        settleFailed(error);
        this._handleCrash(child, error);
      });
      this.startupTimer = setTimeout(() => {
        if (this.child !== child || this.state.status === 'ready') return;
        const error = new Error('后端启动超时');
        error.code = 'BACKEND_START_TIMEOUT';
        settleFailed(error);
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        this._handleCrash(child, error);
      }, this.startupTimeoutMs);
    });
  }

  _handleCrash(child, error) {
    if (child && this.child !== child) return;
    clearTimeout(this.startupTimer);
    clearTimeout(this.stableTimer);
    this.startupTimer = null;
    this.stableTimer = null;
    this.child = null;
    this.rejectAll(error?.message || '后端已退出', error?.code || 'BACKEND_EXITED');
    if (this.stopping) {
      this._setState('stopped');
      return;
    }
    this._setState('unhealthy', { error: error?.message || '后端已退出' });
    if (this.restartAttempts >= this.restartDelaysMs.length) {
      this._setState('failed', { error: error?.message || '后端连续启动失败' });
      return;
    }
    const delay = this.restartDelaysMs[this.restartAttempts];
    this.restartAttempts += 1;
    this._setState('restarting', { retry_in_ms: delay, error: error?.message || '后端已退出' });
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this._launch(true).catch(() => {});
    }, delay);
  }

  send(message, handler, { timeoutMs, stream = false } = {}) {
    const id = message?.id;
    if (id === null || id === undefined || typeof handler !== 'function') throw new TypeError('后端请求参数无效');
    if (this.state.status !== 'ready' || !this.child?.connected) {
      queueMicrotask(() => handler({ id, type: 'error', code: 'BACKEND_UNAVAILABLE', error: '本地后端暂不可用' }));
      return false;
    }
    const record = {
      handler,
      stream,
      timeoutMs: timeoutMs ?? (stream ? this.streamIdleTimeoutMs : this.requestTimeoutMs),
      timer: null,
    };
    this.pending.set(id, record);
    this._armTimeout(id, record);
    try {
      this.child.send(message, (error) => {
        if (error) this._failOne(id, 'BACKEND_SEND_FAILED', error.message || '后端发送失败');
      });
      return true;
    } catch (error) {
      this._failOne(id, 'BACKEND_SEND_FAILED', error?.message || '后端发送失败');
      return false;
    }
  }

  _armTimeout(id, record) {
    clearTimeout(record.timer);
    record.timer = setTimeout(() => {
      this._failOne(id, record.stream ? 'BACKEND_STREAM_IDLE_TIMEOUT' : 'BACKEND_TIMEOUT', record.stream ? '后端流响应长时间没有数据' : '后端请求超时');
      try { this.child?.send({ id, type: 'abort' }); } catch { /* ignore */ }
    }, record.timeoutMs);
  }

  _routeMessage(message) {
    if (!message || message.id === null || message.id === undefined) return;
    const record = this.pending.get(message.id);
    if (!record) return;
    if (record.stream) this._armTimeout(message.id, record);
    let done = false;
    try { done = record.handler(message) === true; } catch { done = true; }
    if (done || message.type === 'end' || message.type === 'error') this._clearPending(message.id);
  }

  _failOne(id, code, message) {
    const record = this.pending.get(id);
    if (!record) return;
    this._clearPending(id);
    try { record.handler({ id, type: 'error', code, error: message }); } catch { /* ignore */ }
  }

  _clearPending(id) {
    const record = this.pending.get(id);
    if (record) clearTimeout(record.timer);
    this.pending.delete(id);
  }

  abort(id) {
    this._clearPending(id);
    try { this.child?.send({ id, type: 'abort' }); } catch { /* ignore */ }
  }

  rejectAll(message, code = 'BACKEND_EXITED') {
    for (const id of [...this.pending.keys()]) this._failOne(id, code, message);
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.startupTimer);
    clearTimeout(this.stableTimer);
    this.restartTimer = null;
    this._setState('stopping');
    this.rejectAll('后端正在关闭', 'BACKEND_STOPPING');
    const child = this.child;
    this.child = null;
    if (!child) {
      this._setState('stopped');
      return;
    }
    if (child.connected) {
      try { child.disconnect(); } catch { /* ignore */ }
      if (await this._waitForExit(child, this.gracefulShutdownMs)) {
        this._setState('stopped');
        return;
      }
    }
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    if (!(await this._waitForExit(child, this.sigtermShutdownMs))) {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      await this._waitForExit(child, 1_000);
    }
    this._setState('stopped');
  }

  async restart() {
    await this.stop();
    this.restartAttempts = 0;
    this.stopping = false;
    return this.start();
  }

  stopSync() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.startupTimer);
    clearTimeout(this.stableTimer);
    this.rejectAll('后端正在关闭', 'BACKEND_STOPPING');
    try { this.child?.kill('SIGTERM'); } catch { /* ignore */ }
    this.child = null;
  }

  _waitForExit(child, timeoutMs) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.off('exit', onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once('exit', onExit);
    });
  }
}

module.exports = { BackendProcessManager };
