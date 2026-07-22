import { randomUUID } from "node:crypto";
import { runWorkflowSkill, workflowSkillMeta } from "../../../engine/skills/workflow_skill_runner.js";
import { ApiError } from "../../../errors.js";
import { buildTraceEvidencePack } from "./trace_evidence.js";
import { traceGetSpan } from "./trace_evidence.js";
import { runTraceDebugger } from "./trace_debugger.js";
import {
  createGoldSourceContext,
  executeGoldSourceAction,
  normalizeGoldEvidencePayload,
  runGoldEvidenceLoop,
  validateGoldEvidenceProof,
} from "./gold_evidence.js";
import {
  GOLD_STATUSES,
  GOLD_SOLVE_DRAFTER_SKILL,
  TRACE_FAILURE_DIAGNOSER_SKILL,
  TRACE_TUNING_PROPOSER_SKILL,
  text,
  nullableText,
  json,
  parseJson,
  object,
  array,
  bool,
  requireProjectAccess,
  goldSolveShape,
  draftShape,
  attemptShape,
  goldSolveForDraft,
  insertAttempt,
  refreshDraftReadiness
} from "./common.js";

function uniqueText(values) {
  return [...new Set(array(values).map((value) => text(value).trim()).filter(Boolean))];
}

function assertProvenEvidence(evidenceStatus, evidenceProbeIds, sourceProbes, expectedAnswer = "", evidencePath = {}) {
  if (evidenceStatus !== "proven") return;
  const validProbeIds = new Set(
    array(sourceProbes)
      .filter((probe) => probe?.ok === true && probe?.evidence === true)
      .map((probe) => text(probe.probe_id || probe.probeId))
      .filter(Boolean),
  );
  const requested = uniqueText(evidenceProbeIds);
  const invalid = requested.filter((probeId) => !validProbeIds.has(probeId));
  if (!requested.length || invalid.length) {
    throw new ApiError(
      invalid.length
        ? `参考解引用了未成功执行的来源探查: ${invalid.join(", ")}`
        : "已证明的参考解必须包含成功执行的来源探查",
      422,
    );
  }
  const proof = validateGoldEvidenceProof({
    expectedAnswer,
    evidenceProbeIds,
    sourceProbes,
    evidenceSteps: evidencePath.steps,
    crossSourceLinks: evidencePath.crossSourceLinks,
  });
  if (!proof.proven) throw new ApiError(`参考解未被来源结果证明: ${proof.reason}`, 422);
}

function goldSolveDraftInput(draft, overrides = {}) {
  return {
    question: text(overrides.question ?? draft.question),
    expected_behavior: text(overrides.expected_behavior ?? overrides.expectedBehavior ?? draft.expected_behavior),
    expected_answer: text(overrides.expected_answer ?? overrides.expectedAnswer ?? draft.expected_answer),
    assertion_type: text(overrides.assertion_type ?? overrides.assertionType ?? draft.assertion_type),
    tags: parseJson(draft.tags, []),
    replay_requirements: parseJson(draft.replay_requirements_json, {}),
  };
}

function normalizeGoldSolveDraftPayload(payload, probes, draft, overrides = {}) {
  return normalizeGoldEvidencePayload(payload, probes, {
    question: text(overrides.question ?? draft.question),
    expected_behavior: text(overrides.expected_behavior ?? overrides.expectedBehavior ?? draft.expected_behavior),
    expected_answer: text(overrides.expected_answer ?? overrides.expectedAnswer ?? draft.expected_answer),
  });
}

function diagnosisInput(draft, gold, overrides = {}) {
  const traceSnapshot = parseJson(draft.trace_snapshot_json, {});
  const bodyGold = object(overrides.gold_solve || overrides.goldSolve);
  const baseGold = goldSolveShape(gold) || {};
  const mergedGold = {
    ...baseGold,
    ...bodyGold,
    data_sources: array(bodyGold.data_sources || bodyGold.dataSources || baseGold.data_sources).map(String),
    filters: object(bodyGold.filters || baseGold.filters),
    reference_steps: array(bodyGold.reference_steps || bodyGold.referenceSteps || baseGold.reference_steps).map(String),
    intermediate_expectations: array(bodyGold.intermediate_expectations || bodyGold.intermediateExpectations || baseGold.intermediate_expectations),
    sources: array(bodyGold.sources || baseGold.sources),
    steps: array(bodyGold.steps || baseGold.steps),
    cross_source_links: array(bodyGold.cross_source_links || bodyGold.crossSourceLinks || baseGold.cross_source_links),
    output_shape: object(bodyGold.output_shape || bodyGold.outputShape || baseGold.output_shape),
    evidence_probe_ids: array(bodyGold.evidence_probe_ids || bodyGold.evidenceProbeIds || baseGold.evidence_probe_ids).map(String),
    evidence_status: text(bodyGold.evidence_status || bodyGold.evidenceStatus || baseGold.evidence_status || "legacy"),
  };
  return {
    question: text(overrides.question ?? draft.question),
    expected_behavior: text(overrides.expected_behavior ?? overrides.expectedBehavior ?? draft.expected_behavior),
    expected_answer: text(overrides.expected_answer ?? overrides.expectedAnswer ?? draft.expected_answer),
    actual_output: text(draft.actual_output),
    assertion_type: text(overrides.assertion_type ?? overrides.assertionType ?? draft.assertion_type),
    failure_category: draft.failure_category || "",
    tuning_notes: draft.tuning_notes || "",
    gold_solve: mergedGold,
    replay_requirements: parseJson(draft.replay_requirements_json, {}),
    trace_evidence_pack: buildTraceEvidencePack({
      traceSnapshot,
      question: overrides.question ?? draft.question,
      expectedBehavior: overrides.expected_behavior ?? overrides.expectedBehavior ?? draft.expected_behavior,
      expectedAnswer: overrides.expected_answer ?? overrides.expectedAnswer ?? draft.expected_answer,
      actualOutput: draft.actual_output,
      assertionType: overrides.assertion_type ?? overrides.assertionType ?? draft.assertion_type,
      goldSolve: mergedGold,
      mode: "diagnosis",
    }),
  };
}

function observedTraceSpanIds(payload, traceEvidencePack = {}) {
  const ids = new Set(
    array(traceEvidencePack.evidence_spans || traceEvidencePack.evidenceSpans)
      .map((span) => text(object(span).span_id || object(span).spanId))
      .filter(Boolean),
  );
  const debuggerState = object(object(payload).trace_debugger || object(payload).traceDebugger);
  const addResult = (value) => {
    if (Array.isArray(value)) {
      value.forEach(addResult);
      return;
    }
    const row = object(value);
    const spanId = text(row.span_id || row.spanId);
    if (spanId) ids.add(spanId);
  };
  for (const observation of array(debuggerState.observations)) addResult(object(observation).result);
  return ids;
}

export function normalizeDiagnosisPayload(payload, traceSnapshot = {}, traceEvidencePack = {}) {
  const src = object(payload);
  const traceDebugger = object(src.trace_debugger || src.traceDebugger);
  const stages = new Set([
    "source_recall",
    "document_recall",
    "schema_semantics",
    "source_parsing",
    "cross_source_alignment",
    "filtering",
    "calculation",
    "unit_conversion",
    "sorting",
    "intent",
    "routing",
    "tool_selection",
    "tool_input",
    "sql_generation",
    "sql_execution",
    "tool_output_usage",
    "final_answer",
    "data_issue",
    "assertion_issue",
    "trace_incomplete",
    "unknown",
  ]);
  const requestedStage = text(src.failure_stage || src.failureStage);
  let stage = stages.has(requestedStage) ? requestedStage : "unknown";
  const confidence = Number(src.confidence);
  const requestedEvidencePath = array(src.evidence_path || src.evidencePath).map((item) => {
    const row = object(item);
    return {
      span_id: text(row.span_id || row.spanId),
      observation: text(row.observation || item),
    };
  }).filter((item) => item.span_id || item.observation);
  const observedSpanIds = observedTraceSpanIds(src, traceEvidencePack);
  const evidencePath = requestedEvidencePath.filter((item) => item.span_id && observedSpanIds.has(item.span_id) && traceGetSpan(traceSnapshot, item.span_id));
  const invalidSpanIds = requestedEvidencePath
    .map((item) => item.span_id)
    .filter((spanId) => spanId && (!observedSpanIds.has(spanId) || !traceGetSpan(traceSnapshot, spanId)));
  if (requestedEvidencePath.length && !evidencePath.length) stage = "trace_incomplete";
  const divergenceRaw = object(src.first_divergence || src.firstDivergence);
  const divergenceSpanId = text(divergenceRaw.span_id || divergenceRaw.spanId || evidencePath[0]?.span_id);
  const firstDivergence = divergenceSpanId && observedSpanIds.has(divergenceSpanId) && traceGetSpan(traceSnapshot, divergenceSpanId) ? {
    stage: text(divergenceRaw.stage || stage),
    gold_step_id: text(divergenceRaw.gold_step_id || divergenceRaw.goldStepId),
    span_id: divergenceSpanId,
    summary: text(divergenceRaw.summary || src.summary),
  } : null;
  return {
    failure_stage: stage,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    summary: text(src.summary),
    evidence: array(src.evidence).map((item) => {
      const row = object(item);
      return {
        source: text(row.source || "unknown"),
        observation: text(row.observation || item),
      };
    }),
    trace_gaps: array(src.trace_gaps || src.traceGaps).map(String),
    trace_debugger: Object.keys(traceDebugger).length ? traceDebugger : null,
    evidence_path: evidencePath,
    first_divergence: firstDivergence,
    recommended_actions: array(src.recommended_actions || src.recommendedActions).map(String),
    next_benchmark_focus: array(src.next_benchmark_focus || src.nextBenchmarkFocus).map(String),
    warnings: [
      ...array(src.warnings).map(String),
      ...(invalidSpanIds.length ? [`诊断引用了不存在的 Trace Span: ${uniqueText(invalidSpanIds).join(", ")}`] : []),
      ...(!firstDivergence ? ["未能把第一次分歧绑定到真实 Trace Span。"] : []),
    ],
  };
}

export function normalizeTuningProposalPayload(payload, diagnosis = {}) {
  const src = object(payload);
  const allowedTypes = new Set([
    "document_desc",
    "none",
    "agent_rule",
    "prompt_rule",
    "tool_schema",
    "tool_logic",
    "operator_logic",
    "metadata",
    "benchmark_assertion",
    "trace_instrumentation",
    "manual_check",
  ]);
  const failureStage = text(diagnosis.failure_stage || diagnosis.failureStage);
  let changeType = allowedTypes.has(src.change_type) ? src.change_type : "manual_check";
  if (changeType === "prompt_rule") changeType = "agent_rule";
  if (failureStage === "source_parsing") changeType = "none";
  if (failureStage === "document_recall" && text(src.document_id || src.documentId) && text(src.new_description || src.newDescription)) {
    changeType = "document_desc";
  }
  const evidencePath = array(src.evidence_path || src.evidencePath || diagnosis.evidence_path || diagnosis.evidencePath).map((item) => {
    const row = object(item);
    return {
      span_id: text(row.span_id || row.spanId),
      observation: text(row.observation || item),
    };
  }).filter((item) => item.span_id || item.observation);
  return {
    hypothesis: text(src.hypothesis || diagnosis.summary),
    change_type: changeType,
    target: text(src.target || diagnosis.failure_stage || "unknown"),
    proposal: text(src.proposal),
    why: text(src.why || src.reason),
    risk: text(src.risk),
    validation_plan: text(src.validation_plan || src.validationPlan),
    benchmark_focus: array(src.benchmark_focus || src.benchmarkFocus || diagnosis.next_benchmark_focus || diagnosis.nextBenchmarkFocus).map(String),
    manual_steps: array(src.manual_steps || src.manualSteps).map(String),
    evidence_path: evidencePath,
    document_id: changeType === "document_desc" ? text(src.document_id || src.documentId) : "",
    new_description: changeType === "document_desc" ? text(src.new_description || src.newDescription) : "",
    agent_type: changeType === "agent_rule" ? text(src.agent_type || src.agentType || "query_agent") : "",
    new_rule: changeType === "agent_rule" ? text(src.new_rule || src.newRule || src.rule) : "",
    requires_user_action: changeType === "none" ? text(src.requires_user_action || src.requiresUserAction || src.proposal || diagnosis.summary) : "",
    automatic: changeType === "document_desc" || changeType === "agent_rule",
    warnings: [
      ...array(src.warnings).map(String),
      ...(changeType === "none" && failureStage === "source_parsing"
        ? ["解析、OCR 或转写能力缺失不能通过 Prompt 或题目规则自动修复。"]
        : []),
    ],
  };
}

function tuningProposalInput(draft, gold, body = {}) {
  const diagnosis = object(body.diagnosis);
  const base = diagnosisInput(draft, gold, body);
  return {
    draft: {
      id: draft.id,
      question: text(body.question ?? draft.question),
      expected_behavior: text(body.expected_behavior ?? body.expectedBehavior ?? draft.expected_behavior),
      expected_answer: text(body.expected_answer ?? body.expectedAnswer ?? draft.expected_answer),
      actual_output: text(draft.actual_output),
      assertion_type: text(body.assertion_type ?? body.assertionType ?? draft.assertion_type),
      failure_category: draft.failure_category || "",
      tuning_notes: draft.tuning_notes || "",
    },
    gold_solve: base.gold_solve,
    diagnosis,
    trace_evidence_pack: base.trace_evidence_pack,
    recent_attempts: array(body.recent_attempts || body.recentAttempts).slice(0, 5).map((attempt) => {
      const row = object(attempt);
      const benchmark = object(row.benchmark_result || row.benchmarkResult);
      const run = object(benchmark.run || benchmark);
      const result = object(run.result);
      const metadata = object(result.metadata);
      return {
        id: text(row.id),
        attempt_index: Number(row.attempt_index || row.attemptIndex || 0),
        status: text(row.status),
        hypothesis: text(row.hypothesis),
        change_summary: text(row.change_summary || row.changeSummary),
        change_type: text(row.change_type || row.changeType),
        change: object(row.change),
        verification: {
          status: text(run.status),
          checks: array(result.checks).map((check) => ({ ok: check?.ok === true, msg: text(check?.msg) })),
          final_columns: array(metadata.columns),
          output_text: text(metadata.output_text).slice(-2400),
        },
      };
    }),
  };
}

export function assertGoldReadyForTrace(gold) {
  if (!gold || gold.status !== "verified") {
    throw new ApiError("请先完成并确认独立参考解，再读取失败 Trace", 409);
  }
  return gold;
}

export async function runTuningProposalWorkflow(ctx, {
  projectId,
  draft,
  gold,
  body = {},
  recentAttempts = [],
  runStep = runWorkflowSkill,
} = {}) {
  const diagnosis = object(body.diagnosis);
  const result = await runStep(ctx, {
    projectId,
    skillName: TRACE_TUNING_PROPOSER_SKILL,
    task: "基于当前 Trace 诊断、Gold Solve 和证据路径，生成下一轮可人工确认的调优方案。不要自动修改系统。",
    input: tuningProposalInput(draft, gold, { ...body, recent_attempts: recentAttempts }),
    responseContract: "必须只输出包含 hypothesis、change_type、target、proposal、why、risk、validation_plan、benchmark_focus、manual_steps、evidence_path、document_id、new_description、agent_type、new_rule、requires_user_action、warnings 的 JSON object。source_parsing 的 change_type 必须是 none。",
    temperature: 0.12,
    maxTokens: 5000,
    modelId: nullableText(body.model_id || body.modelId),
    callSite: "trace_tuning_propose",
    inputMaxChars: 32000,
  });
  return {
    skill: result.skill,
    data: normalizeTuningProposalPayload(result.data, diagnosis),
  };
}

export async function generateGoldSolve(ctx, input) {
  const { pid, draftId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const draft = await ctx.queryOne(
    `SELECT * FROM trace_eval_drafts WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [draftId, pid],
  );
  if (!draft) throw new ApiError("评测草稿不存在", 404);
  const body = input.body || {};
  const question = nullableText(body.question ?? draft.question);
  const expectedBehavior = nullableText(body.expected_behavior ?? body.expectedBehavior ?? draft.expected_behavior);
  const expectedAnswer = nullableText(body.expected_answer ?? body.expectedAnswer ?? draft.expected_answer);
  if (!question) throw new ApiError("缺少用户问题，无法生成参考解", 400);
  if (!expectedBehavior && !expectedAnswer) throw new ApiError("缺少 expected，无法生成可靠参考解", 400);

  let skill;
  let parsed;
  let probes = [];
  try {
    const sourceContext = await createGoldSourceContext(ctx, pid);
    const result = await runGoldEvidenceLoop({
      baseInput: goldSolveDraftInput(draft, body),
      inventory: sourceContext.inventory,
      runStep: (loopInput) => runWorkflowSkill(ctx, {
        projectId: pid,
        skillName: GOLD_SOLVE_DRAFTER_SKILL,
        task: "从项目原始来源独立完成参考解。当前阶段禁止读取错误回答和 Trace。证据不足时请求来源探查。",
        input: loopInput,
        responseContract: [
          "证据不足时只输出 {\"next_source_actions\":[{\"type\":\"read_schema|execute_sql|search_documents|read_document\",\"source_id\":\"\",\"document_id\":\"\",\"sql\":\"\",\"query\":\"\",\"reason\":\"\"}]}。",
          "完成后只输出包含 intent_summary、sources、steps、cross_source_links、output_shape、evidence_probe_ids、data_sources、filters、metric_definition、reference_steps、reference_sql、intermediate_expectations、final_answer_contract、warnings、assumptions 的 JSON object。",
        ].join("\n"),
        temperature: 0.15,
        maxTokens: 7000,
        modelId: nullableText(body.model_id || body.modelId),
        callSite: "trace_gold_solve_draft",
        inputMaxChars: 38000,
      }),
      executeAction: (action, probeId) => executeGoldSourceAction(sourceContext, action, probeId),
      maxRounds: 6,
    });
    skill = result.skill;
    parsed = result.data;
    probes = result.probes;
  } catch (e) {
    throw new ApiError(`生成参考解失败: ${e?.message || e}`, 500);
  }

  let generated;
  try {
    generated = normalizeGoldSolveDraftPayload(parsed, probes, draft, body);
  } catch (e) {
    throw new ApiError(`参考解证据无效: ${e?.message || e}`, 422);
  }
  const saved = await saveGoldSolve(ctx, {
    params: { pid, draftId },
    body: generated,
  });
  return {
    ...saved,
    data: {
      ...(saved.data || {}),
      skill: workflowSkillMeta(skill),
    },
    message: "参考解草稿已生成",
  };
}

export async function diagnoseDraft(ctx, input) {
  const { pid, draftId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const draft = await ctx.queryOne(
    `SELECT * FROM trace_eval_drafts WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [draftId, pid],
  );
  if (!draft) throw new ApiError("评测草稿不存在", 404);
  const gold = assertGoldReadyForTrace(await goldSolveForDraft(ctx, draftId));
  const body = input.body || {};
  const payload = diagnosisInput(draft, gold, body);
  const traceSnapshot = parseJson(draft.trace_snapshot_json, {});
  if (!nullableText(payload.question)) throw new ApiError("缺少用户问题，无法诊断", 400);
  if (!nullableText(payload.expected_behavior) && !nullableText(payload.expected_answer)) {
    throw new ApiError("缺少 expected，无法诊断", 400);
  }

  let skill;
  let parsed;
  try {
    const result = await runTraceDebugger(ctx, {
      projectId: pid,
      skillName: TRACE_FAILURE_DIAGNOSER_SKILL,
      task: "对比 Gold Solve、actual output 和 Trace 证据包，诊断失败发生在哪个 agent 流程阶段，并给出下一步调优建议。",
      baseInput: payload,
      traceSnapshot,
      responseContract: "必须只输出包含 failure_stage、confidence、summary、first_divergence、evidence、evidence_path、trace_gaps、recommended_actions、next_benchmark_focus、warnings 的 JSON object。",
      temperature: 0.1,
      maxTokens: 6000,
      modelId: nullableText(body.model_id || body.modelId),
      callSite: "trace_failure_diagnose",
      inputMaxChars: 36000,
      maxRounds: 5,
    });
    skill = result.skill;
    parsed = result.data;
  } catch (e) {
    throw new ApiError(`Trace 诊断失败: ${e?.message || e}`, 500);
  }

  const diagnosis = normalizeDiagnosisPayload(parsed, traceSnapshot, payload.trace_evidence_pack);
  let attempt = null;
  if (bool(body.persist_attempt || body.persistAttempt, false)) {
    const attemptRow = await insertAttempt(ctx, pid, draft, {
      ...(body.attempt || {}),
      source: "diagnosis",
      status: body.attempt?.status || "planned",
      hypothesis: body.attempt?.hypothesis || diagnosis.summary,
      diagnosis,
    });
    attempt = attemptShape(attemptRow);
  }

  return {
    data: {
      ...diagnosis,
      skill: workflowSkillMeta(skill),
      ...(attempt ? { attempt } : {}),
    },
    message: attempt ? "Trace 诊断已生成并记录为调试轮次" : "Trace 诊断已生成",
  };
}

export async function generateTuningProposal(ctx, input) {
  const { pid, draftId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const draft = await ctx.queryOne(
    `SELECT * FROM trace_eval_drafts WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [draftId, pid],
  );
  if (!draft) throw new ApiError("评测草稿不存在", 404);
  const gold = assertGoldReadyForTrace(await goldSolveForDraft(ctx, draftId));
  const body = input.body || {};
  const diagnosis = object(body.diagnosis);
  if (!nullableText(diagnosis.summary) && !nullableText(diagnosis.failure_stage || diagnosis.failureStage)) {
    throw new ApiError("缺少 Trace 诊断结果，无法生成调优方案", 400);
  }
  let recentAttempts = array(body.recent_attempts || body.recentAttempts);
  if (!recentAttempts.length) {
    const rows = await ctx.query(
      `SELECT *
         FROM trace_optimization_attempts
        WHERE draft_id=$1 AND project_id=$2 AND deleted_at IS NULL
        ORDER BY attempt_index DESC, updated_at DESC, created_at DESC
        LIMIT 5`,
      [draftId, pid],
    );
    recentAttempts = rows.map(attemptShape);
  }

  let skill;
  let parsed;
  try {
    const result = await runTuningProposalWorkflow(ctx, {
      projectId: pid,
      draft,
      gold,
      body,
      recentAttempts,
    });
    skill = result.skill;
    parsed = result.data;
  } catch (e) {
    throw new ApiError(`生成调优方案失败: ${e?.message || e}`, 500);
  }

  return {
    data: {
      ...parsed,
      skill: workflowSkillMeta(skill),
    },
    message: "调优方案已生成",
  };
}

export async function saveGoldSolve(ctx, input) {
  const { pid, draftId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const draft = await ctx.queryOne(
    `SELECT * FROM trace_eval_drafts WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [draftId, pid],
  );
  if (!draft) throw new ApiError("评测草稿不存在", 404);
  const body = input.body || {};
  const status = GOLD_STATUSES.has(body.status) && body.status !== "missing" ? body.status : "drafted";
  const existing = await goldSolveForDraft(ctx, draftId);
  const requestedEvidenceStatus = text(body.evidence_status || body.evidenceStatus || existing?.evidence_status || "legacy");
  const evidenceProbeIds = body.evidence_probe_ids || body.evidenceProbeIds || parseJson(existing?.evidence_probe_ids_json, []);
  const sourceProbes = body.source_probes || body.sourceProbes || parseJson(existing?.source_probes_json, []);
  assertProvenEvidence(
    requestedEvidenceStatus,
    evidenceProbeIds,
    sourceProbes,
    text(body.expected_answer ?? body.expectedAnswer ?? draft.expected_answer),
    {
      steps: body.steps || parseJson(existing?.evidence_steps_json, []),
      crossSourceLinks: body.cross_source_links || body.crossSourceLinks || parseJson(existing?.cross_source_links_json, []),
    },
  );
  const evidenceStatus = status === "verified" && requestedEvidenceStatus === "unproven"
    ? "human_verified"
    : requestedEvidenceStatus;
  let row;
  if (existing) {
    row = await ctx.queryOne(
      `UPDATE trace_gold_solves
          SET question=$1, expected_behavior=$2, expected_answer=$3, intent_summary=$4,
              data_sources=$5, filters_json=$6, metric_definition=$7, reference_steps_json=$8,
              reference_sql=$9, intermediate_expectations_json=$10, final_answer_contract=$11,
              trace_diff_summary=$12, sources_json=$13, evidence_steps_json=$14,
              cross_source_links_json=$15, output_shape_json=$16, evidence_probe_ids_json=$17,
              source_probes_json=$18, evidence_status=$19, status=$20,
              verified_by=CASE WHEN $20='verified' THEN $21 ELSE verified_by END,
              updated_at=now(), version=version+1
        WHERE id=$22
        RETURNING *`,
      [
        text(body.question ?? draft.question),
        text(body.expected_behavior ?? draft.expected_behavior),
        text(body.expected_answer ?? draft.expected_answer),
        text(body.intent_summary),
        json(body.data_sources || []),
        json(body.filters || {}),
        text(body.metric_definition),
        json(body.reference_steps || []),
        text(body.reference_sql),
        json(body.intermediate_expectations || []),
        text(body.final_answer_contract),
        text(body.trace_diff_summary),
        json(body.sources || parseJson(existing.sources_json, [])),
        json(body.steps || parseJson(existing.evidence_steps_json, [])),
        json(body.cross_source_links || body.crossSourceLinks || parseJson(existing.cross_source_links_json, [])),
        json(body.output_shape || body.outputShape || parseJson(existing.output_shape_json, {})),
        json(evidenceProbeIds),
        json(sourceProbes),
        evidenceStatus,
        status,
        ctx.userId,
        existing.id,
      ],
    );
  } else {
    row = await ctx.queryOne(
      `INSERT INTO trace_gold_solves
         (id, draft_id, project_id, question, expected_behavior, expected_answer,
          intent_summary, data_sources, filters_json, metric_definition, reference_steps_json,
          reference_sql, intermediate_expectations_json, final_answer_contract, trace_diff_summary,
          sources_json, evidence_steps_json, cross_source_links_json, output_shape_json,
          evidence_probe_ids_json, source_probes_json, evidence_status,
          status, created_by, verified_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,CASE WHEN $23='verified' THEN $24 ELSE NULL END,now(),now())
       RETURNING *`,
      [
        randomUUID(),
        draftId,
        pid,
        text(body.question ?? draft.question),
        text(body.expected_behavior ?? draft.expected_behavior),
        text(body.expected_answer ?? draft.expected_answer),
        text(body.intent_summary),
        json(body.data_sources || []),
        json(body.filters || {}),
        text(body.metric_definition),
        json(body.reference_steps || []),
        text(body.reference_sql),
        json(body.intermediate_expectations || []),
        text(body.final_answer_contract),
        text(body.trace_diff_summary),
        json(body.sources || []),
        json(body.steps || []),
        json(body.cross_source_links || body.crossSourceLinks || []),
        json(body.output_shape || body.outputShape || {}),
        json(evidenceProbeIds),
        json(sourceProbes),
        evidenceStatus,
        status,
        ctx.userId,
      ],
    );
  }
  const refreshedDraft = await refreshDraftReadiness(ctx, draftId);
  return { data: { gold_solve: goldSolveShape(row), draft: draftShape(refreshedDraft, row) }, message: "参考解已保存" };
}

export async function updateGoldSolve(ctx, input) {
  const { pid, goldSolveId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const existing = await ctx.queryOne(
    `SELECT * FROM trace_gold_solves WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [goldSolveId, pid],
  );
  if (!existing) throw new ApiError("参考解不存在", 404);
  return saveGoldSolve(ctx, {
    params: { pid, draftId: existing.draft_id },
    body: input.body || {},
  });
}
