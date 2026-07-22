import { createHash } from "node:crypto";
import { ApiError } from "../../errors.js";
import { parseSkillMarkdown } from "./skill_file_loader.js";

const DEFAULT_REGISTRIES = [
  { owner: "anthropics", repo: "skills", branch: "main" },
  { owner: "anthropics", repo: "financial-services", branch: "main" },
  { owner: "OctagonAI", repo: "skills", branch: "main" },
];
const ALLOWED_SOURCE_HOSTS = new Set(["github.com", "raw.githubusercontent.com"]);
const MAX_TREE_BYTES = 8 * 1024 * 1024;
const MAX_SKILL_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

function clean(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function normalizedQuery(value) {
  return clean(value, 160)
    .replace(/\bskills?\b/gi, " ")
    .replace(/[“”"'`]/g, "")
    .trim()
    .toLowerCase();
}

function githubSource({ owner, repo, revision, path }) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return {
    owner,
    repo,
    repository: `${owner}/${repo}`,
    revision,
    path,
    source_url: `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(revision)}/${encodedPath}`,
    page_url: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${encodeURIComponent(revision)}/${encodedPath}`,
  };
}

export function parseGitHubSkillSource(value) {
  let url;
  try {
    url = new URL(clean(value, 2_000));
  } catch {
    throw new ApiError("Skill 来源必须是有效的 GitHub URL", 400);
  }
  if (url.protocol !== "https:" || !ALLOWED_SOURCE_HOSTS.has(url.hostname)) {
    throw new ApiError("目前只允许从 GitHub HTTPS 地址下载 Skill", 400);
  }
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  let owner;
  let repo;
  let revision;
  let path;
  if (url.hostname === "github.com") {
    if (parts[2] !== "blob" || parts.length < 6) throw new ApiError("GitHub 地址必须指向一个 SKILL.md 文件", 400);
    [owner, repo] = parts;
    revision = parts[3];
    path = parts.slice(4).join("/");
  } else {
    if (parts.length < 5) throw new ApiError("GitHub Raw 地址必须指向一个 SKILL.md 文件", 400);
    [owner, repo, revision] = parts;
    path = parts.slice(3).join("/");
  }
  if (!owner || !repo || !revision || !/(^|\/)SKILL\.md$/i.test(path)) {
    throw new ApiError("下载地址必须指向 SKILL.md", 400);
  }
  return githubSource({ owner, repo, revision, path });
}

async function fetchBytes(url, { fetchImpl = globalThis.fetch, maxBytes, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") throw new ApiError("当前运行环境不支持下载 Skill", 500);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { Accept: "application/vnd.github+json, text/plain;q=0.9" },
    });
    if (!response?.ok) throw new ApiError(`下载 Skill 失败: HTTP ${response?.status || 0}`, 502);
    const finalUrl = new URL(response.url || url);
    if (finalUrl.protocol !== "https:" || !new Set(["api.github.com", ...ALLOWED_SOURCE_HOSTS]).has(finalUrl.hostname)) {
      throw new ApiError("Skill 下载发生了不安全的跳转", 400);
    }
    const declared = Number(response.headers?.get?.("content-length") || 0);
    if (declared > maxBytes) throw new ApiError(`Skill 来源内容超过 ${Math.floor(maxBytes / 1024)}KB 限制`, 413);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new ApiError(`Skill 来源内容超过 ${Math.floor(maxBytes / 1024)}KB 限制`, 413);
    return bytes;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === "AbortError") throw new ApiError("下载 Skill 超时", 504);
    throw new ApiError(`下载 Skill 失败: ${error?.message || error}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

async function registryTree(registry, options = {}) {
  const url = `https://api.github.com/repos/${encodeURIComponent(registry.owner)}/${encodeURIComponent(registry.repo)}/git/trees/${encodeURIComponent(registry.branch)}?recursive=1`;
  const bytes = await fetchBytes(url, { ...options, maxBytes: MAX_TREE_BYTES });
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new ApiError(`Skill 仓库 ${registry.owner}/${registry.repo} 返回了无效目录`, 502);
  }
  return Array.isArray(parsed?.tree) ? parsed.tree : [];
}

function sourceScore(source, query) {
  const skillName = source.path.split("/").slice(-2, -1)[0]?.toLowerCase() || "";
  if (skillName === query) return 100;
  if (skillName.replace(/[-_]/g, " ") === query.replace(/[-_]/g, " ")) return 95;
  if (skillName.includes(query) || query.includes(skillName)) return 75;
  if (source.path.toLowerCase().includes(query)) return 50;
  return 0;
}

export async function searchRemoteSkills(query, { fetchImpl = globalThis.fetch, registries = DEFAULT_REGISTRIES, limit = 8 } = {}) {
  const rawQuery = clean(query, 2_000);
  if (!rawQuery) throw new ApiError("请输入要查找的 Skill 名称", 400);
  if (/^https:\/\//i.test(rawQuery)) {
    const source = parseGitHubSkillSource(rawQuery);
    return [{ ...source, name: source.path.split("/").slice(-2, -1)[0] || "skill", exact: true }];
  }
  const needle = normalizedQuery(rawQuery);
  if (!needle) throw new ApiError("请输入更具体的 Skill 名称", 400);
  const settled = await Promise.allSettled(registries.map(async (registry) => {
    const tree = await registryTree(registry, { fetchImpl });
    return tree
      .filter((item) => item?.type === "blob" && /(^|\/)SKILL\.md$/i.test(String(item.path || "")))
      .map((item) => githubSource({ ...registry, revision: registry.branch, path: item.path }))
      .map((source) => ({ ...source, score: sourceScore(source, needle) }))
      .filter((source) => source.score > 0);
  }));
  const items = settled.flatMap((item) => item.status === "fulfilled" ? item.value : []);
  const errors = settled.filter((item) => item.status === "rejected").map((item) => item.reason?.message || String(item.reason));
  const results = items
    .sort((a, b) => b.score - a.score || a.repository.localeCompare(b.repository) || a.path.localeCompare(b.path))
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 8)))
    .map((source) => ({
      ...source,
      name: source.path.split("/").slice(-2, -1)[0] || "skill",
      exact: source.score >= 95,
    }));
  if (!results.length && errors.length === settled.length) {
    throw new ApiError(`公开 Skill 仓库暂时不可用: ${errors[0]}`, 502);
  }
  return results;
}

function relativeReferenceWarnings(markdown) {
  const refs = [...String(markdown || "").matchAll(/\[[^\]]*\]\((?!https?:|#|\/)([^)]+)\)/gi)]
    .map((match) => clean(match[1], 240))
    .filter(Boolean);
  return refs.length
    ? [`这个 Skill 引用了 ${refs.length} 个相对文件；当前版本只导入 SKILL.md，运行前需要检查这些附加文件: ${refs.slice(0, 5).join(", ")}`]
    : [];
}

export async function downloadRemoteSkill(sourceUrl, { fetchImpl = globalThis.fetch } = {}) {
  const source = parseGitHubSkillSource(sourceUrl);
  const bytes = await fetchBytes(source.source_url, { fetchImpl, maxBytes: MAX_SKILL_BYTES });
  const markdown = Buffer.from(bytes).toString("utf8");
  const fallbackName = source.path.split("/").slice(-2, -1)[0] || "downloaded-skill";
  const skill = parseSkillMarkdown(markdown, { fallbackName });
  if (!skill?.instructions) throw new ApiError("下载到的 SKILL.md 没有可执行指令", 400);
  return {
    skill,
    markdown,
    warnings: relativeReferenceWarnings(markdown),
    provenance: {
      provider: "github",
      repository: source.repository,
      revision: source.revision,
      path: source.path,
      source_url: source.source_url,
      page_url: source.page_url,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      imported_at: new Date().toISOString(),
      package_mode: "skill_markdown",
    },
  };
}

export const PUBLIC_SKILL_REGISTRIES = Object.freeze(DEFAULT_REGISTRIES.map((item) => ({ ...item })));

export default { searchRemoteSkills, downloadRemoteSkill, parseGitHubSkillSource, PUBLIC_SKILL_REGISTRIES };
