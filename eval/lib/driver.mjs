// 通用 Electron UI 驱动。业务项目可在此基础上增加高层操作。
import { makeUiDriver } from './ui-driver.mjs';

export function makeDriver(session) {
  return {
    ui: makeUiDriver(session),
    evalJs: session.evalJs,
    async login() {},
  };
}
