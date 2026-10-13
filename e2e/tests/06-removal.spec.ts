import { expect, test, type Page } from '@playwright/test';
import { api, dc, login, waitForJob } from './helpers';

// The three removal flows (docs/admin-guide.md 退回或移除、畢業生). After 01–05: dave is a member with an account on
// gpu01 (his ~/.ssh/authorized_keys is a symlink to /etc/shadow since 03, Discord linked since 04), carol is active
// on gpu01. Run in order.
test.describe.configure({ mode: 'serial' });

const gpu01 = (...cmd: string[]) => dc('exec', '-T', 'gpu01', ...cmd);
const sink = async (request: any) => (await (await request.get('http://localhost:9999/_sink')).json());

/** On a job page: wait for the preview, then 確認執行 and wait for the result. */
async function confirmPreview(page: Page, jobId: number) {
  const preview = await waitForJob(page.request, jobId, { status: ['awaiting', 'failed', 'check_failed'] });
  expect(preview.status, preview.check_output ?? preview.output ?? '').toBe('awaiting');
  await page.goto(`/admin/jobs/${jobId}`);
  await page.getByRole('button', { name: '確認執行' }).click();
  await page.locator('[role=alertdialog],[role=dialog]').getByRole('button', { name: '確認執行' }).click();
  const job = await waitForJob(page.request, jobId);
  expect(job.status, job.output ?? '').toBe('ok');
  return preview;
}

test('移除登記: a stranger’s registration disappears silently; they may register again', async ({ browser }) => {
  const stranger = await (await browser.newContext()).newPage();
  await login(stranger, 'stranger');
  const reg = { name: '路人', username: 'stranger', purpose: '不知道是誰', gpus: 1, min_vram_gb: null, until: '2099-01-01' };
  await api(stranger.request, 'POST', '/api/register', reg);

  const admin = await (await browser.newContext()).newPage();
  await login(admin, 'tester');
  await admin.goto('/admin/requests');
  const card = admin.getByRole('listitem').filter({ hasText: '不知道是誰' });
  await card.getByRole('button', { name: '移除' }).click();
  const dialog = admin.getByRole('alertdialog');
  await expect(dialog).toContainText('不會通知對方');
  await dialog.getByRole('button', { name: '移除' }).click();
  await expect(admin.getByText('已移除 路人 的登記（未通知對方）').first()).toBeVisible();
  await expect(card).toHaveCount(0);
  const audit = await api(admin.request, 'GET', '/api/admin/audit');
  expect(audit.rows[0]).toMatchObject({ actor: 'tester', action: 'request_delete', target: 'stranger' });

  // nothing reaches them (退回 would have mailed stranger@example.edu)
  await admin.waitForTimeout(6_000);
  expect((await sink(admin.request)).mails.filter((m: any) => m.to.includes('stranger@example.edu'))).toEqual([]);
  expect(await api(stranger.request, 'GET', '/api/register')).toEqual({ registration: null, can_register: true });
  await api(stranger.request, 'POST', '/api/register', reg); // may register again
});

test('移除成員: dave is offboarded, gpu01 deleted with his home after preview + confirm', async ({ browser }) => {
  const dave = await (await browser.newContext()).newPage();
  await login(dave, 'dave');
  expect((await api(dave.request, 'GET', '/api/session')).user).toMatchObject({ username: 'dave', status: 'active' });
  expect(gpu01('getent', 'passwd', 'dave')).toMatch(/^dave:/);

  const admin = await (await browser.newContext()).newPage();
  await login(admin, 'tester');
  const people: any[] = await api(admin.request, 'GET', '/api/admin/people');
  const daveId = people.find((p) => p.username === 'dave').id;
  await admin.goto(`/admin/people/${daveId}`);
  await admin.getByTestId('remove-person').click();
  const dialog = admin.getByRole('dialog');
  const row = dialog.getByTestId('remove-host-gpu01');
  await expect(row.getByRole('radio', { name: '鎖定' })).toHaveAttribute('aria-checked', 'true'); // lock is the default
  await row.getByRole('radio', { name: '刪除' }).click();
  await row.getByText('同時刪除家目錄').click();
  const submit = dialog.getByRole('button', { name: /移除成員/ });
  await expect(submit).toBeDisabled(); // the username must be typed
  await row.getByLabel(/請輸入/).fill('dave');
  await submit.click();
  await expect(admin.getByText(/已移除 dave，建立 1 個預覽工作/).first()).toBeVisible();
  await expect(admin.getByTestId('removed-banner')).toBeVisible();

  const audit = await api(admin.request, 'GET', '/api/admin/audit');
  const removal = audit.rows.find((r: any) => r.action === 'person_remove');
  expect(removal).toMatchObject({ target: 'dave', detail: { hosts: { gpu01: 'delete_home' }, sso_id: 'dave' } });
  await expect
    .poll(async () => (await sink(admin.request)).webhooks.some((w: any) => w.body?.content?.startsWith('[移除成員] tester 移除了 dave')))
    .toBe(true);
  // no longer a member: his session and a new login both land as a bare identity
  expect((await api(dave.request, 'GET', '/api/session')).user).toBeNull();
  expect((await dave.request.get('/api/me')).status()).toBe(403);
  // the preview changed nothing; confirming deletes the account and its home
  const jobId = removal.detail.jobs[0];
  const preview = await confirmPreview(admin, jobId);
  expect(preview.check_output).toMatch(/Remove accounts/);
  expect(() => gpu01('getent', 'passwd', 'dave')).toThrow();
  expect(gpu01('bash', '-c', 'test -e /home/dave && echo yes || echo no').trim()).toBe('no');
  expect(() => gpu01('test', '-s', '/etc/shadow')).not.toThrow(); // the symlink's target is untouched
  expect(gpu01('getent', 'passwd', 'carol')).toMatch(/^carol:/); // nobody else touched

  // history kept: 人員 → 已移除
  await admin.goto('/admin/people');
  await admin.getByRole('tab', { name: /已移除/ }).click();
  await expect(admin.getByRole('link', { name: 'dave', exact: true })).toBeVisible();
});

test('移除某台主機的帳號: carol is locked on gpu01 from the host page (previewed)', async ({ page }) => {
  await login(page, 'tester');
  expect(gpu01('chage', '-l', 'carol')).not.toMatch(/Account expires\s*:\s*Jan 02, 1970/);
  await page.goto('/hosts/gpu01?tab=users');
  await page.locator('#accounts').getByRole('button', { name: '移除 carol' }).click();
  await page.getByRole('menuitem', { name: /^鎖定/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: '鎖定帳號' }).click();
  await page.getByRole('button', { name: '查看' }).click();
  await expect(page).toHaveURL(/\/admin\/jobs\/\d+$/);
  const jobId = Number(page.url().split('/').pop());
  const job = await api(page.request, 'GET', `/api/admin/jobs/${jobId}`);
  expect(job).toMatchObject({ summary: '鎖定 carol @gpu01', auto_confirm: false });
  expect(gpu01('chage', '-l', 'carol')).not.toMatch(/Account expires\s*:\s*Jan 02, 1970/); // the preview changed nothing
  await confirmPreview(page, jobId);
  expect(gpu01('chage', '-l', 'carol')).toMatch(/Account expires\s*:\s*Jan 02, 1970/);
  expect(gpu01('getent', 'passwd', 'carol')).toMatch(/^carol:/); // locked, not deleted
  // reserved accounts (admin = RESERVED_USERS here) and the bot never get the menu
  await page.goto('/hosts/gpu01?tab=users');
  await expect(page.locator('#accounts').getByRole('button', { name: '移除 admin' })).toHaveCount(0);
  await expect(page.locator('#accounts').getByRole('button', { name: '移除 labbot' })).toHaveCount(0);
});
