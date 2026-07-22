import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSession } from "./index.js";

test("项目会话要求当前项目成员，聊天会话不需要项目成员", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yiw-session-membership-"));
  process.env.DB_SQLITE_PATH = join(dir, "session-membership.db");
  const db = await import(`../../db.js?session-membership-test=${Date.now()}`);
  const userId = "user-session-membership";
  const ctx = { userId, query: db.query, queryOne: db.queryOne };
  try {
    const request = {
      params: { pid: "project-session-membership" },
      body: {
        title: "项目产品会话",
        source_type: "agent",
        source_id: "project-session-membership",
        action_type: "skill_product",
      },
    };
    await assert.rejects(() => createSession(ctx, request), /项目不存在或无权限/);

    await ctx.query(
      `INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ($1,$2,'active',now(),now())`,
      ["project-session-membership", "会话权限项目"],
    );
    await ctx.query(
      `INSERT INTO project_members (id,project_id,user_id,is_owner,created_at,updated_at)
       VALUES ($1,$2,$3,1,now(),now())`,
      ["member-session", "project-session-membership", userId],
    );
    const projectSession = await createSession(ctx, request);
    assert.equal(projectSession.data.action_type, "skill_product");

    const chatSession = await createSession(ctx, {
      params: { pid: "__chat__" },
      body: {
        title: "聊天产品会话",
        source_type: "agent",
        source_id: "__chat__",
        action_type: "skill_product",
      },
    });
    assert.equal(chatSession.data.project_id, "__chat__");
  } finally {
    db.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
