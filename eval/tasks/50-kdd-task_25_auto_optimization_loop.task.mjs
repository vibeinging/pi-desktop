import { unlinkSync } from 'node:fs';

import { buildKddQuestion, readGoldHeader } from '../lib/kdd-task.mjs';
import { goldPath, importTask, readTask, scanContext } from '../lib/kdd.mjs';
import { scoreKddColumns } from '../lib/runner.mjs';

const TASK_ID = 'task_25';

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
  for (let index = 0; index < 45; index += 1) {
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

function cleanupGenerated(outcome) {
  const files = outcome?.verification?.materialized?.files || {};
  for (const file of [files.task_path, files.payload_path]) {
    if (!file) continue;
    try { unlinkSync(file); } catch { /* 文件可能已被清理。 */ }
  }
}

export default {
  id: 'kdd-task_25_auto_optimization_loop',
  desc: '真实错题自动优化闭环：基线失败 → 独立 Gold → Trace 首次偏离 → agent_rule → Benchmark → 接受/回滚',
  async run({ driver, assert, loadGold, record }) {
    await driver.login();
    const api = (method, url, body) => driver.raw.api(method, url, body);
    const task = readTask(TASK_ID);
    const goldColumns = loadGold(goldPath(TASK_ID));
    const expectedItems = goldColumns.flat().map(String).filter(Boolean);
    const expectedAnswer = expectedItems.join('\n');
    const question = buildKddQuestion(task.question, {
      requireAnswerTable: true,
      outputColumns: readGoldHeader(TASK_ID),
    });
    const projectName = `kdd-${TASK_ID}-auto-opt-loop-${Date.now()}`;
    const pid = await driver.ensureProject(projectName);
    const imported = await importTask(driver, pid, scanContext(TASK_ID));
    const connId = imported.connIds[0];
    record({ task_id: TASK_ID, project_id: pid, project_name: projectName, connection_id: connId });

    const baseline = await driver.askQueryColumns(pid, connId, question);
    const baselineScore = scoreKddColumns(baseline.columns || [], goldColumns, {
      extraColLambda: 0.3,
      caseSensitive: true,
      roundDecimals: 2,
    });
    record({
      baseline: {
        session_id: baseline.sid,
        score: baselineScore.score,
        recall: baselineScore.recall,
        output_text: outputText(baseline.blocks),
        columns: baseline.columns || [],
      },
    });
    assert.ok(baselineScore.recall < 1, `基线稳定复现失败(recall=${baselineScore.recall})`);

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
      reason_text: '实际结果与已验证的 Gold Solve 不一致',
      expected_behavior: '在单笔 expense.cost 粒度上找全局最低值，返回与这些费用记录关联的所有并列活动；不得先按活动 SUM/AVG，最终只输出 event_name 列。',
      source: 'kdd-auto-optimization-eval',
    });
    assert.status(reviewResp, 200, '基线失败保存为 review');
    const review = dataOf(reviewResp);

    const draftResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/from-review`, {
      review_id: review.id,
      question,
      expected_behavior: '在单笔 expense.cost 粒度上找全局最低值，返回与这些费用记录关联的所有并列活动；不得先按活动 SUM/AVG，最终只输出 event_name 列。',
      expected_answer: expectedAnswer,
      assertion_type: 'text_contains',
      tags: ['kdd', 'auto-optimization', TASK_ID],
      failure_category: 'incomplete_extrema',
      replay_requirements: { project_name: projectName, connection_id: connId },
      trace_snapshot: traceSnapshot,
    });
    assert.status(draftResp, 200, 'review 生成自动优化 draft');
    const draft = dataOf(draftResp);

    const goldResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/gold-solve/generate`, {
      question,
      expected_behavior: draft.expected_behavior,
      expected_answer: expectedAnswer,
      assertion_type: 'text_contains',
    });
    assert.status(goldResp, 200, '从项目原始来源独立生成 Gold Solve');
    const generatedGold = dataOf(goldResp)?.gold_solve;
    assert.eq(generatedGold?.evidence_status, 'proven', 'Gold Solve 由真实来源探查证明');
    assert.ok((generatedGold?.evidence_probe_ids || []).length > 0, 'Gold Solve 保存真实探查编号');

    const verifyGoldResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/gold-solve`, {
      ...generatedGold,
      status: 'verified',
    });
    assert.status(verifyGoldResp, 200, 'Benchmark Gold 已确认，开放 Trace 诊断');
    const verifiedGold = dataOf(verifyGoldResp)?.gold_solve;

    const importResp = await api('POST', `/api/agent/projects/${pid}/trace-optimization/benchmark/cases/import`, {
      source_type: 'trace_draft',
      source_object_id: draft.id,
      raw_input: `KDD ${TASK_ID} automatic optimization`,
      cases: [{
        case_key: `${TASK_ID}-auto-optimization-loop`,
        title: '并列最低结果自动优化回归',
        question,
        expected_behavior: '在单笔 expense.cost 粒度上找全局最低值，返回与这些费用记录关联的所有并列活动；不得先按活动 SUM/AVG，最终只输出 event_name 列。',
        answer_type: 'list',
        assertion_type: 'list_match',
        assertion: { type: 'list_match', order: 'unordered' },
        gold: { items: expectedItems, order: 'unordered' },
        gold_solve: verifiedGold,
        metadata: { project_name: projectName, connection_id: connId },
        tags: ['kdd', 'auto-optimization', TASK_ID],
      }],
    });
    assert.status(importResp, 200, '导入同一项目的正式 Benchmark case');
    const benchmarkCase = dataOf(importResp)?.cases?.[0];
    assert.ok(Boolean(benchmarkCase?.id), 'Benchmark case 已创建');

    const optimizeResp = await api(
      'POST',
      `/api/agent/projects/${pid}/trace-optimization/drafts/${draft.id}/auto-optimize`,
      {
        benchmark_case_id: benchmarkCase.id,
        cdp_port: Number(process.env.CDP_PORT || 9333),
        timeout_ms: 600000,
        max_attempts: 3,
      },
    );
    assert.status(optimizeResp, 200, '自动优化端点完成诊断、试写和回归');
    const outcome = dataOf(optimizeResp);
    record({ auto_optimization: outcome });

    assert.eq(outcome?.diagnosis?.first_divergence?.span_id ? 'observed' : 'missing', 'observed', 'Trace 诊断定位真实第一次偏离 Span');
    assert.eq(outcome?.proposal?.change_type, 'agent_rule', '优化器生成 QueryAgent 通用规则');
    assert.eq(outcome?.attempt?.change_type, 'agent_rule', '规则先以试写方式应用');
    assert.eq(outcome?.verification?.run?.status, 'passed', '修改后正式 Benchmark 通过');
    assert.eq(outcome?.status, 'completed', '自动优化闭环完成');
    assert.eq(outcome?.finalization?.status, 'passed', 'Benchmark 通过后才接受修改');
    cleanupGenerated(outcome);
  },
};
