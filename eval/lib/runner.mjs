function makeAssert() {
  return {
    ok(value, message = '断言失败') {
      if (!value) throw new Error(message);
    },
    eq(actual, expected, message = '值不相等') {
      if (!Object.is(actual, expected)) {
        throw new Error(`${message}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
      }
    },
    contains(value, expected, message = '未包含目标内容') {
      if (!String(value ?? '').includes(String(expected))) throw new Error(message);
    },
  };
}

export async function runTasks(driver, tasks, { filter = null, onResult = null } = {}) {
  const selected = filter ? tasks.filter((task) => task.id.includes(filter)) : tasks;
  const results = [];
  for (const task of selected) {
    const startedAt = Date.now();
    try {
      await task.run({ driver, assert: makeAssert() });
      results.push({ id: task.id, desc: task.desc, passed: true, durationMs: Date.now() - startedAt });
    } catch (error) {
      results.push({ id: task.id, desc: task.desc, passed: false, durationMs: Date.now() - startedAt, error: error?.message || String(error) });
    }
    onResult?.(results.at(-1), [...results]);
  }
  return results;
}

export function summarizeResults(results) {
  const passed = results.filter((result) => result.passed).length;
  return { total: results.length, passed, failed: results.length - passed };
}

export function report(results) {
  const summary = summarizeResults(results);
  for (const result of results) {
    console.log(`${result.passed ? '✓' : '✗'} ${result.id} (${result.durationMs}ms)${result.error ? `: ${result.error}` : ''}`);
  }
  console.log(`结果: ${summary.passed}/${summary.total} 通过`);
  return summary.failed === 0 && summary.total > 0;
}
