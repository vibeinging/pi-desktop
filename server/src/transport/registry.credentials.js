import {
  credentialMigrationStatus,
  retryCredentialMigration,
} from '../app/credentials/index.js';

export const credentialRoutes = [
  { m: 'GET', p: '/api/settings/credentials/migration', fn: credentialMigrationStatus },
  { m: 'POST', p: '/api/settings/credentials/migration/retry', fn: retryCredentialMigration },
];
