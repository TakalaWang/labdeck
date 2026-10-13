import { expect, test } from '@playwright/test';
import { api, BASE_URL, bootstrap, dc, login, waitForJob } from './helpers';

// The whole lifecycle through /api/* (browser only for the SSO login), against the fake host gpu01:
// add host → bootstrap → monitoring agents → Prometheus scrape → collect → registration → assignment
// → revoke → metrics endpoints → CSRF. One test: every step depends on the previous one.
test('host onboarding and account lifecycle via the API', async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const admin = adminCtx.request;
  const carolCtx = await browser.newContext();
  const carol = carolCtx.request;
  const gpu01 = (...cmd: string[]) => dc('exec', '-T', 'gpu01', ...cmd);
  let personId = 0;
  let expectedEnd = '';

  await test.step('admin logs in', async () => {
    await login(await adminCtx.newPage(), 'tester');
    const { user } = await api(admin, 'GET', '/api/session');
    expect(user).toMatchObject({ username: 'tester', role: 'admin', status: 'active' });
  });

  await test.step('add host gpu01', async () => {
    const host = await api(admin, 'POST', '/api/admin/hosts', { name: 'gpu01', address: 'gpu01', group: 'gpu' });
    expect(host).toMatchObject({ name: 'gpu01', address: 'gpu01', group: 'gpu', monitored: false });
  });

  await test.step('bootstrap the bot account with the existing admin account', async () => {
    bootstrap('gpu01');
  });

  await test.step('install monitoring agents', async () => {
    const { job_id } = await api(admin, 'POST', '/api/admin/hosts/gpu01/agents');
    const job = await waitForJob(admin, job_id);
    expect(job.status, job.output ?? '').toBe('ok');
    expect((await api(admin, 'GET', '/api/hosts/gpu01')).monitored).toBe(true);
    // root-owned, not the tarball's uid/gid (which may be a user on the host): only root can swap the binary
    const owners = gpu01('bash', '-c', 'stat -c %U:%G /opt/node_exporter-*.linux-amd64 /opt/node_exporter-*.linux-amd64/*');
    expect(new Set(owners.trim().split('\n'))).toEqual(new Set(['root:root']));
  });

  await test.step('Prometheus scrapes gpu01 over TLS + basic auth', async () => {
    await expect
      .poll(async () => {
        const hosts: any[] = await api(admin, 'GET', '/api/hosts');
        return hosts.find((h) => h.name === 'gpu01')?.status?.up ?? null;
      }, { timeout: 3 * 60_000, intervals: [5_000] })
      .toBe(true);
  });

  await test.step('per-user CPU: a busy process of alice shows up in /api/metrics/users', async () => {
    // stdio to /dev/null: `docker compose exec` returns once nothing holds its output open
    gpu01('su', 'alice', '-c', 'timeout 300 sh -c "while :; do :; done" >/dev/null 2>&1 &');
    const alice = async () => {
      const { hosts }: { hosts: any[] } = await api(admin, 'GET', '/api/metrics/users');
      return hosts.find((h) => h.host === 'gpu01')?.users.find((u: any) => u.user === 'alice')?.cpu_cores ?? 0;
    };
    await expect.poll(alice, { timeout: 3 * 60_000, intervals: [5_000] }).toBeGreaterThan(0.5);
    const host = await api(admin, 'GET', '/api/metrics/hosts/gpu01/users');
    expect(host).toMatchObject({ host: 'gpu01', up: true });
    expect(host.cpu_count).toBeGreaterThan(0);
    expect(host.mem_total_bytes).toBeGreaterThan(0);
    expect(host.users.map((u: any) => u.user)).toEqual(expect.arrayContaining(['alice', 'root', 'system']));
    gpu01('bash', '-c', 'pkill -u alice || true');
  });

  await test.step('collect facts and existing accounts', async () => {
    const { job_id } = await api(admin, 'POST', '/api/admin/hosts/gpu01/collect');
    const job = await waitForJob(admin, job_id);
    expect(job.status, job.output ?? '').toBe('ok');
    const host = await api(admin, 'GET', '/api/hosts/gpu01');
    expect(host.os).toContain('20.04');
    const accounts: any[] = host.accounts;
    expect(accounts.find((a) => a.username === 'alice')).toMatchObject({ uid: 1001, exists: true, managed: false });
    expect(accounts.find((a) => a.username === 'bob')).toMatchObject({ uid: 1002, exists: true, managed: false });
  });

  await test.step('carol logs in and registers (needs only, no hosts)', async () => {
    await login(await carolCtx.newPage(), 'carol');
    expectedEnd = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
    const reg = await api(carol, 'POST', '/api/register',
      { name: 'Carol', username: 'carol', purpose: 'e2e test', gpus: 1, min_vram_gb: null, until: expectedEnd });
    expect(reg).toMatchObject({ kind: 'account', username: 'carol', hosts: [], status: 'pending' });
    expect((await api(carol, 'GET', '/api/register')).can_register).toBe(false);
  });

  await test.step('admin creates the account and assigns gpu01: one scoped job, applied without a preview', async () => {
    const requests: any[] = await api(admin, 'GET', '/api/admin/requests');
    const req = requests.find((r) => r.username === 'carol' && r.status === 'pending');
    expect(req, 'pending registration from carol').toBeTruthy();
    const assigned = await api(admin, 'POST', `/api/admin/requests/${req.id}/assign`, { username: 'carol', hosts: ['gpu01'] });
    personId = assigned.person_id;
    expect(assigned.jobs.map((j: any) => j.host)).toEqual(['gpu01']);
    const job = await waitForJob(admin, assigned.jobs[0].job_id);
    expect(job.status, job.output ?? '').toBe('ok');
    expect(job.check_output).toBeNull(); // never previewed
  });

  await test.step('carol exists on gpu01 (uid 20000) and must change her password', async () => {
    expect(gpu01('getent', 'passwd', 'carol').split(':')[2]).toBe('20000');
    const chage = gpu01('chage', '-l', 'carol');
    expect(chage).toContain('password must be changed');
    // the registration's 預計使用到 is only shown to the admin: an assignment sets no expiry
    expect(chage).toMatch(/Account expires\s*:\s*never/);
    const people: any[] = await api(admin, 'GET', '/api/admin/people');
    expect(people.find((p) => p.username === 'carol')).toMatchObject({ expires_at: null });
    const reqs: any[] = await api(admin, 'GET', '/api/admin/requests');
    expect(reqs.find((r) => r.username === 'carol')).toMatchObject({ until: expectedEnd });
  });

  await test.step('carol sees her temporary password until she acknowledges it', async () => {
    const first = await api(carol, 'GET', '/api/me');
    expect(first.temp_password).toEqual(expect.stringMatching(/.+/)); // the job succeeded: shown
    expect(first.account_setup).toBeNull();
    expect(first.accounts.find((a: any) => a.host === 'gpu01')).toMatchObject({ address: 'gpu01', job_status: 'ok' });
    expect((await api(carol, 'GET', '/api/me')).temp_password).toBe(first.temp_password); // GET never consumes it
    expect((await carol.fetch('/api/me', { method: 'HEAD' })).status()).toBe(405);
    await api(carol, 'POST', '/api/me/temp-password/ack');
    expect((await api(carol, 'GET', '/api/me')).temp_password).toBeNull();
  });

  await test.step('revoking the gpu01 grant locks carol there', async () => {
    const { errors } = await api(admin, 'PUT', `/api/admin/people/${personId}/grants`, { hosts: [] });
    expect(errors).toEqual([]);
    const { job_id } = await api(admin, 'POST', `/api/admin/people/${personId}/sync`);
    expect(job_id, 'sync queued a job').toBeTruthy();
    const preview = await waitForJob(admin, job_id, { status: ['awaiting', 'failed'] });
    expect(preview.status, preview.output ?? '').toBe('awaiting');
    await api(admin, 'POST', `/api/admin/jobs/${job_id}/confirm`);
    const job = await waitForJob(admin, job_id);
    expect(job.status, job.output ?? '').toBe('ok');
    expect(gpu01('chage', '-l', 'carol')).toMatch(/Account expires\s*:\s*Jan 02, 1970/);
  });

  await test.step('host metrics have a CPU series', async () => {
    await expect
      .poll(async () => (await api(admin, 'GET', '/api/metrics/hosts/gpu01?range=1h')).cpu_pct?.length ?? 0,
        { timeout: 2 * 60_000, intervals: [5_000] })
      .toBeGreaterThan(0);
  });

  await test.step('history chart endpoints return aligned series for gpu01', async () => {
    const len = (g: { start: number; end: number; step: number }) => (g.end - g.start) / g.step + 1;
    const fleet = await api(admin, 'GET', '/api/metrics/fleet?range=1h');
    expect(fleet).toMatchObject({ range: '1h', step: 15 });
    expect(fleet.gpus_busy).toHaveLength(len(fleet));
    expect(fleet.gpus_idle).toHaveLength(len(fleet));
    const group = fleet.groups.find((g: any) => g.group === 'gpu');
    expect(group).toMatchObject({ hosts_total: 1, hosts_up: 1 });
    expect(group.cpu_pct).toHaveLength(len(fleet));
    expect(group.cpu_pct.some((v: number | null) => v !== null)).toBe(true);
    expect(group.gpu_util.every((v: number | null) => v === null)).toBe(true); // no nvidia-smi on the fake host

    const hosts = await api(admin, 'GET', '/api/metrics/history/hosts?range=1h');
    expect(hosts.step).toBe(60);
    expect(hosts.hosts.gpu01.cpu_pct).toHaveLength(len(hosts));
    expect(hosts.hosts.gpu01.gpu_util).toBeNull();
    expect(await api(admin, 'GET', '/api/metrics/history/gpus')).toMatchObject({ range: '1h', step: 60, hosts: {} });

    const fs = await api(admin, 'GET', '/api/metrics/disk/filesystems');
    expect(fs.hosts).toEqual([{ host: 'gpu01', group: 'gpu', filesystems: expect.any(Array) }]);
    const trend = await api(admin, 'GET', '/api/metrics/disk/trend?days=7');
    expect(trend).toMatchObject({ days: 7, step: 86400, owners: expect.any(Array) });
    for (const o of trend.owners) expect(o.bytes).toHaveLength(8);
    expect((await admin.get('/api/metrics/fleet?range=2h')).status()).toBe(400);
  });

  await test.step('GPU board lists gpu01 without a working nvidia-smi', async () => {
    await expect
      .poll(async () => {
        const { hosts }: { hosts: any[] } = await api(admin, 'GET', '/api/metrics/gpus');
        return hosts.find((h) => h.host === 'gpu01') ?? null;
      }, { timeout: 2 * 60_000, intervals: [5_000] })
      .toMatchObject({ nvidia_ok: false, gpus: [] });
  });

  await test.step('a host that was never bootstrapped: 預檢失敗 (not awaiting), a plain failure summary, re-run', async () => {
    // an address that never resolves: nothing is ever contacted
    await api(admin, 'POST', '/api/admin/hosts', { name: 'gpu99', address: 'gpu99.invalid', group: 'gpu' });
    const picker = await api(admin, 'GET', '/api/admin/assign-hosts');
    expect(picker.hosts.find((h: any) => h.name === 'gpu99').blocked).toBe('尚未收集到資料（可能還沒 bootstrap）');
    const people: any[] = await api(admin, 'GET', '/api/admin/people');
    const tester = people.find((p) => p.username === 'tester');
    // the API still allows it (the UI does not): the scoped job fails with a summary in words
    const { jobs } = await api(admin, 'POST', `/api/admin/people/${tester.id}/assign`, { hosts: ['gpu99'] });
    const failed = await waitForJob(admin, jobs[0].job_id);
    expect(failed.status).toBe('failed');
    const detail = await api(admin, 'GET', `/api/admin/jobs/${failed.id}`);
    expect(detail).toMatchObject({ summary: '指派 tester @gpu99', scoped: true, failure: 'gpu99：主機尚未 bootstrap 或無法連線' });
    const sink = async () => (await (await admin.get('http://localhost:9999/_sink')).json()).webhooks.map((w: any) => w.body?.content ?? '');
    await expect.poll(async () => (await sink()).some((c: string) => c.startsWith(`[失敗] 指派 tester @gpu99（#${failed.id}）：gpu99：主機尚未 bootstrap`)),
      { timeout: 30_000 }).toBe(true);
    // re-run: the same assignment again, checked again
    const again = await api(admin, 'POST', `/api/admin/jobs/${failed.id}/rerun`);
    expect(again).toMatchObject({ summary: '指派 tester @gpu99', status: 'queued' });
    expect((await waitForJob(admin, again.id)).status).toBe('failed');

    // a previewed sync that can't reach gpu99 produces no preview: 預檢失敗, nothing to confirm
    const { job_id } = await api(admin, 'POST', `/api/admin/people/${tester.id}/sync`);
    const preview = await waitForJob(admin, job_id, { status: ['awaiting', 'check_failed', 'failed'] });
    expect(preview.status, preview.check_output ?? '').toBe('check_failed');
    const pd = await api(admin, 'GET', `/api/admin/jobs/${job_id}`);
    expect(pd.failure).toMatch(/^預檢無法連線到 gpu99，未產生預覽，請修正後重新排程/);
    expect((await admin.post(`/api/admin/jobs/${job_id}/confirm`, { headers: { Origin: BASE_URL, 'X-CSRF-Token': (await api(admin, 'GET', '/api/session')).csrf } })).status()).toBe(409);
    await expect.poll(async () => (await sink()).some((c: string) => c.startsWith(`[預檢失敗] 帳號同步 tester @gpu99（#${job_id}）：預檢無法連線到 gpu99`)),
      { timeout: 30_000 }).toBe(true);
    expect((await sink()).some((c: string) => c.includes(`#${job_id}）預覽完成`))).toBe(false); // never [待確認]

    // the job page says so in words, without a confirm button
    const page = await adminCtx.newPage();
    await page.goto(`/admin/jobs/${job_id}`);
    await expect(page.getByTestId('job-status')).toHaveText('預檢失敗');
    await expect(page.getByTestId('job-failure')).toContainText('預檢無法連線到 gpu99，未產生預覽，請修正後重新排程');
    await expect(page.getByRole('button', { name: '確認執行' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '重新執行' })).toBeVisible();
    await page.close();

    // clean up: lock tester there, then the never-created account no longer blocks deleting the host
    expect((await api(admin, 'PUT', `/api/admin/people/${tester.id}/grants`, { hosts: [] })).errors).toEqual([]);
    await api(admin, 'DELETE', '/api/admin/hosts/gpu99', { confirm: 'gpu99' });
  });

  await test.step('state-changing request without CSRF token is rejected', async () => {
    const r = await admin.post('/api/admin/hosts/gpu01/collect', { headers: { Origin: BASE_URL } });
    expect(r.status()).toBe(403);
  });

  await adminCtx.close();
  await carolCtx.close();
});
