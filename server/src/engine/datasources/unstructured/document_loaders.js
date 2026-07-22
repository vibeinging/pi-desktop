// 迁移自 yiw_kernel/semantic_catalogs/unstructured_data/document_loaders/(桌面版,用 Node 库)
//
// 按扩展名把文件转成 Markdown:
//   - txt/md/log/json/csv:Node 内置 fs(json 美化、csv 原样文本)
//   - html/htm:剥标签
//   - pdf:pdf-parse / docx:mammoth / xlsx·xls:xlsx(各 sheet 转文本)
// 不支持的扩展名抛错(由上层标记文档失败)。

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { chat } from '../../core/llm.js';

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToMarkdown(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '# $1\n\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '## $1\n\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '### $1\n\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function loadPdf(path) {
  const mod = await import('pdf-parse');
  const buf = await readFile(path);
  if (typeof mod.PDFParse === 'function') {
    const parser = new mod.PDFParse({ data: buf });
    try {
      const r = await parser.getText();
      return r.text || '';
    } finally {
      await parser.destroy();
    }
  }

  const pdf = mod.default || mod;
  if (typeof pdf !== 'function') {
    throw new Error('当前 pdf-parse 版本不支持 PDF 解析函数');
  }
  const r = await pdf(buf);
  return r.text || '';
}

async function loadDocx(path) {
  const mod = await import('mammoth');
  const mammoth = mod.default || mod;
  const r = await mammoth.extractRawText({ path });
  return r.value || '';
}

async function loadXlsx(path) {
  const mod = await import('xlsx');
  const XLSX = mod.default || mod;
  const wb = XLSX.readFile(path);
  const parts = [];
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
    if (csv && csv.trim()) parts.push(`# Sheet: ${name}\n${csv}`);
  }
  return parts.join('\n\n');
}

function imageMime(ext) {
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'svg') return 'image/svg+xml';
  return `image/${ext}`;
}

async function loadImage(path, ext, { projectId = null, modelId = null } = {}) {
  const image = await readFile(path);
  if (image.byteLength > 20 * 1024 * 1024) throw new Error('图片超过 20MB，请压缩后再处理');
  const data = image.toString('base64');
  const result = await chat([
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '请把图片里的可见内容完整转成 Markdown。保留标题、段落、列表和表格结构；看不清的内容标记为[无法识别]。只输出 Markdown，不要解释。',
        },
        { type: 'image_url', image_url: { url: `data:${imageMime(ext)};base64,${data}` } },
      ],
    },
  ], {
    project_id: projectId,
    model_id: modelId,
    model_role: 'secondary',
    temperature: 0,
    max_tokens: 8000,
    call_site: 'unstructured_image_to_markdown',
  });
  return String(result || '').replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '').trim();
}

/**
 * 把文件转换为 Markdown 文本。
 * @param {string} filePath
 * @param {string} [fileExt] 扩展名(不含点);不给则从 filePath 推断
 * @returns {Promise<string>}
 */
export async function loadDocument(filePath, fileExt = null, options = {}) {
  const ext = String(fileExt || extname(filePath).slice(1) || '').toLowerCase();
  switch (ext) {
    case 'txt': case 'md': case 'markdown': case 'log': case 'text':
      return (await readFile(filePath, 'utf8'));
    case 'csv': case 'tsv': {
      const raw = await readFile(filePath, 'utf8');
      return `\`\`\`${ext}\n${raw}\n\`\`\``;
    }
    case 'json': {
      const raw = await readFile(filePath, 'utf8');
      try { return `\`\`\`json\n${JSON.stringify(JSON.parse(raw), null, 2)}\n\`\`\``; } catch { return raw; }
    }
    case 'html': case 'htm':
      return htmlToMarkdown(await readFile(filePath, 'utf8')) || stripHtml(await readFile(filePath, 'utf8'));
    case 'pdf':
      return loadPdf(filePath);
    case 'docx':
      return loadDocx(filePath);
    case 'xlsx': case 'xls':
      return loadXlsx(filePath);
    case 'png': case 'jpg': case 'jpeg': case 'webp': case 'gif':
      return loadImage(filePath, ext, options);
    default:
      throw new Error(`不支持的文档类型: .${ext}(支持 txt/md/csv/json/html/pdf/docx/xlsx/png/jpg/webp/gif)`);
  }
}

/** 支持的扩展名(供上层校验/前端提示)。 */
export const SUPPORTED_EXTS = ['txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'html', 'htm', 'pdf', 'docx', 'xlsx', 'xls', 'png', 'jpg', 'jpeg', 'webp', 'gif'];

export default loadDocument;
