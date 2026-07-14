const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { BackendProcessManager } = require('../backend-process-manager.cjs');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.exitCode = null;
    this.signalCode = null;
    this.sent = [];
  }

  send(message, callback) {
    this.sent.push(message);
    callback?.(null);
  }

  disconnect() {
    this.connected = false;
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, null));
  }

  kill(signal) {
    this.connected = false;
    this.signalCode = signal;
    queueMicrotask(() => this.emit('exit', null, signal));
  }
}

function createManager(overrides = {}) {
  const children = [];
  const manager = new BackendProcessManager({
    spawnProcess: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    startupTimeoutMs: 100,
    requestTimeoutMs: 20,
    streamIdleTimeoutMs: 25,
    restartDelaysMs: [5, 5, 5],
    stableAfterMs: 100,
    ...overrides,
  });
  return { manager, children };
}

test('收到 ready 握手后才进入可用状态', async () => {
  const { manager, children } = createManager();
  const started = manager.start();
  assert.equal(manager.getState().status, 'starting');
  children[0].emit('message', { type: 'backend-ready' });
  await started;
  assert.equal(manager.getState().status, 'ready');
  manager.stopSync();
});

test('普通请求超时后返回明确错误并清理等待项', async () => {
  const { manager, children } = createManager();
  const started = manager.start();
  children[0].emit('message', { type: 'backend-ready' });
  await started;
  const error = await new Promise((resolve) => {
    manager.send({ id: 'q1', method: 'GET' }, (message) => {
      if (message.type === 'error') resolve(message);
      return message.type === 'error';
    });
  });
  assert.equal(error.code, 'BACKEND_TIMEOUT');
  assert.equal(manager.pending.size, 0);
  assert.deepEqual(children[0].sent.at(-1), { id: 'q1', type: 'abort' });
  manager.stopSync();
});

test('意外退出立即拒绝请求，并自动创建新的后端进程', async () => {
  const { manager, children } = createManager();
  const started = manager.start();
  children[0].emit('message', { type: 'backend-ready' });
  await started;
  const failed = new Promise((resolve) => {
    manager.send({ id: 'q2' }, (message) => {
      if (message.type === 'error') resolve(message);
      return message.type === 'error';
    });
  });
  children[0].emit('exit', 1, null);
  assert.equal((await failed).code, 'BACKEND_EXITED');
  assert.equal(manager.getState().status, 'restarting');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(children.length, 2);
  children[1].emit('message', { type: 'backend-ready' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(manager.getState().status, 'ready');
  manager.stopSync();
});

test('连续失败超过上限后进入 failed，正常停止不会重启', async () => {
  const { manager, children } = createManager({ restartDelaysMs: [2] });
  const first = manager.start();
  children[0].emit('exit', 1, null);
  await assert.rejects(first, /后端已退出/);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(children.length, 2);
  children[1].emit('exit', 1, null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(manager.getState().status, 'failed');
  await manager.stop();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(children.length, 2);
  assert.equal(manager.getState().status, 'stopped');
});
