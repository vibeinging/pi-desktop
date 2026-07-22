import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  executeGoldSourceAction,
  normalizeGoldEvidencePayload,
  runGoldEvidenceLoop,
} from '../../server/src/app/traces/trace_optimization/gold_evidence.js';
import {
  assertGoldReadyForTrace,
  diagnoseDraft,
  normalizeDiagnosisPayload,
  normalizeTuningProposalPayload,
  saveGoldSolve,
} from '../../server/src/app/traces/trace_optimization/gold.js';
import {
  acceptTuningChange,
  applyTuningChange,
  rollbackTuningChange,
} from '../../server/src/app/traces/trace_optimization/changes.js';
import { makeCtx } from '../../server/src/ctx.js';
import { query, queryOne } from '../../server/src/db.js';

test('gold evidence loop solves from source probes without seeing actual output or Trace', async () => {
  const calls = [];
  const result = await runGoldEvidenceLoop({
    baseInput: {
      question: '合同约定的付款日是什么时候？',
      expected_answer: '验收后 30 日内',
    },
    inventory: {
      sources: [{ source_id: 'docs-1', name: '合同库', type: 'documents' }],
      documents: [{ source_id: 'docs-1', document_id: 'doc-1', title: '采购合同.md', status: 'ready', path: 'documents/doc-1.md' }],
    },
    async runStep(input) {
      calls.push(input);
      assert.equal(Object.hasOwn(input, 'actual_output'), false);
      assert.equal(Object.hasOwn(input, 'trace_snapshot'), false);
      assert.equal(Object.hasOwn(input, 'trace_evidence_pack'), false);
      if (calls.length === 1) {
        return { data: { next_source_actions: [{ type: 'read_document', document_id: 'doc-1', line_start: 1, line_limit: 20 }] } };
      }
      return {
        data: {
          intent_summary: '读取合同付款条款',
          sources: [{ source_id: 'docs-1', name: '采购合同.md', source_type: 'document', modality: 'text', probe_ids: ['probe_1'] }],
          steps: [{ id: 'step-1', type: 'extract', description: '读取付款条款', probe_ids: ['probe_1'] }],
          cross_source_links: [],
          output_shape: { fields: ['付款期限'], unit: '日' },
          evidence_probe_ids: ['probe_1'],
          final_answer_contract: '返回付款期限',
        },
      };
    },
    async executeAction(action, probeId) {
      return {
        probe_id: probeId,
        type: action.type,
        ok: true,
        evidence: true,
        action,
        source_refs: [{ source_id: 'docs-1', name: '采购合同.md', source_type: 'document', modality: 'text' }],
        locator: { document_id: 'doc-1', line_start: 1, line_end: 20 },
        result: { text: '验收后 30 日内付款' },
      };
    },
  });

  assert.equal(calls.length, 2);
  const normalized = normalizeGoldEvidencePayload(result.data, result.probes, {
    question: calls[0].question,
    expected_answer: calls[0].expected_answer,
  });
  assert.equal(normalized.evidence_status, 'proven');
  assert.deepEqual(normalized.evidence_probe_ids, ['probe_1']);
  assert.equal(normalized.sources[0].source_type, 'document');
  assert.equal(normalized.reference_sql, '');
});

test('gold evidence loop rejects schema-only proof and requires a final SQL result matching expected answer', async () => {
  const calls = [];
  const result = await runGoldEvidenceLoop({
    baseInput: {
      question: 'Which event has the lowest cost?',
      expected_answer: 'November Speaker\nOctober Speaker\nSeptember Speaker',
    },
    inventory: { sources: [{ source_id: 'db-1', name: 'student_club', type: 'database' }] },
    async runStep(input) {
      calls.push(input);
      if (calls.length === 1) {
        return { data: { next_source_actions: [{ type: 'read_schema', source_id: 'db-1' }] } };
      }
      if (calls.length === 2) {
        return {
          data: {
            intent_summary: '只根据 Schema 猜测',
            evidence_probe_ids: ['probe_1'],
            reference_sql: 'select event_name from event',
            output_shape: { fields: ['event_name'] },
          },
        };
      }
      if (calls.length === 3) {
        assert.match(input.source_evidence.probes.at(-1).error, /Schema/);
        return {
          data: {
            next_source_actions: [{
              type: 'execute_sql',
              source_id: 'db-1',
              sql: 'select event_name from expense join budget using (budget_id) join event using (event_id) where cost = (select min(cost) from expense)',
            }],
          },
        };
      }
      return {
        data: {
          intent_summary: '查找最低单笔费用对应的活动',
          evidence_probe_ids: ['probe_2'],
          reference_sql: 'unexecuted sql must not win',
          output_shape: { fields: ['event_name'] },
        },
      };
    },
    async executeAction(action, probeId) {
      if (action.type === 'read_schema') {
        return { probe_id: probeId, type: action.type, ok: true, evidence: true, action, result: { schema: 'expense(cost)' } };
      }
      return {
        probe_id: probeId,
        type: action.type,
        ok: true,
        evidence: true,
        action,
        result: {
          rows: [
            { event_name: 'November Speaker' },
            { event_name: 'October Speaker' },
            { event_name: 'September Speaker' },
          ],
        },
      };
    },
  });

  assert.equal(calls.length, 4);
  const normalized = normalizeGoldEvidencePayload(result.data, result.probes, {
    question: calls[0].question,
    expected_answer: calls[0].expected_answer,
  });
  assert.equal(normalized.evidence_status, 'proven');
  assert.match(normalized.reference_sql, /min\(cost\)/i);
});

test('structured gold proof rejects an executed SQL result with the wrong answer rows', () => {
  const expected = 'November Speaker\nOctober Speaker\nSeptember Speaker';
  const probe = {
    probe_id: 'probe_sql',
    type: 'execute_sql',
    ok: true,
    evidence: true,
    action: { type: 'execute_sql', source_id: 'db-1', sql: 'select event_name from wrong_totals' },
    result: {
      rows: [
        { event_name: 'Officers meeting - November' },
        { event_name: 'Officers meeting - October' },
        { event_name: 'Officers meeting - September' },
      ],
    },
  };
  const normalized = normalizeGoldEvidencePayload({ evidence_probe_ids: ['probe_sql'] }, [probe], {
    expected_answer: expected,
  });
  assert.equal(normalized.evidence_status, 'unproven');
  assert.match(normalized.warnings.join('\n'), /expected_answer/);
});

test('structured gold proof validates a multi-column Markdown expected answer', () => {
  const expected = '| first_name | last_name |\n|---|---|\n| Ava | Chen |\n| Noah | Li |';
  const probe = {
    probe_id: 'probe_sql',
    type: 'execute_sql',
    ok: true,
    evidence: true,
    action: { type: 'execute_sql', source_id: 'db-1', sql: 'select first_name, last_name from member' },
    result: { rows: [{ first_name: 'Noah', last_name: 'Li' }, { first_name: 'Ava', last_name: 'Chen' }] },
  };
  const normalized = normalizeGoldEvidencePayload({ evidence_probe_ids: ['probe_sql'] }, [probe], {
    expected_answer: expected,
  });
  assert.equal(normalized.evidence_status, 'proven');
});

test('cross-source gold proof requires linked probes and values from real source results', () => {
  const probes = [
    {
      probe_id: 'probe_events', type: 'execute_sql', ok: true, evidence: true,
      action: { type: 'execute_sql', source_id: 'db-events', sql: 'select event_id, type from event' },
      source_refs: [{ source_id: 'db-events', name: 'events' }],
      result: { rows: [{ event_id: 'e1', type: 'Meeting' }] },
    },
    {
      probe_id: 'probe_expenses', type: 'execute_sql', ok: true, evidence: true,
      action: { type: 'execute_sql', source_id: 'db-expenses', sql: 'select event_id, total from expense' },
      source_refs: [{ source_id: 'db-expenses', name: 'expenses' }],
      result: { rows: [{ event_id: 'e1', total: 42 }] },
    },
  ];
  const expected = '| type | total |\n|---|---|\n| Meeting | 42 |';
  const normalized = normalizeGoldEvidencePayload({
    evidence_probe_ids: ['probe_events', 'probe_expenses'],
    steps: [{ description: '按 event_id 关联', probe_ids: ['probe_events', 'probe_expenses'] }],
    cross_source_links: [{ description: '按 event_id 关联', probe_ids: ['probe_events', 'probe_expenses'] }],
  }, probes, { expected_answer: expected });
  assert.equal(normalized.evidence_status, 'proven');

  const unlinked = normalizeGoldEvidencePayload({
    evidence_probe_ids: ['probe_events', 'probe_expenses'],
  }, probes, { expected_answer: expected });
  assert.equal(unlinked.evidence_status, 'unproven');
});

test('document source probe reads converted Markdown and preserves line locator', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yiw-gold-doc-'));
  await writeFile(join(root, 'contract.md'), '# 合同\n\n付款条件：验收后 30 日内。\n', 'utf8');
  const sourceContext = {
    projectId: 'project-1',
    workspace: { root },
    inventory: {
      sources: [{ source_id: 'docs-1', name: '合同库', type: 'documents' }],
      documents: [{
        source_id: 'docs-1',
        source_name: '合同库',
        document_id: 'doc-1',
        title: '采购合同.pdf',
        status: 'ready',
        path: 'contract.md',
        file_ext: 'pdf',
        modality: 'pdf',
      }],
    },
    bds: {},
  };
  const probe = await executeGoldSourceAction(sourceContext, {
    type: 'read_document',
    document_id: 'doc-1',
    line_start: 1,
    line_limit: 10,
  }, 'probe_doc');

  assert.equal(probe.ok, true);
  assert.equal(probe.evidence, true);
  assert.equal(probe.source_refs[0].modality, 'pdf');
  assert.equal(probe.locator.document_id, 'doc-1');
  assert.match(probe.result.text, /验收后 30 日内/);
});

test('gold evidence path supports database plus document and rejects unknown probes', () => {
  const probes = [
    {
      probe_id: 'probe_sql', type: 'execute_sql', ok: true, evidence: true,
      action: { type: 'execute_sql', source_id: 'db-1', sql: 'select customer_id, amount from sales' },
      source_refs: [{ source_id: 'db-1', name: '销售库', source_type: 'database', modality: 'structured' }],
      locator: { source_id: 'db-1', sql: 'select customer_id, amount from sales' },
      result: { rows: [{ customer_id: 1, amount: 100 }] },
    },
    {
      probe_id: 'probe_doc', type: 'read_document', ok: true, evidence: true,
      action: { type: 'read_document', document_id: 'doc-1' },
      source_refs: [{ source_id: 'docs-1', name: '客户分级.md', source_type: 'document', modality: 'text' }],
      locator: { document_id: 'doc-1', line_start: 10, line_end: 15 },
      result: { text: '客户 1 为重点客户' },
    },
  ];
  const path = normalizeGoldEvidencePayload({
    sources: [
      { source_id: 'db-1', name: '销售库', source_type: 'database', probe_ids: ['probe_sql'] },
      { source_id: 'docs-1', name: '客户分级.md', source_type: 'document', probe_ids: ['probe_doc'] },
    ],
    steps: ['读取销售额', '读取客户分级', '按 customer_id 合并'],
    cross_source_links: [{ id: 'join-1', type: 'join', description: '按 customer_id 对齐', probe_ids: ['probe_sql', 'probe_doc'] }],
    output_shape: { fields: ['customer_id', 'amount', 'level'] },
    evidence_probe_ids: ['probe_sql', 'probe_doc'],
  }, probes);
  assert.equal(path.sources.length, 2);
  assert.equal(path.cross_source_links[0].type, 'join');
  assert.deepEqual(path.evidence_probe_ids, ['probe_sql', 'probe_doc']);

  assert.throws(() => normalizeGoldEvidencePayload({ evidence_probe_ids: ['missing_probe'] }, probes), /未成功执行/);
});

test('Trace diagnosis requires a verified gold solve', () => {
  assert.throws(() => assertGoldReadyForTrace(null), /先完成并确认独立参考解/);
  assert.throws(() => assertGoldReadyForTrace({ status: 'drafted' }), /先完成并确认独立参考解/);
  assert.equal(assertGoldReadyForTrace({ status: 'verified' }).status, 'verified');
});

test('diagnosis keeps the first divergence only when it points to an observed real span', () => {
  const traceSnapshot = {
    spans: [
      { externalSpanId: 'root-span', kind: 'agent', name: 'WorkspaceAgent', depth: 0 },
      { externalSpanId: 'query-span', parentId: 'root-span', kind: 'tool', name: 'QueryAgent', depth: 1 },
    ],
  };
  const evidencePack = {
    evidence_spans: [{ span_id: 'query-span' }],
  };
  const diagnosis = normalizeDiagnosisPayload({
    failure_stage: 'document_recall',
    summary: '没有找到目标文档',
    first_divergence: { stage: 'document_recall', gold_step_id: 'step-2', span_id: 'query-span', summary: '召回为空' },
    evidence_path: [{ span_id: 'query-span', observation: '工具未返回目标文档' }],
  }, traceSnapshot, evidencePack);
  assert.equal(diagnosis.failure_stage, 'document_recall');
  assert.equal(diagnosis.first_divergence.span_id, 'query-span');
  assert.equal(diagnosis.evidence_path.length, 1);

  const invalid = normalizeDiagnosisPayload({
    failure_stage: 'document_recall',
    first_divergence: { span_id: 'invented-span' },
    evidence_path: [{ span_id: 'invented-span', observation: '不存在' }],
  }, traceSnapshot, evidencePack);
  assert.equal(invalid.failure_stage, 'trace_incomplete');
  assert.equal(invalid.first_divergence, null);
  assert.match(invalid.warnings.join('\n'), /不存在的 Trace Span/);
});

test('diagnosis endpoint rejects Trace access before gold verification', async () => {
  const suffix = randomUUID();
  const pid = `__gold_gate_${suffix}`;
  const draftId = `draft-${suffix}`;
  await query(
    `INSERT INTO trace_eval_drafts
       (id, review_id, project_id, run_id, trace_id, question, expected_answer, assertion_type,
        status, benchmark_status, trace_snapshot_json, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'问题','答案','text_contains','reviewable','reviewable','{}',now(),now())`,
    [draftId, `review-${suffix}`, pid, `run-${suffix}`, `trace-${suffix}`],
  );
  await assert.rejects(
    diagnoseDraft(makeCtx({ userId: null }), { params: { pid, draftId }, body: {} }),
    (error) => error?.status === 409 && /先完成并确认独立参考解/.test(error.message),
  );
});

test('gold solve persists multimodal evidence while keeping legacy fields', async () => {
  const suffix = randomUUID();
  const pid = `__gold_save_${suffix}`;
  const draftId = `draft-${suffix}`;
  await query(
    `INSERT INTO trace_eval_drafts
       (id, review_id, project_id, run_id, trace_id, question, expected_answer, assertion_type,
        status, benchmark_status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'问题','答案','text_contains','reviewable','reviewable',now(),now())`,
    [draftId, `review-${suffix}`, pid, `run-${suffix}`, `trace-${suffix}`],
  );
  await assert.rejects(
    saveGoldSolve(makeCtx({ userId: null }), {
      params: { pid, draftId },
      body: {
        evidence_status: 'proven',
        evidence_probe_ids: ['missing-probe'],
        source_probes: [],
      },
    }),
    (error) => error?.status === 422 && /未成功执行/.test(error.message),
  );
  const saved = await saveGoldSolve(makeCtx({ userId: null }), {
    params: { pid, draftId },
    body: {
      intent_summary: '合并销售库和客户说明',
      data_sources: ['销售库', '客户说明'],
      reference_steps: ['查询销售额', '读取客户说明', '合并'],
      reference_sql: 'select customer_id, amount from sales',
      sources: [
        { source_id: 'db-1', name: '销售库', source_type: 'database', probe_ids: ['probe_sql'] },
        { source_id: 'doc-1', name: '客户说明', source_type: 'document', probe_ids: ['probe_doc'] },
      ],
      steps: [{ id: 'step-1', type: 'join', description: '按 customer_id 合并', probe_ids: ['probe_sql', 'probe_doc'] }],
      cross_source_links: [{ id: 'join-1', type: 'join', description: '按 customer_id 对齐' }],
      output_shape: { fields: ['customer_id', 'amount', 'level'] },
      evidence_probe_ids: ['probe_sql', 'probe_doc'],
      source_probes: [
        {
          probe_id: 'probe_sql', type: 'execute_sql', ok: true, evidence: true,
          action: { type: 'execute_sql', source_id: 'db-1', sql: 'select customer_id, amount from sales' },
          result: { rows: [{ customer_id: 1, amount: 100 }] },
        },
        {
          probe_id: 'probe_doc', type: 'read_document', ok: true, evidence: true,
          action: { type: 'read_document', document_id: 'doc-1' },
          result: { text: '客户说明支持答案' },
        },
      ],
      evidence_status: 'proven',
      status: 'verified',
    },
  });
  assert.equal(saved.data.gold_solve.status, 'verified');
  assert.equal(saved.data.gold_solve.evidence_status, 'proven');
  assert.equal(saved.data.gold_solve.sources.length, 2);
  assert.deepEqual(saved.data.gold_solve.evidence_probe_ids, ['probe_sql', 'probe_doc']);
  assert.equal(saved.data.gold_solve.reference_sql, 'select customer_id, amount from sales');
});

test('proposal target follows multimodal repair boundary', () => {
  const parsing = normalizeTuningProposalPayload({
    change_type: 'prompt_rule',
    proposal: '给该题增加规则',
  }, { failure_stage: 'source_parsing', summary: '扫描 PDF 没有 OCR 结果' });
  assert.equal(parsing.change_type, 'none');
  assert.match(parsing.warnings.join('\n'), /不能通过 Prompt/);

  const documentRecall = normalizeTuningProposalPayload({
    change_type: 'manual_check',
    document_id: 'doc-1',
    new_description: '采购合同，包含付款、验收和违约条款。',
  }, { failure_stage: 'document_recall' });
  assert.equal(documentRecall.change_type, 'document_desc');
  assert.equal(documentRecall.automatic, true);

  const sqlCompleteness = normalizeTuningProposalPayload({
    change_type: 'prompt_rule',
    agent_type: 'query_agent',
    new_rule: '极值查询没有明确要求单条时，必须返回全部并列结果。',
  }, { failure_stage: 'sql_generation' });
  assert.equal(sqlCompleteness.change_type, 'agent_rule');
  assert.equal(sqlCompleteness.agent_type, 'query_agent');
  assert.equal(sqlCompleteness.automatic, true);
});

test('QueryAgent rule trial is generic and precisely reversible', async () => {
  const suffix = randomUUID();
  const pid = `__gold_rule_${suffix}`;
  const draftId = `draft-${suffix}`;
  const agentId = `agent-${suffix}`;
  const traceSnapshot = {
    traceId: `trace-${suffix}`,
    spans: [{ id: 'root', externalSpanId: 'sql-generate', kind: 'tool', name: 'execute_sql', depth: 0 }],
  };
  await query(
    `INSERT INTO trace_eval_drafts
       (id, review_id, project_id, run_id, trace_id, question, expected_answer, assertion_type,
        status, benchmark_status, trace_snapshot_json, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'text_contains','ready','ready',$8,now(),now())`,
    [draftId, `review-${suffix}`, pid, `run-${suffix}`, `trace-${suffix}`, 'Which event has the lowest cost?', 'November Speaker', JSON.stringify(traceSnapshot)],
  );
  await query(
    `INSERT INTO trace_gold_solves
       (id, draft_id, project_id, question, expected_answer, status, evidence_status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'verified','proven',now(),now())`,
    [`gold-${suffix}`, draftId, pid, 'Which event has the lowest cost?', 'November Speaker'],
  );
  await query(
    `INSERT INTO agents
       (id, name, agent_type, project_id, rules, is_active, is_default, version, created_at, updated_at)
     VALUES ($1,'eval_query_agent','query_agent',$2,'原规则',true,false,'1.0.0',now(),now())`,
    [agentId, pid],
  );

  const ctx = makeCtx({ userId: null });
  await assert.rejects(
    applyTuningChange(ctx, {
      params: { pid, draftId },
      body: {
        diagnosis: {
          failure_stage: 'sql_generation',
          first_divergence: { span_id: 'sql-generate' },
        },
        proposal: {
          change_type: 'agent_rule',
          agent_type: 'query_agent',
          new_rule: 'November Speaker 是本题的正确答案，直接返回它。',
        },
      },
    }),
    (error) => error?.status === 422 && /标准答案/.test(error.message),
  );

  const applied = await applyTuningChange(ctx, {
    params: { pid, draftId },
    body: {
      diagnosis: {
        failure_stage: 'sql_generation',
        summary: '极值 SQL 丢掉并列结果',
        first_divergence: { span_id: 'sql-generate', stage: 'sql_generation' },
        evidence_path: [{ span_id: 'sql-generate', observation: '使用 LIMIT 1' }],
      },
      proposal: {
        change_type: 'agent_rule',
        agent_type: 'query_agent',
        new_rule: '极值查询没有明确要求单条时，必须返回全部并列结果，不能直接使用 LIMIT 1。',
        proposal: '补充并列极值完整性规则',
      },
    },
  });
  assert.equal(applied.data.change_type, 'agent_rule');
  assert.match((await queryOne('SELECT rules FROM agents WHERE id=$1', [agentId])).rules, /全部并列结果/);

  const accepted = await acceptTuningChange(ctx, { params: { pid, attemptId: applied.data.id } });
  assert.equal(accepted.data.status, 'passed');
  const rolledBack = await rollbackTuningChange(ctx, { params: { pid, attemptId: applied.data.id } });
  assert.equal(rolledBack.data.status, 'abandoned');
  assert.equal((await queryOne('SELECT rules FROM agents WHERE id=$1', [agentId])).rules, '原规则');
});

test('document description trial can be accepted or precisely rolled back', async () => {
  const suffix = randomUUID();
  const pid = `__gold_change_${suffix}`;
  const draftId = `draft-${suffix}`;
  const goldId = `gold-${suffix}`;
  const documentId = `doc-${suffix}`;
  const traceSnapshot = {
    traceId: `trace-${suffix}`,
    spans: [{ id: 'root', externalSpanId: 'doc-search', kind: 'tool', name: 'search_documents', depth: 0 }],
  };
  await query(
    `INSERT INTO trace_eval_drafts
       (id, review_id, project_id, run_id, trace_id, question, expected_answer, assertion_type,
        status, benchmark_status, trace_snapshot_json, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'text_contains','ready','ready',$8,now(),now())`,
    [draftId, `review-${suffix}`, pid, `run-${suffix}`, `trace-${suffix}`, '原始测试问题，不得写进描述', '标准答案', JSON.stringify(traceSnapshot)],
  );
  await query(
    `INSERT INTO trace_gold_solves
       (id, draft_id, project_id, question, expected_answer, status, evidence_status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'verified','proven',now(),now())`,
    [goldId, draftId, pid, '原始测试问题，不得写进描述', '标准答案'],
  );
  await query(
    `INSERT INTO unstructured_documents
       (id, project_id, title, description, status, created_at, updated_at)
     VALUES ($1,$2,'采购合同','旧描述','completed',now(),now())`,
    [documentId, pid],
  );

  const ctx = makeCtx({ userId: null });
  await assert.rejects(
    applyTuningChange(ctx, {
      params: { pid, draftId },
      body: {
        diagnosis: { failure_stage: 'source_parsing', summary: '缺少 OCR' },
        proposal: { change_type: 'prompt_rule', proposal: '给该题加规则' },
      },
    }),
    (error) => error?.status === 422 && /不能转换成 Prompt/.test(error.message),
  );
  const applied = await applyTuningChange(ctx, {
    params: { pid, draftId },
    body: {
      diagnosis: {
        failure_stage: 'document_recall',
        summary: '目标文档没有召回',
        first_divergence: { span_id: 'doc-search', stage: 'document_recall' },
        evidence_path: [{ span_id: 'doc-search', observation: '未返回目标文档' }],
      },
      proposal: {
        change_type: 'document_desc',
        document_id: documentId,
        new_description: '采购合同，包含付款、验收、交付与违约条款。',
        proposal: '补充文档业务范围',
      },
    },
  });
  assert.equal(applied.data.change_type, 'document_desc');
  assert.equal(applied.data.status, 'running');
  assert.equal((await queryOne('SELECT description FROM unstructured_documents WHERE id=$1', [documentId])).description, '采购合同，包含付款、验收、交付与违约条款。');

  const accepted = await acceptTuningChange(ctx, { params: { pid, attemptId: applied.data.id } });
  assert.equal(accepted.data.status, 'passed');
  const rolledBack = await rollbackTuningChange(ctx, { params: { pid, attemptId: applied.data.id } });
  assert.equal(rolledBack.data.status, 'abandoned');
  assert.equal((await queryOne('SELECT description FROM unstructured_documents WHERE id=$1', [documentId])).description, '旧描述');
});
