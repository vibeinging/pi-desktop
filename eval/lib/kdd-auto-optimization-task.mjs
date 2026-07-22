import { unlinkSync } from 'node:fs';

import { buildKddQuestion, readGoldHeader } from './kdd-task.mjs';
import { goldPath, importTask, readTask, scanContext } from './kdd.mjs';
import { scoreKddColumns } from './runner.mjs';

function dataOf(response) {
  return response?.json?.data ?? response?.json ?? null;
}

function outputText(blocks) {
  return (blocks || []).map((block) => {
    const content = typeof block?.content === 'string'
      ? block.content
      : block?.content == null ? '' : JSON.stringify(block.content);
    return [block?.title, content].filter(Boolean).join('\n');
  }).filter(Boolean).join('\n').slice(0, 20000);
}

function tracePayload(response) {
  return response?.json?.data || response?.json || {};
}

async function waitForTrace(driver, pid, sid) {
  let last = null;
  for (let index = 0; index < 60; index += 1) {
    last = await driver.raw.api(
      'GET',
      `/api/agent/projects/${pid}/sessions/${sid}/traces?limit=5&resolve_trace=1`,
    ).catch(() => null);
    const items = tracePayload(last)?.items || [];
    const resolved = items.find((item) => item?.trace?.spans?.length);
    if (resolved) return resolved;
    await driver.raw.ev('await new Promise((resolve) => setTimeout(resolve, 1000))', { timeoutMs: 2500 }).catch(() => {});
  }
  return null;
}

function rowsFromColumns(columns) {
  const height = Math.max(0, ...columns.map((column) => column.length));
  return Array.from({ length: height }, (_unused, row) => columns.map((column) => column[row] ?? ''));
}

function markdownCell(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function expectedAnswerMarkdown(headers, rows) {
  const names = headers.length ? headers : rows[0]?.map((_value, index) => `column_${index + 1}`) || ['answer'];
  return [
    `| ${names.map(markdownCell).join(' | ')} |`,
    `| ${names.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(' | ')} |`),
  ].join('\n');
}

function cleanupGenerated(outcome) {
  const rounds = outcome?.rounds?.length ? outcome.rounds : [outcome];
  const files = new Set();
  for (const round of rounds) {
    const materialized = round?.verification?.materialized || round?.verification?.run?.materialized;
    if (materialized?.files?.task_path) files.add(materialized.files.task_path);
    if (materialized?.files?.payload_path) files.add(materialized.files.payload_path);
  }
  for (const file of files) {
    try { unlinkSync(file); } catch { /* 可能已由其他清理步骤删除。 */ }
  }
}

function genericExpectedBehavior(headers) {
  return [
    '保持原始问题的业务含义、过滤条件、聚合粒度和所有满足条件的结果，不在没有数据证据时改写口径。',
    `最终只输出指定列：${headers.join(', ') || '问题要求的答案列'}。`,
    '如果存在并列结果，必须全部保留；不要附加解释列、中间计算列或来源列。',
  ].join(' ');
}

function columnMatchFromBenchmark(outcome) {
  const checks = outcome?.verification?.run?.report?.results?.[0]?.checks || [];
  return checks.find((check) => check?.detail?.kind === 'column_match')?.detail || null;
}

export function makeKddAutoOptimizationTask(taskId, options = {}) {
  const task = readTask(taskId);
  return {
    id: options.id || `kdd-${taskId}-auto-optimization-loop`,
    desc: `真实自动优化：${task.question.slice(0, 72)}`,
    async run({ driver, assert, loadGold, record }) {
      await driver.login();
      const api = (method, url, body) => driver.raw.api(method, url, body);
      const goldColumns = loadGold(goldPath(taskId));
      const headers = readGoldHeader(taskId);
      const goldRows = rowsFromColumns(goldColumns);
      const expectedAnswer = expectedAnswerMarkdown(headers, goldRows);
      const expectedBehavior = genericExpectedBehavior(headers);
      const question = buildKddQuestion(task.question, {
        requireAnswerTable: true,
        outputColumns: headers,
      });
      const projectName = `kdd-${taskId}-auto-opt-${Date.now()}`;
      const pid = await driver.ensureProject(projectName);
      const imported = await importTask(driver, pid, scanContext(taskId));
      const connId = imported.connIds[0] || '';
      record({
        task_id: taskId,
        project_id: pid,
        project_name: projectName,
        connection_id: connId,
        gold_headers: headers,
        gold_row_count: goldRows.length,
      });

      const baseline = await driver.askQueryColumns(pid, connId, question);
      const baselineScore = scoreKddColumns(baseline.columns || [], goldColumns, {
        extraColLambda: 0.3,
        caseSensitive: true,
        roundDecimals: 2,
      });
      const baselinePassed = baselineScore.recall === 1 && baselineScore.score === 1;
      record({
        baseline: {
          session_id: baseline.sid,
          passed: baselinePassed,
          score: baselineScore.score,
          recall: baselineScore.recall,
          output_text: outputText(baseline.blocks),
          columns: baseline.columns || [],
        },
        column_match: {
          kind: 'column_match',
          phase: 'baseline',
          ...baselineScore,
        },
      });
      assert.ok((baseline.blocks || []).length > 0, '基线问数有输出');
      if (baselinePassed) {
        assert.ok(true, '基线已严格通过，无需生成优化规则');
        return;
      }

      const traceItem = await waitForTrace(driver, pid, baseline.sid);
      assert.ok(Boolean(traceItem?.trace?.spans?.length), '基线失败 Trace 已落库并可读取');
      if (!traceItem) return;
      const traceSnapshot = traceItem.trace;
      const traceId = traceSnapshot.traceId || traceSnapshot.externalTraceId || traceItem.traceId || '';

      const reviewResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/reviews`, {
        session_id: baseline.sid,
        run_id: traceItem.runId || '',
        trace_id: traceId,
        target_type: 'run',
        question,
        actual_output: outputText(baseline.blocks),
        trace_snapshot: traceSnapshot,
        status: 'incorrect',
        severity: 'high',
        reason_code: 'benchmark_failed',
        reason_text: '实际最终答案列与标准答案不一致',
        expected_behavior: expectedBehavior,
        source: 'kdd-auto-optimization-eval',
      });
      assert.status(reviewResp, 200, '基线失败保存为 review');
      if (reviewResp?.status !== 200) return;
      const review = dataOf(reviewResp);

      const draftResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/from-review`, {
        review_id: review.id,
        question,
        expected_behavior: expectedBehavior,
        expected_answer: expectedAnswer,
        assertion_type: 'table_match',
        tags: ['kdd', 'auto-optimization', taskId],
        failure_category: 'answer_mismatch',
        replay_requirements: { project_name: projectName, connection_id: connId },
        trace_snapshot: traceSnapshot,
      });
      assert.status(draftResp, 200, 'review 生成自动优化 draft');
      if (draftResp?.status !== 200) return;
      const draft = dataOf(draftResp);

      const goldResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/gold-solve/generate`, {
        question,
        expected_behavior: expectedBehavior,
        expected_answer: expectedAnswer,
        assertion_type: 'table_match',
      });
      assert.status(goldResp, 200, '从项目原始来源独立生成 Gold Solve');
      if (goldResp?.status !== 200) return;
      const generatedGold = dataOf(goldResp)?.gold_solve;
      assert.eq(generatedGold?.evidence_status, 'proven', 'Gold Solve 由真实来源探查证明');
      if (generatedGold?.evidence_status !== 'proven') return;

      const verifyGoldResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/gold-solve`, {
        ...generatedGold,
        status: 'verified',
      });
      assert.status(verifyGoldResp, 200, 'Gold Solve 已确认，开放 Trace 诊断');
      if (verifyGoldResp?.status !== 200) return;
      const verifiedGold = dataOf(verifyGoldResp)?.gold_solve;

      const importResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/benchmark/cases/import`, {
        source_type: 'trace_draft',
        source_object_id: draft.id,
        raw_input: `KDD ${taskId} automatic optimization`,
        cases: [{
          case_key: `${taskId}-auto-optimization-loop`,
          title: `${taskId} 自动优化回归`,
          question,
          expected_behavior: expectedBehavior,
          answer_type: 'table',
          assertion_type: 'table_match',
          assertion: {
            type: 'table_match',
            row_order: 'unordered',
            column_order: 'unordered',
            case_sensitive: true,
          },
          gold: {
            columns: headers.map((name) => ({ name, type: 'string' })),
            rows: goldRows,
            row_order: 'unordered',
            column_order: 'unordered',
          },
          gold_solve: verifiedGold,
          metadata: { project_name: projectName, connection_id: connId },
          tags: ['kdd', 'auto-optimization', taskId],
        }],
      });
      assert.status(importResp, 200, '导入正式 Benchmark case');
      if (importResp?.status !== 200) return;
      const benchmarkCase = dataOf(importResp)?.cases?.[0];
      assert.ok(Boolean(benchmarkCase?.id), 'Benchmark case 已创建');
      if (!benchmarkCase?.id) return;

      const optimizeResp = await api(
        'POST',
        `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/auto-optimize`,
        {
          benchmark_case_id: benchmarkCase.id,
          cdp_port: Number(process.env.CDP_PORT || 9333),
          timeout_ms: Number(options.benchmarkTimeoutMs || 600000),
          max_attempts: Number(options.maxAttempts || 3),
        },
      );
      assert.status(optimizeResp, 200, '自动优化完成诊断、试写和真实回归');
      if (optimizeResp?.status !== 200) return;
      const outcome = dataOf(optimizeResp);
      const optimizedColumnMatch = columnMatchFromBenchmark(outcome);
      record({
        draft_id: draft.id,
        benchmark_case_id: benchmarkCase.id,
        auto_optimization: outcome,
        ...(optimizedColumnMatch ? {
          column_match: {
            ...optimizedColumnMatch,
            phase: 'optimized',
          },
        } : {}),
      });
      cleanupGenerated(outcome);

      assert.ok(Boolean(outcome?.diagnosis?.first_divergence?.span_id), 'Trace 诊断定位真实第一次偏离 Span');
      assert.ok(['agent_rule', 'document_desc'].includes(outcome?.proposal?.change_type), '优化器生成可试写的通用修改');
      assert.eq(outcome?.verification?.run?.status, 'passed', '修改后正式 Benchmark 通过');
      assert.eq(outcome?.status, 'completed', '自动优化闭环完成');
      assert.eq(outcome?.finalization?.status, 'passed', '只有 Benchmark 通过后才接受修改');
    },
  };
}

export default { makeKddAutoOptimizationTask };
