import { randomUUID } from "node:crypto";
import { ApiError } from "../../../errors.js";
import { traceGetSpan } from "./trace_evidence.js";
import {
  attemptShape,
  goldSolveForDraft,
  insertAttempt,
  object,
  array,
  parseJson,
  requireProjectAccess,
  text,
} from "./common.js";

function compact(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function fullTextIncluded(candidate, forbidden, minLength = 4) {
  const source = compact(forbidden);
  if (source.length < minLength) return false;
  return compact(candidate).includes(source);
}

function expectedFragments(value) {
  return String(value || "")
    .split(/\r?\n|\||,|\t/)
    .map(compact)
    .filter((item) => item.length >= 8);
}

function assertGenericDescription(description, draft, contentLabel = "文档描述") {
  const forbidden = [
    [draft.question, 8, "用户问题"],
    [draft.expected_answer, 4, "标准答案"],
    [draft.id, 8, "样本编号"],
    [draft.run_id, 8, "Run 编号"],
  ];
  for (const fragment of expectedFragments(draft.expected_answer)) {
    forbidden.push([fragment, 8, "标准答案片段"]);
  }
  for (const [value, minLength, forbiddenLabel] of forbidden) {
    if (fullTextIncluded(description, value, minLength)) {
      throw new ApiError(`${contentLabel}不能包含完整${forbiddenLabel}，请改成可复用内容`, 422);
    }
  }
}

function promptRuleText(proposal) {
  return compact(
    proposal.new_rule || proposal.newRule || proposal.rule || proposal.rule_text || proposal.ruleText,
  );
}

function appendAutoRule(previousRules, rule) {
  const previous = String(previousRules || "");
  const separator = previous ? (previous.endsWith("\n") ? "\n" : "\n\n") : "";
  return `${previous}${separator}## 自动优化规则\n${rule}\n`;
}

async function applyPromptRule(ctx, pid, draft, proposal, diagnosis, spanId) {
  const agentType = text(proposal.agent_type || proposal.agentType || "query_agent") || "query_agent";
  if (agentType !== "query_agent") {
    throw new ApiError("当前只允许自动试写 QueryAgent 的项目规则", 400);
  }
  const rule = promptRuleText(proposal);
  if (!rule || rule.length < 12) throw new ApiError("agent_rule 缺少可执行的 new_rule", 400);
  if (rule.length > 2000) throw new ApiError("agent_rule 过长，请缩小为一条可复用规则", 422);
  assertGenericDescription(rule, draft, "自动优化规则");

  const existing = await ctx.queryOne(
    `SELECT id, name, rules, model_id, system_prompt, user_prompt_template
       FROM agents
      WHERE project_id=$1 AND agent_type IN ('query_agent', 'pi_query_agent')
        AND deleted_at IS NULL
      ORDER BY CASE WHEN agent_type='query_agent' THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1`,
    [pid],
  );
  const previousRules = text(existing?.rules);
  if (previousRules.includes(rule)) throw new ApiError("项目规则已经包含本次修改", 400);
  const nextRules = appendAutoRule(previousRules, rule);
  const agentId = existing?.id || randomUUID();
  let created = false;
  let updated = null;
  if (existing) {
    updated = await ctx.queryOne(
      `UPDATE agents
          SET agent_type='query_agent', rules=$1, updated_at=now()
        WHERE id=$2 AND project_id=$3 AND deleted_at IS NULL
          AND COALESCE(rules, '')=$4
        RETURNING id, rules`,
      [nextRules, agentId, pid, previousRules],
    );
  } else {
    created = true;
    updated = await ctx.queryOne(
      `INSERT INTO agents
         (id, name, agent_type, project_id, created_by, rules,
          is_active, is_default, version, created_at, updated_at)
       VALUES ($1,'auto_optimized_query_agent','query_agent',$2,$3,$4,true,false,'1.0.0',now(),now())
       RETURNING id, rules`,
      [agentId, pid, ctx.userId, nextRules],
    );
  }
  if (!updated) throw new ApiError("QueryAgent 项目规则已被其他操作修改，请刷新后重试", 409);

  const now = new Date().toISOString();
  try {
    const row = await insertAttempt(ctx, pid, draft, {
      source: "diagnosis",
      status: "running",
      hypothesis: proposal.hypothesis || diagnosis.summary,
      change_type: "agent_rule",
      change_summary: proposal.proposal || "试写 QueryAgent 项目规则",
      change: { type: "agent_rule", agent_type: agentType, agent_id: agentId, rule },
      rollback: {
        type: "agent_rule",
        agent_type: agentType,
        agent_id: agentId,
        created,
        rules: previousRules,
        expected_current: nextRules,
      },
      diagnosis,
      trace_id: draft.trace_id,
      run_id: draft.run_id,
      session_id: draft.session_id,
      span_id: spanId,
      trace_snapshot: parseJson(draft.trace_snapshot_json, {}),
      notes: proposal.validation_plan || proposal.validationPlan || "",
      applied_at: now,
    });
    return row;
  } catch (error) {
    if (created) {
      await ctx.queryOne(
        `UPDATE agents
            SET deleted_at=now(), deleted_by=$1, updated_at=now()
          WHERE id=$2 AND project_id=$3 AND deleted_at IS NULL
            AND COALESCE(rules, '')=$4
          RETURNING id`,
        [ctx.userId, agentId, pid, nextRules],
      ).catch(() => null);
    } else {
      await ctx.queryOne(
        `UPDATE agents SET rules=$1, updated_at=now()
          WHERE id=$2 AND project_id=$3 AND deleted_at IS NULL
            AND COALESCE(rules, '')=$4
          RETURNING id`,
        [previousRules, agentId, pid, nextRules],
      ).catch(() => null);
    }
    throw error;
  }
}

function diagnosisSpan(draft, diagnosis) {
  const traceSnapshot = parseJson(draft.trace_snapshot_json, {});
  const first = object(diagnosis.first_divergence || diagnosis.firstDivergence);
  const candidates = [
    text(first.span_id || first.spanId),
    ...array(diagnosis.evidence_path || diagnosis.evidencePath).map((item) => text(object(item).span_id || object(item).spanId)),
  ].filter(Boolean);
  return candidates.find((spanId) => traceGetSpan(traceSnapshot, spanId)) || "";
}

async function readyDraft(ctx, pid, draftId) {
  const draft = await ctx.queryOne(
    `SELECT * FROM trace_eval_drafts WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [draftId, pid],
  );
  if (!draft) throw new ApiError("评测草稿不存在", 404);
  const gold = await goldSolveForDraft(ctx, draftId);
  if (!gold || gold.status !== "verified") throw new ApiError("请先确认独立参考解，再应用调优修改", 409);
  return draft;
}

export async function applyTuningChange(ctx, input) {
  const { pid, draftId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const draft = await readyDraft(ctx, pid, draftId);
  const body = input.body || {};
  const proposal = object(body.proposal || body);
  const diagnosis = object(body.diagnosis);
  const failureStage = text(diagnosis.failure_stage || diagnosis.failureStage);
  const requestedChangeType = text(proposal.change_type || proposal.changeType || "manual_check");
  const changeType = requestedChangeType === "prompt_rule" ? "agent_rule" : requestedChangeType;

  if (failureStage === "source_parsing" && changeType !== "none") {
    throw new ApiError("解析、OCR 或转写失败不能转换成 Prompt、规则或元数据修改", 422);
  }

  if (changeType === "none") {
    const row = await insertAttempt(ctx, pid, draft, {
      source: "diagnosis",
      status: "blocked",
      hypothesis: proposal.hypothesis || diagnosis.summary,
      change_type: "none",
      change_summary: proposal.requires_user_action || proposal.requiresUserAction || proposal.proposal || "需要用户补充来源处理能力",
      change: { type: "none", requires_user_action: proposal.requires_user_action || proposal.requiresUserAction || proposal.proposal || "" },
      diagnosis,
      notes: proposal.validation_plan || proposal.validationPlan || "",
    });
    return { data: attemptShape(row), message: "该问题不能自动修改，已记录所需处理能力" };
  }

  if (!new Set(["document_desc", "agent_rule"]).has(changeType)) {
    throw new ApiError(`当前只允许自动试写 document_desc 或 agent_rule；${changeType || "该修改"}需要人工确认`, 400);
  }

  const spanId = diagnosisSpan(draft, diagnosis);
  if (!spanId) throw new ApiError("修改必须绑定已经查看过的 Trace Span", 409);
  if (changeType === "agent_rule") {
    const row = await applyPromptRule(ctx, pid, draft, proposal, diagnosis, spanId);
    return { data: attemptShape(row), message: "QueryAgent 项目规则已试写，请重跑 Benchmark 后接受或回滚" };
  }
  const documentId = text(proposal.document_id || proposal.documentId);
  const nextDescription = compact(proposal.new_description || proposal.newDescription);
  if (!documentId || !nextDescription) throw new ApiError("document_desc 缺少 document_id 或 new_description", 400);
  assertGenericDescription(nextDescription, draft);

  const document = await ctx.queryOne(
    `SELECT id, project_id, title, description
       FROM unstructured_documents
      WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [documentId, pid],
  );
  if (!document) throw new ApiError("目标文档不存在或不属于当前项目", 404);
  const previousDescription = text(document.description);
  if (previousDescription === nextDescription) throw new ApiError("文档描述没有变化", 400);
  const updated = await ctx.queryOne(
    `UPDATE unstructured_documents
        SET description=$1, updated_at=now()
      WHERE id=$2 AND project_id=$3 AND deleted_at IS NULL
        AND COALESCE(description, '')=$4
      RETURNING id, title, description`,
    [nextDescription, documentId, pid, previousDescription],
  );
  if (!updated) throw new ApiError("文档描述已被其他操作修改，请刷新后重试", 409);
  const now = new Date().toISOString();
  let row;
  try {
    row = await insertAttempt(ctx, pid, draft, {
      source: "diagnosis",
      status: "running",
      hypothesis: proposal.hypothesis || diagnosis.summary,
      change_type: "document_desc",
      change_summary: proposal.proposal || `试写文档描述: ${updated.title || documentId}`,
      change: { type: "document_desc", document_id: documentId, description: nextDescription },
      rollback: { type: "document_desc", document_id: documentId, description: previousDescription, expected_current: nextDescription },
      diagnosis,
      trace_id: draft.trace_id,
      run_id: draft.run_id,
      session_id: draft.session_id,
      span_id: spanId,
      trace_snapshot: parseJson(draft.trace_snapshot_json, {}),
      notes: proposal.validation_plan || proposal.validationPlan || "",
      applied_at: now,
    });
  } catch (error) {
    await ctx.queryOne(
      `UPDATE unstructured_documents
          SET description=$1, updated_at=now()
        WHERE id=$2 AND project_id=$3 AND deleted_at IS NULL
          AND COALESCE(description, '')=$4
        RETURNING id`,
      [previousDescription, documentId, pid, nextDescription],
    ).catch(() => null);
    throw error;
  }
  return { data: attemptShape(row), message: "文档描述已试写，请重跑 Benchmark 后接受或回滚" };
}

export async function rollbackTuningChange(ctx, input) {
  const { pid, attemptId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const attempt = await ctx.queryOne(
    `SELECT * FROM trace_optimization_attempts WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [attemptId, pid],
  );
  if (!attempt) throw new ApiError("调试轮次不存在", 404);
  if (!new Set(["document_desc", "agent_rule"]).has(attempt.change_type)) {
    throw new ApiError("该调试轮次没有可自动回滚的配置", 400);
  }
  if (attempt.rolled_back_at) return { data: attemptShape(attempt), message: "该修改已经回滚" };
  const rollback = parseJson(attempt.rollback_json, {});
  let updated;
  if (attempt.change_type === "agent_rule" && rollback.created) {
    updated = await ctx.queryOne(
      `UPDATE agents
          SET deleted_at=now(), deleted_by=$1, updated_at=now()
        WHERE id=$2 AND project_id=$3 AND deleted_at IS NULL
          AND COALESCE(rules, '')=$4
          AND model_id IS NULL AND system_prompt IS NULL AND user_prompt_template IS NULL
        RETURNING id`,
      [ctx.userId, text(rollback.agent_id), pid, text(rollback.expected_current)],
    );
  } else if (attempt.change_type === "agent_rule") {
    updated = await ctx.queryOne(
      `UPDATE agents
          SET rules=$1, updated_at=now()
        WHERE id=$2 AND project_id=$3 AND deleted_at IS NULL
          AND COALESCE(rules, '')=$4
        RETURNING id`,
      [text(rollback.rules), text(rollback.agent_id), pid, text(rollback.expected_current)],
    );
  } else {
    updated = await ctx.queryOne(
      `UPDATE unstructured_documents
          SET description=$1, updated_at=now()
        WHERE id=$2 AND project_id=$3 AND deleted_at IS NULL
          AND COALESCE(description, '')=$4
        RETURNING id`,
      [text(rollback.description), text(rollback.document_id), pid, text(rollback.expected_current)],
    );
  }
  if (!updated) throw new ApiError("当前配置已再次变化，为避免覆盖新修改，本次不自动回滚", 409);
  const row = await ctx.queryOne(
    `UPDATE trace_optimization_attempts
        SET status='abandoned', rolled_back_at=now(), updated_by=$1, updated_at=now(), version=version+1
      WHERE id=$2
      RETURNING *`,
    [ctx.userId, attemptId],
  );
  return { data: attemptShape(row), message: "配置已精确回滚" };
}

export async function acceptTuningChange(ctx, input) {
  const { pid, attemptId } = input.params || {};
  await requireProjectAccess(ctx, pid);
  const row = await ctx.queryOne(
    `UPDATE trace_optimization_attempts
        SET status='passed', updated_by=$1, updated_at=now(), version=version+1
      WHERE id=$2 AND project_id=$3 AND deleted_at IS NULL AND rolled_back_at IS NULL
        AND change_type IN ('document_desc', 'agent_rule') AND applied_at IS NOT NULL
      RETURNING *`,
    [ctx.userId, attemptId, pid],
  );
  if (!row) throw new ApiError("调试轮次不存在、已回滚或不能接受", 409);
  return { data: attemptShape(row), message: "修改已接受；仍需以全新 Benchmark 重跑结果确认整体效果" };
}

export default { applyTuningChange, rollbackTuningChange, acceptTuningChange };
