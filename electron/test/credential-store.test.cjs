const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { CredentialStore } = require('../credential-store.cjs');

function fakeSafeStorage(backend = 'keychain') {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^encrypted:/, ''),
  };
}

test('系统凭据文件只保存密文，并支持读取和删除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-desktop-credentials-'));
  const filePath = join(dir, 'credentials.json');
  try {
    const store = new CredentialStore({ safeStorage: fakeSafeStorage(), filePath, platform: 'darwin' });
    const ref = 'credential:model:model-1:version-1';
    assert.equal(store.set(ref, 'secret-value'), true);
    assert.equal(store.get(ref), 'secret-value');
    assert.doesNotMatch(readFileSync(filePath, 'utf8'), /secret-value/);
    assert.equal(store.delete(ref), true);
    assert.equal(store.get(ref), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Linux basic_text 后端会被拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-desktop-credentials-insecure-'));
  try {
    const store = new CredentialStore({
      safeStorage: fakeSafeStorage('basic_text'),
      filePath: join(dir, 'credentials.json'),
      platform: 'linux',
    });
    assert.throws(() => store.set('credential:model:model-1:version-1', 'secret'), /Secret Service/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
