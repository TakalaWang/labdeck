import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const BASE_URL = 'http://localhost:8080'; // = PUBLIC_URL written by run.sh
/** The copy of the repo that run.sh brought up (compose project `labdeck-e2e`, see e2e/compose.e2e.yaml). */
export const APP_DIR = process.env.E2E_APP_DIR ?? path.resolve(__dirname, '../.work/app');
const NETWORK = 'labdeck-e2e_lab';

export type Job = {
  id: number;
  kind: string;
  status: string;
  check_output: string | null;
  output: string | null;
};

function run(cmd: string, args: string[], cwd?: string): string {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
  } catch (e) {
    const err = e as { message: string; stdout?: string };
    throw new Error(`${err.message}\n${err.stdout ?? ''}`);
  }
}

/** `docker compose … <args>` in the copied app dir; returns stdout. */
export function dc(...args: string[]): string {
  return run('docker', ['compose', '-f', 'compose.yaml', '-f', 'e2e/compose.e2e.yaml', ...args], APP_DIR);
}

/** Log in through the mock SSO form; ends back on the portal. */
export async function login(page: Page, username: string): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder('username').fill(username);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.origin === BASE_URL && !url.pathname.startsWith('/auth/'));
  const session = await api(page.request, 'GET', '/api/session');
  expect(session.identity?.sso_id, 'logged in as').toBe(username);
}

export async function csrf(request: APIRequestContext): Promise<string> {
  const r = await request.get('/api/session');
  expect(r.ok(), `GET /api/session → ${r.status()}`).toBeTruthy();
  return (await r.json()).csrf;
}

/** JSON API call with the session's CSRF token and our Origin (docs/api.md 通則); fails the test on non-2xx. */
export async function api<T = any>(request: APIRequestContext, method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Origin: BASE_URL };
  if (method !== 'GET') headers['X-CSRF-Token'] = await csrf(request);
  const r = await request.fetch(path, { method, headers, data: body });
  const text = await r.text();
  expect(r.ok(), `${method} ${path} → ${r.status()} ${text}`).toBeTruthy();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Poll /api/admin/jobs/{id} until its status is one of `status`. */
export async function waitForJob(
  request: APIRequestContext,
  id: number,
  { status = ['ok', 'failed'], timeout = 6 * 60_000 }: { status?: string[]; timeout?: number } = {},
): Promise<Job> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const job = await api<Job>(request, 'GET', `/api/admin/jobs/${id}`);
    if (status.includes(job.status)) return job;
    if (Date.now() > deadline) {
      throw new Error(`job ${id} (${job.kind}) still '${job.status}' after ${timeout / 1000}s\n${job.output ?? ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/**
 * One-time bot bootstrap as a human admin would run it (docs/deploy.md 新增主機), with the fake host's
 * pre-existing admin account. The runner reaches gpu01 directly on the compose network, so the bot key's
 * from= restriction is the network's subnet.
 */
export function bootstrap(host: string): string {
  const subnets = run('docker', ['network', 'inspect', NETWORK, '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}']);
  const subnet = subnets.split(/\s+/).find((s) => s.includes('.'));
  if (!subnet) throw new Error(`no IPv4 subnet on ${NETWORK}: ${subnets}`);
  // Per-host admin passwords file (docs/deploy.md); plaintext is fine for this throwaway stack.
  writeFileSync(path.join(APP_DIR, 'secrets', 'bootstrap_passwords.yml'), `bootstrap_passwords:\n  ${host}: adminpw\n`, { mode: 0o644 });
  return dc('run', '--rm', '-T', 'cli', 'ansible-playbook', 'playbooks/bootstrap_bot.yaml', '-l', host, '-u', 'admin',
    '-e', '@/run/secrets/bootstrap_passwords.yml', '-e', '@/run/secrets/vault.yml', '-e', `monitoring_host_ip=${subnet}`);
}
