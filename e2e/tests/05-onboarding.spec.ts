import { expect, test } from '@playwright/test';
import { api, BASE_URL, csrf, dc, login, waitForJob } from './helpers';

// After 01–04: alice was adopted from gpu01 (a person without an SSO ID), carol's gpu01 account was revoked
// (locked there), dave is an active member on gpu01, bob is an unmanaged account on gpu01. Run in order.
test.describe.configure({ mode: 'serial' });

const gpu01 = (...cmd: string[]) => dc('exec', '-T', 'gpu01', ...cmd);
const sink = async (request: any) => (await (await request.get('http://localhost:9999/_sink')).json());

test('an adopted member registers; the admin links her existing account (no self-claiming)', async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  await login(alice, 'alice');
  expect((await api(alice.request, 'GET', '/api/session')).user).toBeNull();
  // self-binding no longer exists
  const bind = await alice.request.post('/api/me/bind', {
    headers: { Origin: BASE_URL, 'X-CSRF-Token': await csrf(alice.request) }, data: { username: 'alice' },
  });
  expect(bind.status()).toBe(404);
  await api(alice.request, 'POST', '/api/register',
    { name: 'Alice', username: 'alice', purpose: '舊成員，主機上已有 alice', gpus: 0, min_vram_gb: null, until: '2099-01-01' });
  await expect
    .poll(async () => (await sink(alice.request)).webhooks.some((w: any) => w.body?.content?.startsWith('[帳號登記] Alice（alice')))
    .toBe(true);

  const admin = await (await browser.newContext()).newPage();
  await login(admin, 'tester');
  await admin.goto('/admin/requests');
  const card = admin.getByRole('listitem').filter({ hasText: '新成員登記' }).filter({ hasText: '舊成員' });
  await card.getByRole('button', { name: /指派/ }).click();
  await card.getByText('連結既有帳號').click();
  await card.getByLabel('搜尋要連結的人員').first().fill('alice');
  await card.getByRole('option', { name: /alice/ }).click();
  await card.getByRole('button', { name: '連結帳號' }).click();
  await expect(admin.getByText('已連結帳號').first()).toBeVisible();

  await alice.reload();
  const me = await api(alice.request, 'GET', '/api/me');
  expect(me.person).toMatchObject({ username: 'alice', sso_id: 'alice', email: 'alice@example.edu', name: 'Alice' });
  expect(me.accounts.find((a: any) => a.host === 'gpu01')).toMatchObject({ uid: 1001, exists: true }); // UID untouched
});

test('primary users: the admin stars alice on gpu01, members see her on the host pages', async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  await login(admin, 'tester');
  await admin.goto('/hosts/gpu01?tab=users');
  await admin.locator('#accounts').getByRole('button', { name: '將 alice 設為主要使用者' }).click();
  await expect(admin.getByTestId('primary-users')).toContainText('alice');
  const dave = await (await browser.newContext()).newPage();
  await login(dave, 'dave');
  const hosts: any[] = await api(dave.request, 'GET', '/api/hosts');
  expect(hosts.find((h) => h.name === 'gpu01').primary_users).toEqual([{ username: 'alice', name: 'Alice' }]);
  await dave.goto('/hosts/gpu01?tab=users');
  await expect(dave.getByTestId('primary-users')).toContainText('alice');
  await dave.goto('/hosts');
  await expect(dave.getByTestId('host-row-gpu01')).toContainText('alice');
});

test('carol asks for more hosts (needs only); assigning gpu01 applies only her account, without a preview', async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  await login(admin, 'tester');
  const people: any[] = await api(admin.request, 'GET', '/api/admin/people');
  const aliceId = people.find((p) => p.username === 'alice').id;
  // pending drift on gpu01 that nobody previewed: alice is to be locked there. The scoped job must not apply it.
  expect((await api(admin.request, 'PUT', `/api/admin/people/${aliceId}/grants`, { hosts: [] })).errors).toEqual([]);

  const carol = await (await browser.newContext()).newPage();
  await login(carol, 'carol');
  await carol.goto('/me');
  const form = carol.getByRole('form', { name: '申請使用其他主機' });
  await form.getByLabel('用途').fill('e2e: back on gpu01');
  await form.getByLabel('GPU 張數').fill('1');
  await form.getByLabel('預計使用到').fill('2099-01-01');
  await form.getByRole('button', { name: '送出申請' }).click();
  await expect(carol.getByTestId('host-request-pending')).toBeVisible();

  await admin.goto('/admin/requests');
  const item = admin.getByRole('listitem').filter({ hasText: '既有成員申請主機' }).filter({ hasText: 'carol' });
  await item.getByRole('button', { name: /指派/ }).click();
  await item.getByTestId('assign-host-gpu01').getByRole('checkbox').check();
  await item.getByRole('button', { name: '指派主機' }).click();
  await expect(admin.getByText(/已指派 gpu01/).first()).toBeVisible();
  const reqs: any[] = await api(admin.request, 'GET', '/api/admin/requests');
  const req = reqs.find((r) => r.kind === 'hosts' && r.username === 'carol');
  const job = await waitForJob(admin.request, req.jobs[0].job_id);
  expect(job.status, job.output ?? '').toBe('ok');
  expect(job.check_output).toBeNull(); // never previewed
  const detail = await api(admin.request, 'GET', `/api/admin/jobs/${job.id}`);
  expect(detail.args).toMatchObject({ target_hosts: 'gpu01', only_user: 'carol' });
  expect(Object.values(detail.args.accounts).flat().map((e: any) => e.username)).toEqual(['carol']);

  expect(gpu01('chage', '-l', 'carol')).not.toMatch(/Account expires\s*:\s*Jan 02, 1970/); // unlocked
  expect(gpu01('chage', '-l', 'alice')).not.toMatch(/Account expires\s*:\s*Jan 02, 1970/); // drift left alone
  // assignments send no email (the admin tells the member); the runner's sender would have delivered one by now
  await admin.waitForTimeout(6_000);
  expect((await sink(admin.request)).mails.filter((m: any) => m.to.includes('carol@example.edu') && m.subject.includes('指派'))).toEqual([]);
  // restore alice's grant (nothing changed on the host)
  expect((await api(admin.request, 'PUT', `/api/admin/people/${aliceId}/grants`, { hosts: ['gpu01'] })).errors).toEqual([]);
});

test('an old unassigned account is deleted with its home: previewed, then applied', async ({ page }) => {
  await login(page, 'tester');
  expect(gpu01('getent', 'passwd', 'bob')).toMatch(/^bob:x:1002:/);
  await page.goto('/hosts/gpu01#accounts'); // a link from before the host tabs: opens 使用者
  await page.locator('#accounts').getByRole('button', { name: '移除 bob' }).click();
  await page.getByRole('menuitem', { name: /^刪除/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('同時刪除家目錄').click();
  const confirm = dialog.getByRole('button', { name: '刪除帳號與家目錄' });
  await expect(confirm).toBeDisabled(); // the username must be typed
  await dialog.getByLabel(/請輸入/).fill('bob');
  await confirm.click();
  await page.getByRole('button', { name: '查看' }).click();
  await expect(page).toHaveURL(/\/admin\/jobs\/\d+$/);
  const jobId = Number(page.url().split('/').pop());
  const preview = await waitForJob(page.request, jobId, { status: ['awaiting', 'failed'] });
  expect(preview.status, preview.check_output ?? preview.output ?? '').toBe('awaiting');
  expect(preview.check_output).toMatch(/Remove accounts/);
  expect(gpu01('getent', 'passwd', 'bob')).toMatch(/^bob:/); // the preview changed nothing
  await page.reload();
  await page.getByRole('button', { name: '確認執行' }).click();
  await page.locator('[role=alertdialog],[role=dialog]').getByRole('button', { name: '確認執行' }).click();
  const job = await waitForJob(page.request, jobId);
  expect(job.status, job.output ?? '').toBe('ok');
  expect(() => gpu01('getent', 'passwd', 'bob')).toThrow(); // gone
  expect(gpu01('bash', '-c', 'test -e /home/bob && echo yes || echo no').trim()).toBe('no');
  expect(gpu01('getent', 'passwd', 'alice')).toMatch(/^alice:x:1001:/); // nobody else touched
});

test('an admin promotes dave straight from the people list; demotion only through the server CLI', async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  await login(admin, 'tester');
  const people: any[] = await api(admin.request, 'GET', '/api/admin/people');
  const dave = people.find((p) => p.username === 'dave');
  const tester = people.find((p) => p.username === 'tester');
  expect(dave.role).toBe('member');
  await admin.goto('/admin/people');
  const row = admin.getByRole('row').filter({ has: admin.getByRole('link', { name: 'dave', exact: true }) });
  await row.getByTestId('promote').click();
  const dialog = admin.getByRole('alertdialog');
  await expect(dialog).toContainText('將 Dave（dave）設為管理員？'); // names the person
  await expect(dialog).toContainText('labdeck demote-admin');
  await dialog.getByRole('button', { name: '設為管理員' }).click();
  await expect(admin.getByText('已將 Dave 設為管理員').first()).toBeVisible();
  await expect(row.getByTestId('promote')).toHaveCount(0); // already an admin: no button, and no demote button either
  await expect(row).toContainText('管理員');
  const audit = await api(admin.request, 'GET', '/api/admin/audit');
  expect(audit.rows[0]).toMatchObject({ actor: 'tester', action: 'person_promote', target: 'dave' });
  await expect
    .poll(async () => (await sink(admin.request)).webhooks.some((w: any) => w.body?.content === '[管理員] tester 將 dave（Dave）設為管理員'),
      { timeout: 30_000, intervals: [1_000] })
    .toBe(true);

  // the web can't take it back: neither the promoter nor the new admin can demote anyone
  const put = async (page: typeof admin, id: number) =>
    page.request.put(`/api/admin/people/${id}`, {
      headers: { Origin: BASE_URL, 'X-CSRF-Token': await csrf(page.request) }, data: { role: 'member', status: 'active' },
    });
  expect((await put(admin, dave.id)).status()).toBe(403);
  const davePage = await (await browser.newContext()).newPage();
  await login(davePage, 'dave');
  expect((await api(davePage.request, 'GET', '/api/session')).user.role).toBe('admin');
  expect((await put(davePage, tester.id)).status()).toBe(403);

  // the server CLI is the emergency way out
  expect(dc('exec', '-T', 'web', 'labdeck', 'demote-admin', 'dave')).toContain('dave is no longer an admin');
  expect((await api(davePage.request, 'GET', '/api/session')).user.role).toBe('member');
  const denied = await davePage.request.get('/api/admin/people');
  expect(denied.status()).toBe(403);
});
