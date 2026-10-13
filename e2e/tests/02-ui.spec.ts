import { expect, test, type Page } from '@playwright/test';
import { api, BASE_URL, csrf, dc, login, waitForJob } from './helpers';

// Browser-driven checks on top of the state 01-api-flow leaves behind (gpu01 monitored + collected,
// alice/bob unmanaged until alice is bulk-adopted below, carol created then locked). Tests depend on each other: run in order.
test.describe.configure({ mode: 'serial' });

/** Record uncaught page errors so a crashed render can't hide behind a heading that was already visible. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
  return errors;
}

/** Navigate, let the data load, then require: a page heading, no error boundary, no metrics outage. */
async function pageOk(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('main h1').first(), path).toBeVisible();
  await expect(page.getByText('頁面發生錯誤'), path).toHaveCount(0);
  await expect(page.getByText('監控資料暫時無法取得'), path).toHaveCount(0);
}

test('anonymous visitor sees the SSO login button', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('login')).toContainText('MockSSO');
});

test('admin opens a host and its charts', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page, 'tester');
  await pageOk(page, '/');
  await expect(page.getByTestId('fleet-group-gpu')).toContainText('在線 1 / 1'); // home: per-group sparklines
  await pageOk(page, '/hosts');
  const row = page.getByTestId('host-row-gpu01');
  await expect(row).toBeVisible();
  await row.getByRole('link', { name: 'gpu01' }).first().click();
  await expect(page).toHaveURL(/\/hosts\/gpu01$/);
  await expect(page.getByText(/Ubuntu 20\.04/).first()).toBeVisible();
  await expect(page.locator('.recharts-surface').first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: '1 小時' }).click();
  await expect(page.locator('.recharts-surface').first()).toBeVisible();
  // the host's tabs are links: 概況 / GPU / 使用者 / 磁碟
  const tabs = page.getByRole('navigation', { name: 'gpu01 分頁' });
  await expect(tabs.getByRole('link', { name: '概況' })).toHaveAttribute('aria-current', 'page');
  await tabs.getByRole('link', { name: '磁碟' }).click();
  await expect(page).toHaveURL(/\/hosts\/gpu01\?tab=disk$/);
  await expect(page.getByRole('heading', { name: '掛載點', exact: true })).toBeVisible();
  await tabs.getByRole('link', { name: '使用者' }).click();
  await expect(page.locator('#accounts')).toBeVisible();
  await page.reload(); // linkable: the tab survives a reload
  await expect(page.locator('#accounts')).toBeVisible();
  await expect(page.getByText(/IPMI|BMC/)).toHaveCount(0); // remote power control is gone
  expect(errors).toEqual([]);
});

test('the sidebar has the grouped navigation', async ({ page }) => {
  await login(page, 'tester');
  await pageOk(page, '/');
  const sidebar = page.locator('[data-sidebar="sidebar"]').first();
  const links = await sidebar.getByRole('link').allInnerTexts();
  expect(links.map((t) => t.trim()).filter(Boolean)).toEqual(['E2E Lab', '首頁', '主機', '使用量', '公告與維護', '我的帳號',
    '待指派', '人員與帳號', '主機管理', '維運']);
  await sidebar.getByRole('link', { name: '使用量' }).click();
  await expect(page).toHaveURL(/\/usage\?tab=gpu$/);
  await expect(page.locator('main h1')).toHaveText('使用量');
  await page.getByRole('navigation', { name: '使用量分頁' }).getByRole('link', { name: '月報' }).click();
  await expect(page).toHaveURL(/\/usage\?tab=monthly$/);
  await expect(sidebar.getByRole('link', { name: '使用量' })).toHaveAttribute('data-active', 'true');
  await expect(page).toHaveTitle('月報 · 使用量 · E2E Lab');
});

test('unmanaged accounts are listed for adoption', async ({ page }) => {
  await login(page, 'tester');
  await pageOk(page, '/admin/people?tab=accounts');
  await page.getByRole('tab', { name: /未認領/ }).click();
  await expect(page.getByText('alice').first()).toBeVisible();
  await expect(page.getByText('bob').first()).toBeVisible();
});

test('same-name, same-uid accounts are suggested and alice is adopted in bulk', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page, 'tester');
  await pageOk(page, '/admin/people?tab=accounts');
  await page.getByRole('tab', { name: /建議認領/ }).click();
  await expect(page.getByTestId('adopt-group-alice')).toContainText('1001');
  await expect(page.getByTestId('adopt-group-alice')).toContainText('gpu01');
  await expect(page.getByTestId('adopt-group-bob')).toContainText('1002');
  await expect(page.getByTestId('adopt-group-admin')).toHaveCount(0); // RESERVED_USERS
  await page.getByRole('checkbox', { name: '選取 alice' }).check();
  await expect(page.getByTestId('adopt-selection')).toContainText('已選 1 位、1 個主機帳號');
  await page.getByRole('button', { name: '認領所選' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '認領 1 個帳號' }).click();
  await expect(page.getByText('已認領 1 個主機帳號（1 位人員）').first()).toBeVisible();
  await expect(page.getByTestId('adopt-group-alice')).toHaveCount(0);
  await expect(page.getByTestId('adopt-group-bob')).toBeVisible();

  const host = await api(page.request, 'GET', '/api/hosts/gpu01');
  const alice = host.accounts.find((a: any) => a.username === 'alice');
  expect(alice).toMatchObject({ uid: 1001, managed: true, desired: 'present', person: { username: 'alice' } });
  const people: any[] = await api(page.request, 'GET', '/api/admin/people');
  expect(people.filter((p) => p.username === 'alice')).toMatchObject([{ uid: 1001 }]);
  expect(errors).toEqual([]);
});

test('host health lists gpu01 with its checks', async ({ page }) => {
  await login(page, 'tester');
  await pageOk(page, '/admin/hosts?tab=health');
  const row = page.getByTestId('health-row-gpu01');
  await expect(row.getByTestId('health-reachable')).toHaveAttribute('data-status', 'ok');
  await expect(row.getByTestId('health-os_eol')).toHaveAttribute('data-status', 'warn'); // the fake host is Ubuntu 20.04
  await expect(row.getByTestId('health-gpu_missing')).toHaveAttribute('data-status', 'bad'); // lspci card, no nvidia-smi
  const board = await api(page.request, 'GET', '/api/admin/health');
  const checks = board.hosts.find((h: any) => h.host === 'gpu01').checks;
  expect(checks.map((c: any) => c.key)).toEqual(['reachable', 'collect_age', 'apt', 'reboot_required', 'disk_root', 'disk_any',
    'smart', 'gpu_missing', 'driver_drift', 'os_eol']);
  await pageOk(page, '/hosts/gpu01');
  await expect(page.locator('#health').getByTestId('health-os_eol')).toHaveAttribute('data-status', 'warn');
  await pageOk(page, '/hosts'); // admins see the worst check in the host list
  await expect(page.getByTestId('host-health-gpu01')).toHaveAttribute('data-status', 'bad');
});

test('a newcomer registers; the admin creates the account and assigns gpu01 in the UI, no preview', async ({ browser }) => {
  const daveCtx = await browser.newContext();
  const dave = await daveCtx.newPage();
  await login(dave, 'dave');
  await dave.goto('/request');
  const form = dave.getByTestId('register-form');
  await form.getByLabel('姓名').fill('Dave');
  await form.getByLabel('希望的帳號名稱').fill('dave');
  await form.getByLabel('用途').fill('e2e UI test');
  await form.getByLabel('GPU 張數').fill('1');
  await form.getByLabel('預計使用到').fill(new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10));
  await form.getByRole('button', { name: '送出登記' }).click();
  await expect(dave.getByTestId('registration-waiting')).toBeVisible();
  await expect(dave.getByTestId('registration-waiting')).toContainText('e2e UI test');
  // home and member-only pages say the registration was received, not 「先登記需求」
  await dave.goto('/');
  await expect(dave.getByTestId('registration-status')).toHaveAttribute('data-state', 'pending');
  await expect(dave.getByTestId('registration-status')).toContainText(/已收到你的登記（\d{4}-\d{2}-\d{2} 送出），等待助教指派/);
  await expect(dave.getByText('先登記需求')).toHaveCount(0);
  await dave.goto('/me');
  await expect(dave.getByTestId('registration-status')).toContainText('等待助教指派');

  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await login(admin, 'tester');
  await admin.goto('/admin/requests');
  const card = admin.getByRole('listitem').filter({ hasText: '新成員登記' }).filter({ hasText: 'Dave' });
  await card.getByRole('button', { name: /指派/ }).click();
  const panel = card.locator('[data-testid^="assign-panel-"]');
  await expect(panel.getByLabel('帳號名稱', { exact: true })).toHaveValue('dave');
  await panel.getByTestId('assign-host-gpu01').getByRole('checkbox').check();
  await panel.getByRole('button', { name: '建立帳號並指派' }).click();
  await expect(admin.getByText(/已指派 gpu01/).first()).toBeVisible();

  const reqs: any[] = await api(admin.request, 'GET', '/api/admin/requests');
  const req = reqs.find((r) => r.username === 'dave' && r.kind === 'account');
  expect(req.status).toBe('approved');
  const job = await waitForJob(admin.request, req.jobs[0].job_id);
  expect(job.status, job.output ?? '').toBe('ok');
  expect(job.check_output).toBeNull(); // applied without a preview

  expect(dc('exec', '-T', 'gpu01', 'getent', 'passwd', 'dave')).toMatch(/^dave:x:2\d{4}:/); // a lab-wide UID (tester got one in 01 for gpu99)

  // home: a prominent banner while the temp password waits on 我的帳號
  await dave.goto('/');
  await expect(dave.getByTestId('home-temp-password')).toContainText('帳號已開通：請到我的帳號查看臨時密碼');
  await dave.getByTestId('home-temp-password').click();
  await expect(dave).toHaveURL(/\/me$/);
  const pw = dave.getByTestId('temp-password');
  await expect(pw).toBeVisible();
  const password = (await pw.textContent())?.trim() ?? '';
  expect(password.length).toBeGreaterThan(8);
  await expect(dave.getByTestId('temp-password-box')).toContainText('此臨時密碼適用於所有新建的主機帳號；改密碼後各主機各自獨立');
  // 連線: a copyable ssh command per host (the address is the account owner's to see)
  await expect(dave.getByTestId('ssh-gpu01')).toHaveText('ssh dave@gpu01');
  await expect(dave.getByText('~/.ssh/config').first()).toBeVisible();
  await dave.reload(); // still there after a reload…
  await expect(dave.getByTestId('temp-password')).toHaveText(password);
  await dave.getByRole('button', { name: '我已記下' }).click(); // …until acknowledged
  await expect(dave.getByTestId('temp-password')).toHaveCount(0);
  await dave.reload();
  await expect(dave.getByText('主機帳號').first()).toBeVisible();
  await expect(dave.getByTestId('temp-password')).toHaveCount(0);
  await dave.goto('/');
  await expect(dave.getByTestId('my-status')).toBeVisible();
  await expect(dave.getByTestId('home-temp-password')).toHaveCount(0);

  // `exists` comes from the collect the runner queues after the users job; it can lag on a busy machine.
  await expect
    .poll(async () => (await api(dave.request, 'GET', '/api/me')).accounts.find((a: any) => a.host === 'gpu01'),
      { timeout: 90_000, intervals: [3_000] })
    .toMatchObject({ username: 'dave', exists: true });
});

// Remote power control was removed: its page, endpoints and fields are gone; old bookmarks land somewhere sensible.
test('no remote power control; old URLs redirect into the new sections', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page, 'tester');
  const moved: [string, RegExp][] = [
    ['/gpus', /\/usage\?tab=gpu$/],
    ['/disk', /\/usage\?tab=disk$/],
    ['/reports/gpu-monthly?month=2026-08', /\/usage\?month=2026-08&tab=monthly$/],
    ['/calendar', /\/announcements\?tab=calendar$/],
    ['/health', /\/admin\/hosts\?tab=health$/],
    ['/admin/accounts?tab=drift', /\/admin\/people\?tab=accounts&view=drift$/],
    ['/admin/jobs', /\/admin\/ops\?tab=jobs$/],
    ['/admin/announcements?date=2026-10-05', /\/admin\/ops\?date=2026-10-05&tab=announcements$/],
    ['/admin/guide', /\/admin\/ops\?tab=guide$/],
    ['/admin/audit', /\/admin\/ops\?tab=audit$/],
    ['/admin/power', /\/admin\/hosts\?tab=hosts$/],
  ];
  for (const [from, to] of moved) {
    await pageOk(page, from);
    await expect(page, from).toHaveURL(to);
  }
  await expect(page.locator('#main')).not.toContainText('BMC'); // the host form has no IPMI fields
  const headers = { Origin: BASE_URL, 'X-CSRF-Token': await csrf(page.request) };
  for (const [method, url] of [['GET', '/api/admin/power'], ['POST', '/api/admin/power'], ['POST', '/api/admin/bmc-check'],
    ['POST', '/api/admin/hosts/gpu01/bmc-check']]) {
    expect((await page.request.fetch(url, { method, headers })).status(), url).toBe(404);
  }
  const plan = { title: 'e2e', body: 'e2e', starts_at: null, ends_at: null, shutdown: { hosts: ['gpu01'], at: new Date(Date.now() + 86_400_000).toISOString() } };
  const refused = await page.request.post('/api/admin/announcements', { headers, data: plan });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).error).toContain('已不支援排程關機');
  await pageOk(page, '/admin/ops?tab=announcements');
  await expect(page.getByText(/排程關機/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

// Every route renders real API data without crashing — catches front/back contract drift.
test('every page renders for an admin and a member', async ({ browser }) => {
  const adminPage = await (await browser.newContext()).newPage();
  const adminErrors = trackErrors(adminPage);
  await login(adminPage, 'tester');
  const people: any[] = await api(adminPage.request, 'GET', '/api/admin/people');
  const jobs: any[] = await api(adminPage.request, 'GET', '/api/admin/jobs');
  const member = ['/', '/hosts', '/hosts/gpu01', '/hosts/gpu01?tab=gpu', '/hosts/gpu01?tab=users', '/hosts/gpu01?tab=disk',
    '/usage?tab=gpu', '/usage?tab=cpu', '/usage?tab=disk', '/usage?tab=monthly', '/me', '/announcements', '/announcements?tab=calendar', '/guide'];
  const adminOnly = [
    '/admin/requests', '/admin/people', '/admin/people?tab=accounts', '/admin/people?tab=accounts&view=drift',
    '/admin/people?tab=accounts&view=uid', '/admin/people?tab=accounts&view=idle', '/admin/people?tab=accounts&view=unmanaged',
    '/admin/people?tab=accounts&view=suggest', `/admin/people/${people[0].id}`, '/admin/hosts', '/admin/hosts?tab=health',
    '/admin/ops', '/admin/ops?tab=announcements', '/admin/ops?tab=announcements&date=2026-10-05', '/admin/ops?tab=guide',
    '/admin/ops?tab=audit', `/admin/jobs/${jobs[0].id}`,
  ];
  for (const path of [...member, ...adminOnly]) await pageOk(adminPage, path);
  expect(adminErrors).toEqual([]);

  const davePage = await (await browser.newContext()).newPage();
  const daveErrors = trackErrors(davePage);
  await login(davePage, 'dave');
  for (const path of member) await pageOk(davePage, path);
  expect(daveErrors).toEqual([]);
});

test('admin edits the new-member guide and a member reads it; the calendar feed is subscribable', async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  const adminErrors = trackErrors(admin);
  await login(admin, 'tester');
  const marker = `e2e 指南 ${Date.now()}`;
  await pageOk(admin, '/admin/ops?tab=guide');
  await admin.getByLabel('Markdown').first().fill(
    `# ${marker}\n\n歡迎來到 {{site_name}}。\n\n## 找空卡\n\n\`\`\`bash\nnvidia-smi\n\`\`\`\n\n<img src=x onerror="window.__pwned=1">\n\n[x](javascript:window.__pwned=1)\n`);
  await expect(admin.getByTestId('guide-preview')).toContainText('歡迎來到 E2E Lab。'); // live preview, placeholder filled
  await admin.getByRole('button', { name: '儲存', exact: true }).click();
  await expect(admin.getByText('已儲存新成員指南').first()).toBeVisible();
  const audit = await api(admin.request, 'GET', '/api/admin/audit');
  expect(audit.rows[0]).toMatchObject({ actor: 'tester', action: 'guide_update', target: 'page/guide', detail: { default: false } });
  expect(adminErrors).toEqual([]);

  const dave = await (await browser.newContext()).newPage();
  const daveErrors = trackErrors(dave);
  await login(dave, 'dave');
  await pageOk(dave, '/me');
  await dave.getByRole('link', { name: '新成員指南' }).first().click();
  await expect(dave).toHaveURL(/\/guide$/);
  const guide = dave.getByTestId('guide');
  await expect(guide).toContainText(marker);
  await expect(guide).toContainText('歡迎來到 E2E Lab。');
  await expect(guide.locator('h2#找空卡')).toBeVisible();
  await expect(guide.getByRole('button', { name: '複製程式碼' })).toBeVisible();
  await expect(guide.locator('img, script, a[href^="javascript"]')).toHaveCount(0); // raw HTML and script links are not rendered
  expect(await dave.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  const denied = await dave.request.put('/api/admin/guide', {
    headers: { Origin: BASE_URL, 'X-CSRF-Token': await csrf(dave.request) }, data: { source: 'x' },
  });
  expect(denied.status()).toBe(403);

  // the calendar lists this month's announcements; its iCal URL works without a session (calendar apps send no cookie)
  await pageOk(dave, '/announcements?tab=calendar');
  await expect(dave.getByText('訂閱到行事曆')).toBeVisible();
  const cal = await api(dave.request, 'GET', '/api/calendar');
  expect(cal.subscribe_url).toMatch(/^http:\/\/localhost:8080\/api\/calendar\.ics\?token=\d+\.[0-9a-f]{32}$/);
  const anon = await browser.newContext();
  expect((await anon.request.get('/api/calendar.ics')).status()).toBe(401);
  const feed = await anon.request.get(cal.subscribe_url);
  expect(feed.status()).toBe(200);
  expect(feed.headers()['content-type']).toBe('text/calendar; charset=utf-8');
  const ics = await feed.text();
  expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
  expect(ics).not.toContain('UID:shutdown-'); // scheduled shutdowns are gone
  expect(daveErrors).toEqual([]);
});

test('the sections fit a 375 px phone screen', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 375, height: 812 } })).newPage();
  await login(page, 'tester');
  // the guide with a long code line (no wrapping in <pre>): it scrolls inside its box, never the page
  const long = `ssh -o StrictHostKeyChecking=accept-new -L 8888:localhost:8888 -J jump@bastion.example.org ${'x'.repeat(120)}@gpu01`;
  const guide = await api(page.request, 'GET', '/api/admin/guide');
  await api(page.request, 'PUT', '/api/admin/guide', { source: `${guide.source}\n\n1. 一行很長的指令：\n\n   \`\`\`bash\n   ${long}\n   \`\`\`\n` });
  await pageOk(page, '/guide');
  await expect(page.getByTestId('guide')).toContainText('x'.repeat(120));
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), '/guide').toBeLessThanOrEqual(0);
  await api(page.request, 'PUT', '/api/admin/guide', { source: guide.source });
  // the host list turns into cards
  await pageOk(page, '/hosts');
  await expect(page.getByTestId('host-card-gpu01')).toBeVisible();
  for (const path of ['/', '/guide', '/hosts', '/announcements?tab=calendar', '/admin/ops?tab=guide', '/admin/ops?tab=jobs', '/hosts/gpu01',
    '/admin/people?tab=accounts', '/usage?tab=monthly']) {
    await pageOk(page, path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), path).toBeLessThanOrEqual(0);
  }
  await pageOk(page, '/usage?tab=gpu');
  await expect(page.getByText('gpu01').first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
