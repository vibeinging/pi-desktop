import test from "node:test";
import assert from "node:assert/strict";

import {
  downloadRemoteSkill,
  parseGitHubSkillSource,
  searchRemoteSkills,
} from "./remote_skill_registry.js";

const skillMarkdown = `---
name: thesis-tracker
description: Track an investment thesis and its disconfirming evidence.
---

# Thesis Tracker

Keep a falsifiable thesis, pillars, risks, catalysts, and an update log.`;

function response(body, { status = 200, url = "" } = {}) {
  const value = new Response(body, { status, headers: { "content-type": "application/json" } });
  if (url) Object.defineProperty(value, "url", { value: url });
  return value;
}

test("公开 Skill 搜索返回可审计的 GitHub 来源，并优先精确名称", async () => {
  const fetchImpl = async (url) => {
    assert.match(String(url), /api\.github\.com\/repos\/anthropics\/financial-services/);
    return response(JSON.stringify({
      tree: [
        { type: "blob", path: "plugins/equity/skills/thesis-tracker/SKILL.md" },
        { type: "blob", path: "plugins/equity/skills/thesis-review/SKILL.md" },
      ],
    }), { url: String(url) });
  };
  const skills = await searchRemoteSkills("thesis-tracker Skill", {
    fetchImpl,
    registries: [{ owner: "anthropics", repo: "financial-services", branch: "main" }],
  });
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "thesis-tracker");
  assert.equal(skills[0].exact, true);
  assert.equal(skills[0].repository, "anthropics/financial-services");
  assert.match(skills[0].source_url, /^https:\/\/raw\.githubusercontent\.com\//);
  assert.match(skills[0].page_url, /^https:\/\/github\.com\//);
});

test("Skill 下载解析 SKILL.md 并记录不可变来源哈希", async () => {
  const sourceUrl = "https://github.com/anthropics/financial-services/blob/main/plugins/equity/skills/thesis-tracker/SKILL.md";
  const downloaded = await downloadRemoteSkill(sourceUrl, {
    fetchImpl: async (url) => response(skillMarkdown, { url: String(url) }),
  });
  assert.equal(downloaded.skill.name, "thesis-tracker");
  assert.match(downloaded.skill.instructions, /falsifiable thesis/);
  assert.equal(downloaded.provenance.repository, "anthropics/financial-services");
  assert.equal(downloaded.provenance.revision, "main");
  assert.equal(downloaded.provenance.sha256.length, 64);
  assert.equal(downloaded.provenance.package_mode, "skill_markdown");
});

test("Skill 下载拒绝非 GitHub 来源和非 SKILL.md 文件", () => {
  assert.throws(() => parseGitHubSkillSource("https://example.com/SKILL.md"), /只允许从 GitHub/);
  assert.throws(() => parseGitHubSkillSource("https://github.com/org/repo/blob/main/README.md"), /SKILL\.md/);
});
