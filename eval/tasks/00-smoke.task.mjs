// 冒烟：验证通用 Agent 首页可以正常打开。
export default {
  id: 'smoke',
  desc: '通用底座 UI 冒烟',
  async run({ driver, assert }) {
    await driver.ui.goto('/');
    await driver.ui.waitUntil(
      `() => location.pathname === '/agent'`,
      { timeout: 15000, label: '进入 Agent 首页' },
    );
    await driver.ui.waitForText('PI Desktop', { selector: 'body', timeout: 15000 });
    assert.eq(await driver.ui.exists('body'), true, 'Agent 首页应完成渲染');

    await driver.ui.goto('/not-found');
    await driver.ui.waitUntil(
      `() => location.pathname === '/agent'`,
      { timeout: 15000, label: '未知页面回到 Agent 首页' },
    );
  },
};
