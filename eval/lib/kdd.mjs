// KDD task 公共工具:数据源路径 + 导入调度(按 context 类型分流到 db/structured/unstructured)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

// KDD 数据集可能由主工程共享，也可以通过环境变量显式指定。
// 不把个人机器上的某个旧 checkout 写死成唯一来源。
const KDD_ROOT_CANDIDATES = [
  process.env.YIW_KDD_ROOT,
  path.resolve(process.cwd(), 'eval/datasets/public'),
].filter(Boolean);

export const KDD_ROOT = KDD_ROOT_CANDIDATES.find((root) =>
  existsSync(path.join(root, 'input')) && existsSync(path.join(root, 'output'))
) || KDD_ROOT_CANDIDATES[0];
export const INPUT = path.join(KDD_ROOT, 'input');
export const OUTPUT = path.join(KDD_ROOT, 'output');

/** 扫描 task 的 context 目录,分类数据文件(跳过 AppleDouble 和 .DS_Store) */
export function scanContext(taskId) {
  const ctx = path.join(INPUT, taskId, 'context');
  return scanContextDir(ctx);
}

/** 递归扫描 context 目录,对齐根目录 Python eval 的 context.rglob("*") 行为。 */
export function scanContextDir(ctx) {
  const out = { db: [], csv: [], json: [], structured: [], doc: [], knowledge: '' };
  if (!existsSync(ctx)) return out;

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.name || entry.name.startsWith('.') || entry.name.startsWith('._')) continue;
      if (entry.name === '_parsed') continue;
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fp);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (entry.name === 'knowledge.md') {
        out.knowledge = readFileSync(fp, 'utf-8');
      } else if (['.db', '.sqlite', '.sqlite3', '.duckdb'].includes(ext)) {
        out.db.push(fp);
      } else if (['.csv', '.tsv'].includes(ext)) {
        out.csv.push(fp);
        out.structured.push(fp);
      } else if (['.json', '.jsonl', '.xlsx', '.xls'].includes(ext)) {
        out.json.push(fp);
        out.structured.push(fp);
      } else if (['.md', '.markdown', '.txt', '.pdf', '.docx', '.doc', '.png', '.jpg', '.jpeg'].includes(ext)) {
        out.doc.push(fp);
      }
    }
  };

  walk(ctx);
  for (const key of ['db', 'csv', 'json', 'structured', 'doc']) out[key].sort();
  return out;
}

/** 读 task.json */
export function readTask(taskId) {
  const f = path.join(INPUT, taskId, 'task.json');
  return JSON.parse(readFileSync(f, 'utf-8'));
}

/** gold.csv 路径 */
export function goldPath(taskId) {
  return path.join(OUTPUT, taskId, 'gold.csv');
}

/**
 * 按 context 类型导入数据源到项目。优先级:db > structured(csv+json) > doc。
 * 返回 { connId, connIds } —— 单源返回 connId,多源返回 connIds 数组。
 */
export async function importTask(driver, pid, ctx) {
  const connIds = [];
  // 1. db 文件 → importDatabase(主连接)
  if (ctx.db.length) {
    console.log(`  [importTask] db 导入: ${ctx.db[0]} (+${ctx.knowledge.length}字 knowledge)`);
    const r = await driver.importDatabase(pid, ctx.db[0], { extraNotes: ctx.knowledge });
    console.log(`  [importTask] db 完成: connId=${r.connId}, ${r.tables.length} 表 [${r.tables.map(t=>t.name).join(',')}]`);
    connIds.push(r.connId);
  }
  // 2. csv+json → importStructured(一个结构化数据源,后端建 DuckDB 表)
  const structuredFiles = ctx.structured?.length ? ctx.structured : [...ctx.csv, ...ctx.json];
  if (structuredFiles.length) {
    console.log(`  [importTask] structured 导入: ${structuredFiles.length} 文件 [${structuredFiles.map(f=>f.replace(/.*\//,'')).join(',')}]`);
    const r = await driver.importTable(pid, structuredFiles, { dsName: 'kdd-structured' });
    console.log(`  [importTask] structured 完成: connId=${r.connId}, 表 [${(r.tables||[]).join(',')}]`);
    connIds.push(r.connId);
  }
  // 3. doc → importUnstructured(RAG)
  if (ctx.doc.length) {
    console.log(`  [importTask] unstructured 导入: ${ctx.doc.length} 文档`);
    await driver.importUnstructured(pid, ctx.doc, { name: 'kdd-docs' });
    console.log(`  [importTask] unstructured 完成`);
  }
  // 4. knowledge.md → 注入当前实际执行问数的 query_agent rules
  if (ctx.knowledge) {
    console.log(`  [importTask] 注入 knowledge.md 到 agent rules (${ctx.knowledge.length}字)`);
    await driver.injectKnowledge(pid, ctx.knowledge);
    console.log(`  [importTask] knowledge 注入完成`);
  }
  // 纯文档任务没有数据库连接，但仍是合法的项目数据源。
  // askQuery 当前按项目创建会话，不依赖 connId，因此这里允许 connId 为空。
  if (!connIds.length && !ctx.doc.length) throw new Error('task 无可导入数据源(db/csv/json/doc)');
  return { connId: connIds[0], connIds };
}
