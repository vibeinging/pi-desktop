// 通用错误文案格式化。当前桌面底座不内置业务词典；界面文案由 renderer i18n 负责。
// 保留这个小接口，是为了让底层模块可以逐步接入真正的服务端多语言实现。
export function t(message, ...values) {
  let index = 0;
  return String(message).replace(/\{\}/g, () => {
    if (index >= values.length) return '{}';
    const value = values[index];
    index += 1;
    return String(value);
  });
}
