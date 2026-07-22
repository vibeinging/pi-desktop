import assert from 'node:assert/strict';
import test from 'node:test';

import { runTasks } from '../lib/runner.mjs';

test('runner 按指定并发数执行并保持任务顺序', async () => {
  let running = 0;
  let maxRunning = 0;
  const tasks = Array.from({ length: 7 }, (_, index) => ({
    id: `task-${index}`,
    desc: '',
    async run({ assert: taskAssert }) {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      taskAssert.ok(true, '完成');
    },
  }));

  const results = await runTasks({}, tasks, { concurrency: 3 });

  assert.equal(maxRunning, 3);
  assert.deepEqual(results.map((result) => result.id), tasks.map((task) => task.id));
  assert.equal(results.every((result) => result.pass), true);
});

test('runner 把过滤后的任务稳定分片', async () => {
  const tasks = Array.from({ length: 10 }, (_, index) => ({
    id: `kdd-${index}`,
    desc: '',
    async run({ assert: taskAssert }) { taskAssert.ok(true, '完成'); },
  }));

  const results = await runTasks({}, tasks, { filter: 'kdd', shardIndex: 1, shardCount: 3 });

  assert.deepEqual(results.map((result) => result.id), ['kdd-1', 'kdd-4', 'kdd-7']);
});

test('runner 用等号前缀精确匹配任务 ID', async () => {
  const tasks = ['kdd-task_19', 'kdd-task_194', 'kdd-task_196'].map((id) => ({
    id,
    desc: '',
    async run({ assert: taskAssert }) { taskAssert.ok(true, '完成'); },
  }));

  const results = await runTasks({}, tasks, { filter: '=kdd-task_19' });

  assert.deepEqual(results.map((result) => result.id), ['kdd-task_19']);
});

test('runner 排除对照任务并保持串行顺序', async () => {
  const tasks = ['kdd-task_1', 'kdd-task_1_auto_opt', 'kdd-task_2'].map((id) => ({
    id,
    desc: '',
    async run({ assert: taskAssert }) { taskAssert.ok(true, '完成'); },
  }));

  const results = await runTasks({}, tasks, { filter: 'kdd', exclude: '_auto_opt', concurrency: 1 });

  assert.deepEqual(results.map((result) => result.id), ['kdd-task_1', 'kdd-task_2']);
});

test('runner 用等号前缀精确排除任务 ID', async () => {
  const tasks = ['kdd-task_25', 'kdd-task_259'].map((id) => ({
    id,
    desc: '',
    async run({ assert: taskAssert }) { taskAssert.ok(true, '完成'); },
  }));

  const results = await runTasks({}, tasks, { exclude: '=kdd-task_25', concurrency: 1 });

  assert.deepEqual(results.map((result) => result.id), ['kdd-task_259']);
});
