import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import markedKatex from "marked-katex-extension";
import hljs from 'highlight.js';
import "highlight.js/styles/ir-black.css";
import "katex/dist/katex.min.css";
import { sanitizeMarkdownHtml } from './safeHtml';

function escapeHtml(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code: any, lang: any, info: any) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language }).value;
    }
  }),
  markedKatex({
    throwOnError: false,
    output: 'html'
  }),
  {
    renderer: {
      // 对话和 Skill 内容均可能来自模型或外部文件，不执行 Markdown 中夹带的原始 HTML。
      html(html: string) {
        return escapeHtml(html);
      }
    }
  }
);

export function renderSafeMarkdown(source: string) {
  try {
    return sanitizeMarkdownHtml(marked.parse(String(source || '')) as string);
  } catch (error) {
    console.error('Markdown render error:', error);
    return escapeHtml(String(source || '')).replace(/\n/g, '<br>');
  }
}

// 提取标题生成目录
export function extractToc(markdown: any) {
  const headings: any[] = [];
  const tokens = marked.lexer(markdown);

  tokens.forEach((token: any) => {
    if (token.type === 'heading' && token.depth >= 2) {
      headings.push({
        level: token.depth,
        text: token.text,
        id: token.text
          .toLowerCase()
          .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
          .replace(/^-+|-+$/g, '')
      });
    }
  });

  return headings;
}

export default marked;
