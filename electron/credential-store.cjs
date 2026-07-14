const fs = require('node:fs');
const path = require('node:path');

const CREDENTIAL_REF_RE = /^credential:[a-z0-9][a-z0-9:._-]{1,300}$/i;

class CredentialStore {
  constructor({ safeStorage, filePath, platform = process.platform }) {
    this.safeStorage = safeStorage;
    this.filePath = filePath;
    this.platform = platform;
    this.values = null;
  }

  _assertRef(ref) {
    const value = String(ref || '');
    if (!CREDENTIAL_REF_RE.test(value)) throw new Error('凭据引用无效');
    return value;
  }

  _assertSecure() {
    if (!this.safeStorage?.isEncryptionAvailable?.()) throw new Error('系统凭据存储当前不可用');
    const backend = this.safeStorage.getSelectedStorageBackend?.();
    if (this.platform === 'linux' && backend === 'basic_text') {
      throw new Error('Linux 未启用安全凭据服务，请安装并启动 Secret Service');
    }
  }

  _load() {
    if (this.values) return this.values;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.values = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`读取凭据文件失败: ${error?.message || error}`);
      this.values = {};
    }
    return this.values;
  }

  _save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.values, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch { /* Windows 不支持时忽略 */ }
  }

  set(ref, secret) {
    this._assertSecure();
    const key = this._assertRef(ref);
    const value = String(secret ?? '');
    if (Buffer.byteLength(value, 'utf8') > 1024 * 1024) throw new Error('凭据内容过大');
    this._load()[key] = this.safeStorage.encryptString(value).toString('base64');
    this._save();
    return true;
  }

  get(ref) {
    this._assertSecure();
    const key = this._assertRef(ref);
    const encrypted = this._load()[key];
    if (!encrypted) return null;
    try {
      return this.safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch (error) {
      throw new Error(`读取系统凭据失败: ${error?.message || error}`);
    }
  }

  delete(ref) {
    this._assertSecure();
    const key = this._assertRef(ref);
    const values = this._load();
    if (!Object.prototype.hasOwnProperty.call(values, key)) return false;
    delete values[key];
    this._save();
    return true;
  }
}

module.exports = { CredentialStore, CREDENTIAL_REF_RE };
