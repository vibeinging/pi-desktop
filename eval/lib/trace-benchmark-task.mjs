import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTask, scanContextDir } from './kdd.mjs';
import { extractColumnsFromBlocks } from './driver.mjs';
import { scoreKddColumns } from './runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GENERATED_ROOT = path.resolve(__dirname, '../generated/trace-benchmark');

function text(value) {
  if (value == null) return '';
  return String(value);
}

function clip(value, max = 8000) {
  const body = text(value);
  return body.length > max ? `${body.slice(0, max)}...` : body;
}

function previewBlocks(blocks) {
  return (blocks || []).slice(0, 20).map((block) => ({
    id: block?.id || '',
    type: block?.type || '',
    title: block?.title || '',
    content: clip(block?.content, 4000),
    metadata: Object.fromEntries(
      Object.entries(block?.metadata || {}).map(([key, value]) => [
        key,
        typeof value === 'string' ? clip(value, 4000) : value,
      ]),
    ),
  }));
}

function outputText(blocks) {
  return (blocks || []).map((block) => {
    const parts = [block?.type, block?.title, block?.content];
    return parts.filter(Boolean).join(' ');
  }).join('\n').trim();
}

function flattenGold(gold) {
  if (gold == null) return [];
  if (Array.isArray(gold)) return gold.flatMap(flattenGold);
  if (typeof gold !== 'object') return [gold];
  if (Array.isArray(gold.items)) return gold.items.flatMap(flattenGold);
  if (Array.isArray(gold.rows)) return gold.rows.flatMap((row) => {
    if (Array.isArray(row)) return row.flatMap(flattenGold);
    if (row && typeof row === 'object') return Object.values(row).flatMap(flattenGold);
    return flattenGold(row);
  });
  if (gold.value !== undefined) return [gold.value];
  return Object.values(gold).flatMap(flattenGold);
}

function goldColumns(gold) {
  if (!gold || typeof gold !== 'object' || !Array.isArray(gold.rows) || !gold.rows.length) return [];
  const rows = gold.rows;
  if (Array.isArray(rows[0])) {
    const width = Math.max(...rows.map((row) => Array.isArray(row) ? row.length : 0));
    return Array.from({ length: width }, (_unused, column) => rows.map((row) => row?.[column] ?? ''));
  }
  if (rows[0] && typeof rows[0] === 'object') {
    const declared = Array.isArray(gold.columns)
      ? gold.columns.map((column) => typeof column === 'string' ? column : column?.name).filter(Boolean)
      : [];
    const names = declared.length ? declared : Object.keys(rows[0]);
    return names.map((name) => rows.map((row) => row?.[name] ?? ''));
  }
  return [rows];
}

function textContains(actual, expected) {
  const expectedText = text(expected).trim();
  if (!expectedText) return true;
  if (actual.includes(expectedText)) return true;
  const noCommaExpected = expectedText.replace(/,/g, '');
  if (actual.replace(/,/g, '').includes(noCommaExpected)) return true;
  const num = Number(noCommaExpected);
  if (Number.isFinite(num)) {
    const matches = actual.match(/-?[\d,]+\.?\d*/g) || [];
    return matches.some((item) => Math.abs(Number(item.replace(/,/g, '')) - num) < 0.01);
  }
  return false;
}

function generatedPayload(taskId) {
  const file = path.join(GENERATED_ROOT, `${taskId}.json`);
  if (!existsSync(file)) throw new Error(`generated trace benchmark payload not found: ${file}`);
  return JSON.parse(readFileSync(file, 'utf-8'));
}

export async function ensureTraceBenchmarkProject(driver, projectName, execution = {}) {
  return execution.connection_id || execution.conn_id
    ? driver.ensureProjectRecord(projectName)
    : driver.ensureProject(projectName);
}

export function caseAssertions(assert, payload, blocks) {
  const testCase = payload.case || {};
  const assertion = testCase.assertion || {};
  const allText = (blocks || []).map((b) => {
    if (!b) return '';
    const parts = [b.type, b.title];
    if (typeof b.content === 'string') parts.push(b.content);
    else if (b.content != null) {
      try { parts.push(JSON.stringify(b.content)); } catch { parts.push(String(b.content)); }
    }
    return parts.filter(Boolean).join(' ');
  }).join(' ');

  const assertionType = testCase.assertion_type || assertion.type || 'manual';
  if (assertionType === 'manual' || assertionType === 'llm_judge') {
    assert.ok(true, `(${assertionType} 需要人工复核,自动回归只校验有输出)`);
    return;
  }
  if (assertionType === 'has_sql') {
    assert.hasSql(blocks, '产出 SQL');
    return;
  }

  const expected = flattenGold(testCase.gold);
  if (!expected.length) {
    assert.ok(false, 'Benchmark case 缺少可自动断言的 gold');
    return;
  }

  if (assertionType === 'list_match' || assertionType === 'table_match') {
    const predictedColumns = extractColumnsFromBlocks(blocks);
    const expectedColumns = assertionType === 'table_match' ? goldColumns(testCase.gold) : [expected];
    const score = scoreKddColumns(predictedColumns, expectedColumns, {
      extraColLambda: 0.3,
      caseSensitive: assertion.case_sensitive !== false,
      roundDecimals: 2,
    });
    assert.ok(
      score.recall === 1 && score.score === 1,
      `最终答案列与 gold 严格匹配(score=${score.score} recall=${score.recall} penalty=${score.extraColPenalty})`,
    );
    return;
  }

  const mode = assertion.order === 'ordered' || assertion.row_order === 'ordered' ? 'ordered' : 'all';
  if (mode === 'ordered') {
    let cursor = 0;
    let passed = 0;
    for (const item of expected) {
      const needle = text(item);
      const index = allText.indexOf(needle, cursor);
      if (index >= 0) {
        passed += 1;
        cursor = index + needle.length;
      }
    }
    assert.ok(passed === expected.length, `有序 gold 命中(${passed}/${expected.length})`);
    return;
  }

  const hits = expected.filter((item) => textContains(allText, item));
  assert.ok(hits.length === expected.length, `gold 命中(${hits.length}/${expected.length})`);
}

export function makeTraceBenchmarkTask(taskId) {
  return {
    id: taskId,
    desc: '',
    async run({ driver, assert, record }) {
      const payload = generatedPayload(taskId);
      const testCase = payload.case || {};
      this.desc = `[trace-benchmark] ${(testCase.question || taskId).slice(0, 50)}`;
      record?.({
        kind: 'trace_benchmark',
        task_id: taskId,
        benchmark_case_id: testCase.id || '',
        case_key: testCase.case_key || '',
        question: testCase.question || '',
        answer_type: testCase.answer_type || '',
        assertion_type: testCase.assertion_type || '',
        tags: testCase.tags || [],
        runnable: Boolean(payload.runnable),
        generated_at: payload.generated_at || '',
      });

      const execution = payload.execution || {};
      const projectName = execution.project_name || `trace-benchmark-${taskId}`;
      // 已给出现成 connection_id 时必须复用项目数据源。通用 ensureProject 会为
      // 重复导入型 eval 清理旧数据源，在回评场景中会把正在验证的连接直接删掉。
      const pid = await ensureTraceBenchmarkProject(driver, projectName, execution);
      record?.({ eval_project_id: pid, eval_project_name: projectName });

      let connId = execution.connection_id || execution.conn_id || '';
      const contextDir = path.join(GENERATED_ROOT, taskId, 'context');
      if (!connId && existsSync(contextDir)) {
        const imported = await importTask(driver, pid, scanContextDir(contextDir));
        connId = imported.connId;
      }
      record?.({ connection_id: connId || '' });

      assert.ok(Boolean(connId), '存在可重放数据源连接或 generated context');
      if (!connId) return;

      const result = await driver.askQueryColumns(pid, connId, testCase.question);
      record?.({
        session_id: result.sid || '',
        output_text: clip(outputText(result.blocks || []), 12000),
        output_blocks: previewBlocks(result.blocks || []),
        columns: result.columns || [],
      });
      assert.ok(result.blocks.length > 0, '问数有输出');
      caseAssertions(assert, payload, result.blocks);
    },
  };
}
