import {
  getCredentialMigrationState,
  migrateLegacyCredentials,
} from '../../credentials.js';

export async function credentialMigrationStatus() {
  return getCredentialMigrationState();
}

export async function retryCredentialMigration(ctx) {
  return migrateLegacyCredentials({ query: ctx.query });
}
