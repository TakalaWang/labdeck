import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// The same settings the former pytest suite used; runs before any test module imports @labdeck/core.
const TMP = mkdtempSync(path.join(tmpdir(), 'portal-test-'))
Object.assign(process.env, {
  TEST_TMP: TMP,
  DATA_DIR: path.join(TMP, 'data'),
  PROM_SD_DIR: path.join(TMP, 'data', 'prom_sd'),
  REPO_DIR: '/repo',
  PUBLIC_URL: 'https://portal.test',
  SESSION_SECRET: 'test-secret',
  DISCORD_WEBHOOK_URL: '',
  SITE_NAME: 'Test Lab',
  OAUTH_NAME: 'ExampleID',
  OAUTH_CLIENT_ID: 'test-client',
  OAUTH_CLIENT_SECRET: 'test-client-secret',
  OAUTH_AUTHORIZE_URL: 'https://sso.example.org/authorize',
  OAUTH_TOKEN_URL: 'https://sso.example.org/token',
  OAUTH_PROFILE_URL: 'https://sso.example.org/profile',
  OAUTH_ID_FIELD: 'sub',
  OAUTH_EMAIL_FIELD: 'mail',
  RESERVED_USERS: 'ops, backup',
  DATA_MOUNT_GLOB: '/srv/data*',
  PROMETHEUS_URL: 'http://prometheus.invalid:9090',
  TZ: 'Asia/Taipei',
})
for (const k of ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'SMTP_SECURITY',
  'SMTP_PORT', 'MONITORING_SOURCE', 'NODE_EXPORTER_PORT', 'BOT_USER', 'INVENTORY_PATH']) {
  delete process.env[k]
}
