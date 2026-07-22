#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { openSession } from "./cdp.mjs";

const port = Number(process.env.CDP_PORT || 9223);
const moduleName = process.env.YIW_SKILL_PRODUCT_NAME || "Thesis Tracker";
const screenshotPath = process.env.YIW_SKILL_PRODUCT_SCREENSHOT || "/private/tmp/yiw-thesis-tracker-product.png";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const session = await openSession({ port });
try {
  await session.cdp("Page.reload", { ignoreCache: true });
  await sleep(1200);

  await session.evalJs(`
    const skip = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '跳过');
    if (skip) skip.click();
    return !!skip;
  `);
  await sleep(800);

  let sidebar = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    sidebar = await session.evalJs(`
      const { useBasicStore } = await import('/src/store/basic');
      const state = useBasicStore.getState();
      const token = state.token || '';
      const response = await window.electronAPI.apiRequest({
        method: 'GET',
        url: '/api/ui-modules',
        headers: token ? { Authorization: 'Bearer ' + token } : {},
      });
      const items = response.json?.data?.items || [];
      const moduleButton = [...document.querySelectorAll('button')]
        .find((button) => button.textContent?.includes(${JSON.stringify(moduleName)}));
      return {
        href: location.href,
        user_id: state.userInfo?.userId || '',
        username: state.userInfo?.username || '',
        modules: items.map((item) => ({ id: item.id, name: item.name, status: item.status })),
        sidebar_visible: !!moduleButton,
        body_text: document.body.innerText.slice(0, 4000),
      };
    `);
    if (sidebar.sidebar_visible) break;
    await sleep(500);
  }

  if (!sidebar.sidebar_visible) {
    throw new Error(`侧边栏没有显示 ${moduleName}; user=${sidebar.user_id || "(empty)"}; modules=${JSON.stringify(sidebar.modules)}; body=${sidebar.body_text.slice(0, 500)}`);
  }

  const opened = await session.evalJs(`
    const target = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes(${JSON.stringify(moduleName)}));
    if (!target) return false;
    target.click();
    return true;
  `);
  if (!opened) throw new Error(`无法点击 ${moduleName} 侧边栏入口`);
  await sleep(2500);

  const product = await session.evalJs(`
    const text = document.body.innerText;
    return {
      title_visible: text.includes(${JSON.stringify(moduleName)}),
      dashboard_visible: text.includes('看板'),
      scorecard_visible: text.includes('计分卡'),
      catalysts_visible: text.includes('催化剂'),
      updates_visible: text.includes('更新日志'),
      workspace_visible: text.includes('工作台'),
      body_text: text.slice(0, 6000),
    };
  `);
  const required = ["title_visible", "dashboard_visible", "scorecard_visible", "catalysts_visible", "updates_visible", "workspace_visible"];
  const missing = required.filter((key) => !product[key]);
  if (missing.length) throw new Error(`小程序页面缺少可见区域: ${missing.join(", ")}`);

  const moduleId = sidebar.modules.find((item) => item.name === moduleName)?.id || "";
  const backend = await session.evalJs(`
    const { useBasicStore } = await import('/src/store/basic');
    const token = useBasicStore.getState().token || '';
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const detail = await window.electronAPI.apiRequest({
      method: 'GET',
      url: '/api/ui-modules/' + encodeURIComponent(${JSON.stringify(moduleId)}),
      headers,
    });
    return { detail };
  `);
  const versionId = backend.detail?.json?.data?.version?.id || "";
  const action = await session.evalJs(`
    const { useBasicStore } = await import('/src/store/basic');
    const token = useBasicStore.getState().token || '';
    return await window.electronAPI.apiRequest({
      method: 'POST',
      url: '/api/ui-modules/' + encodeURIComponent(${JSON.stringify(moduleId)}) + '/actions/load_product_data',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: {}, version_id: ${JSON.stringify(versionId)}, request_id: crypto.randomUUID() }),
    });
  `);
  if (action.status !== 200 || action.json?.success !== true) {
    throw new Error(`小程序数据读取动作失败: HTTP ${action.status}`);
  }

  const screenshot = await session.cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
  console.log(JSON.stringify({
    success: true,
    user_id: sidebar.user_id,
    username: sidebar.username,
    module: sidebar.modules.find((item) => item.name === moduleName) || null,
    backend_action: {
      name: "load_product_data",
      status: action.status,
      exists: action.json?.data?.exists === true,
      revision: action.json?.data?.revision ?? null,
    },
    visible: Object.fromEntries(required.map((key) => [key, product[key]])),
    screenshot: screenshotPath,
  }, null, 2));
} finally {
  session.close();
}
