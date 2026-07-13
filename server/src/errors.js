// 用例层统一错误：transport 边界会把 ApiError 转成失败响应。
export class ApiError extends Error {
  constructor(message, status = 400, code = status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}
