import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDocument, SUPPORTED_EXTS } from './document_loaders.js';

test('JSON is converted to a Markdown code block without a model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yiw-doc-'));
  try {
    const path = join(dir, 'sample.json');
    await writeFile(path, '{"name":"YiW"}', 'utf8');
    const markdown = await loadDocument(path, 'json');
    assert.match(markdown, /^```json/);
    assert.match(markdown, /"name": "YiW"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('image formats are accepted for secondary-model OCR', () => {
  for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif']) assert.ok(SUPPORTED_EXTS.includes(ext));
});

test('HTML conversion removes script and style content without relying on filtering regexes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yiw-html-'));
  try {
    const path = join(dir, 'sample.html');
    await writeFile(path, [
      '<h1 title="1 > 0">YiW</h1>',
      '<script>first<script>nested</script>second</script >',
      '<style>body { display: none }</style >',
      '<p>Safe &amp; visible</p>',
    ].join(''), 'utf8');
    const markdown = await loadDocument(path, 'html');
    assert.match(markdown, /^# YiW/);
    assert.match(markdown, /Safe & visible/);
    assert.doesNotMatch(markdown, /first|nested|second|display/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
