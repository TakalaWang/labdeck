import { expect, test, type APIRequestContext } from '@playwright/test';
import { api, login } from './helpers';

// Personal notifications against the mock's fake Discord and SMTP sink (e2e/mock_oauth.py → GET /_sink).
// dave has a managed account on gpu01 since 02-ui ('a newcomer registers …'); run after it.
test.describe.configure({ mode: 'serial' });

const SINK = 'http://localhost:9999/_sink';
type Sink = {
  webhooks: { path: string; body: any }[];
  mails: { from: string; to: string[]; subject: string; body: string }[];
  discord_users: Record<string, string>;
};

async function sink(request: APIRequestContext): Promise<Sink> {
  return (await request.get(SINK)).json();
}

test('a member links Discord, verifies an email, opts in, and hears about maintenance on gpu01', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page, 'dave');
  const alt = `dave.${Date.now()}@example.org`;

  await test.step('everything is off until dave opts in', async () => {
    const n = await api(page.request, 'GET', '/api/me/notifications');
    expect(n.prefs).toEqual({ discord: [], email: [] });
    expect(n.discord).toMatchObject({ available: true, linked: false });
    expect(n.email).toMatchObject({ available: true, address: 'dave@example.edu' });
  });

  await test.step('link Discord through OAuth (scope identify)', async () => {
    await page.goto('/me');
    await page.getByRole('link', { name: '連結 Discord' }).click();
    await expect(page).toHaveTitle('Mock Discord');
    await page.getByPlaceholder('discord_name').fill('dave');
    await page.getByRole('button', { name: 'Authorize' }).click();
    await expect(page).toHaveURL(/\/me$/); // ?discord=linked is consumed
    await expect(page.getByText('已連結 Discord').first()).toBeVisible();
    await expect(page.getByTestId('discord-linked')).toContainText('Dave');
  });

  await test.step('change the email: only a verified address is used', async () => {
    await page.getByLabel('改用其他 Email').fill(alt);
    await page.getByRole('button', { name: '寄送驗證碼' }).click();
    await expect(page.getByTestId('notify-email')).toHaveText('dave@example.edu'); // not yet verified
    // the runner's sender thread delivers the code within seconds
    let code = '';
    await expect
      .poll(async () => {
        const mail = (await sink(page.request)).mails.find((m) => m.to.includes(alt));
        code = mail?.body.match(/驗證碼：(\d{6})/)?.[1] ?? '';
        return code;
      }, { timeout: 60_000, intervals: [1_000] })
      .toMatch(/^\d{6}$/);
    await page.getByLabel(/6 位數驗證碼/).fill(code);
    await page.getByRole('button', { name: '驗證', exact: true }).click();
    await expect(page.getByTestId('notify-email')).toHaveText(alt);
  });

  await test.step('opt in to maintenance notices on both channels', async () => {
    for (const ch of ['Discord', 'Email']) {
      const box = page.getByRole('checkbox', { name: `我有帳號的主機排定維護（${ch}）` });
      await box.click();
      await expect(box).toBeChecked();
    }
    const n = await api(page.request, 'GET', '/api/me/notifications');
    expect(n.prefs).toEqual({ discord: ['maintenance'], email: ['maintenance'] });
  });

  await test.step('an admin announces maintenance on gpu01: dave is mentioned on Discord and mailed', async () => {
    const admin = await (await browser.newContext()).newPage();
    await login(admin, 'tester');
    const title = `e2e 通知 ${Date.now()}`;
    const at = new Date(Date.now() + 30 * 86_400_000).toISOString(); // far away: only the announcement is sent now
    await api(admin.request, 'POST', '/api/admin/announcements', { title, body: '換 UPS', hosts: ['gpu01'], starts_at: at });

    const mention = async () => {
      const s = await sink(page.request);
      const id = s.discord_users.dave;
      const post = s.webhooks.find((w) => typeof w.body?.content === 'string' && w.body.content.includes(title)
        && w.body.content.startsWith(`<@${id}> `));
      return post && { id, allowed_mentions: post.body.allowed_mentions };
    };
    await expect.poll(mention, { timeout: 60_000, intervals: [1_000] }).toBeTruthy();
    const { id, allowed_mentions } = (await mention())!;
    expect(id).toMatch(/^\d{18}$/);
    expect(allowed_mentions).toEqual({ parse: [], users: [id] }); // only dave can be pinged
    await expect
      .poll(async () => (await sink(page.request)).mails.find((m) => m.subject.includes(title)),
        { timeout: 60_000, intervals: [1_000] })
      .toMatchObject({ to: [alt], from: 'lab@example.edu' });
    const mail = (await sink(page.request)).mails.find((m) => m.subject.includes(title))!;
    expect(mail.body).toContain('你有帳號的受影響主機：gpu01');
    // the admin channel post is unchanged: no mentions allowed at all
    const adminPost = (await sink(page.request)).webhooks.find((w) => w.body?.content?.startsWith(`[公告] ${title}`));
    expect(adminPost?.body.allowed_mentions).toEqual({ parse: [] });
  });
  expect(errors).toEqual([]);
});
