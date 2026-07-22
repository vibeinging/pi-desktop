import { ApiError } from "../../../errors.js";
import { acceptTuningChange, applyTuningChange, rollbackTuningChange } from "./changes.js";
import { runBenchmarkCase } from "./benchmark.js";
import { diagnoseDraft, generateTuningProposal } from "./gold.js";
import { json, object, text } from "./common.js";

function dataOf(response) {
  return response?.data ?? response ?? null;
}

function benchmarkPassed(verification) {
  const data = dataOf(verification) || {};
  const run = data.run || data;
  return run?.status === "passed" || run?.result?.pass === true;
}

function isSafeBlock(error) {
  return [400, 409, 422].includes(Number(error?.status || error?.statusCode || 0));
}

export async function runAutoOptimizationRound({
  diagnose,
  propose,
  apply,
  verify,
  recordVerification = async () => {},
  accept,
  rollback,
} = {}) {
  const diagnosis = dataOf(await diagnose());
  const proposal = dataOf(await propose(diagnosis));
  let attempt;
  try {
    attempt = dataOf(await apply({ diagnosis, proposal }));
  } catch (error) {
    if (!isSafeBlock(error)) throw error;
    return {
      status: "blocked",
      diagnosis,
      proposal,
      attempt: null,
      verification: null,
      finalization: null,
      error: error?.message || String(error),
    };
  }

  if (!attempt || attempt.change_type === "none" || attempt.status === "blocked") {
    return {
      status: "blocked",
      diagnosis,
      proposal,
      attempt,
      verification: null,
      finalization: null,
      error: "当前根因没有可安全自动应用的修改",
    };
  }

  let verification;
  try {
    verification = dataOf(await verify({ diagnosis, proposal, attempt }));
  } catch (error) {
    const finalization = dataOf(await rollback({ diagnosis, proposal, attempt, verification: null, error }));
    return {
      status: "reverted",
      diagnosis,
      proposal,
      attempt: finalization || attempt,
      verification: null,
      finalization,
      error: `Benchmark 运行失败，已回滚: ${error?.message || error}`,
    };
  }

  const passed = benchmarkPassed(verification);
  await recordVerification({ diagnosis, proposal, attempt, verification, passed });
  const finalization = dataOf(passed
    ? await accept({ diagnosis, proposal, attempt, verification })
    : await rollback({ diagnosis, proposal, attempt, verification }));
  return {
    status: passed ? "completed" : "reverted",
    diagnosis,
    proposal,
    attempt: finalization || attempt,
    verification,
    finalization,
    error: passed ? "" : "修改后的 Benchmark 未通过，已精确回滚",
  };
}

export async function runAutoOptimizationLoop({ runRound, maxAttempts = 3 } = {}) {
  if (typeof runRound !== "function") throw new TypeError("runRound is required");
  const rounds = [];
  const limit = Math.max(1, Math.min(5, Number(maxAttempts || 3)));
  for (let index = 0; index < limit; index += 1) {
    const outcome = dataOf(await runRound({ round: index + 1, previousRounds: rounds }));
    rounds.push(outcome);
    if (outcome?.status === "completed" || outcome?.status === "blocked") {
      return { ...outcome, rounds };
    }
  }
  const last = rounds.at(-1) || {};
  return {
    ...last,
    status: last.status || "reverted",
    rounds,
    error: `连续 ${rounds.length} 轮试写仍未通过 Benchmark，已全部回滚`,
  };
}

export async function autoOptimizeDraft(ctx, input) {
  const { pid, draftId } = input.params || {};
  const body = input.body || {};
  const benchmarkCaseId = text(body.benchmark_case_id || body.benchmarkCaseId);
  if (!benchmarkCaseId) throw new ApiError("缺少 benchmark_case_id，无法验证自动优化结果", 400);

  let cachedDiagnosis = null;
  const maxAttempts = Math.max(1, Math.min(5, Number(body.max_attempts || body.maxAttempts || 3)));
  const outcome = await runAutoOptimizationLoop({
    maxAttempts,
    runRound: async () => runAutoOptimizationRound({
    diagnose: async () => {
      if (cachedDiagnosis) return cachedDiagnosis;
      cachedDiagnosis = await diagnoseDraft(ctx, {
      params: { pid, draftId },
      body: {
        model_id: body.model_id || body.modelId,
        persist_attempt: false,
      },
      });
      return cachedDiagnosis;
    },
    propose: async (diagnosis) => generateTuningProposal(ctx, {
      params: { pid, draftId },
      body: {
        diagnosis,
        model_id: body.model_id || body.modelId,
      },
    }),
    apply: async ({ diagnosis, proposal }) => applyTuningChange(ctx, {
      params: { pid, draftId },
      body: { diagnosis, proposal },
    }),
    verify: async () => runBenchmarkCase(ctx, {
      params: { pid, caseId: benchmarkCaseId },
      body: {
        diagnose: false,
        force: body.force === true,
        cdp_port: body.cdp_port || body.cdpPort,
        timeout_ms: body.timeout_ms || body.timeoutMs,
      },
    }),
    recordVerification: async ({ attempt, verification, passed }) => {
      await ctx.queryOne(
        `UPDATE trace_optimization_attempts
            SET benchmark_case_id=$1, benchmark_result_json=$2,
                status=CASE WHEN $3 THEN status ELSE 'failed' END,
                updated_by=$4, updated_at=now(), version=version+1
          WHERE id=$5 AND project_id=$6 AND deleted_at IS NULL
          RETURNING id`,
        [benchmarkCaseId, json(object(verification)), passed, ctx.userId, attempt.id, pid],
      );
    },
    accept: async ({ attempt }) => acceptTuningChange(ctx, {
      params: { pid, attemptId: attempt.id },
    }),
    rollback: async ({ attempt }) => rollbackTuningChange(ctx, {
      params: { pid, attemptId: attempt.id },
    }),
    }),
  });

  return {
    data: {
      ...outcome,
      draft_id: draftId,
      benchmark_case_id: benchmarkCaseId,
    },
    message: outcome.status === "completed"
      ? "自动优化已通过 Benchmark，修改已接受"
      : outcome.status === "reverted"
        ? "自动优化未通过 Benchmark，修改已回滚"
        : "自动优化已停止，没有可安全应用的修改",
  };
}

export default { autoOptimizeDraft, runAutoOptimizationLoop, runAutoOptimizationRound };
