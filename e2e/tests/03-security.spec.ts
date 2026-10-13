import { generateKeyPairSync } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, BASE_URL, csrf, dc, login, waitForJob, type Job } from './helpers';

// Attacks a member could try through their own SSH keys, on top of the state 02-ui leaves behind
// (dave: an active member whose account exists on gpu01). Run in order.
test.describe.configure({ mode: 'serial' });

/** A fresh ed25519 public key line in OpenSSH format with the given comment. */
function sshKey(comment: string): string {
  const raw = Buffer.from(generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  const str = (b: Buffer) => {
    const n = Buffer.alloc(4);
    n.writeUInt32BE(b.length);
    return Buffer.concat([n, b]);
  };
  return `ssh-ed25519 ${Buffer.concat([str(Buffer.from('ssh-ed25519')), str(raw)]).toString('base64')} ${comment}`;
}

test('a key comment cannot carry template code', async ({ page }) => {
  await login(page, 'dave');
  const headers = { Origin: BASE_URL, 'X-CSRF-Token': await csrf(page.request) };
  for (const comment of ['x{{ 7*7 }}y', "{{ lookup('pipe', 'id') }}", '{% raw %}', 'my laptop']) {
    const r = await page.request.post('/api/me/keys', { headers, data: { pubkey: sshKey(comment) } });
    expect(r.status(), comment).toBe(400);
    expect((await r.json()).error, comment).toContain('註解只能包含英數字');
  }
  const { keys } = await api(page.request, 'GET', '/api/me');
  expect(keys).toEqual([]);
});

test('a symlinked authorized_keys does not expose or re-own /etc/shadow', async ({ browser }) => {
  const gpu01 = (...cmd: string[]) => dc('exec', '-T', 'gpu01', ...cmd);
  const dave = await (await browser.newContext()).newPage();
  const admin = await (await browser.newContext()).newPage();
  await login(dave, 'dave');
  await login(admin, 'tester');

  await test.step('dave exists on gpu01 (collected after 02 created him)', async () => {
    await expect
      .poll(async () => (await api(dave.request, 'GET', '/api/me')).accounts.find((a: any) => a.host === 'gpu01')?.exists,
        { timeout: 3 * 60_000, intervals: [5_000] })
      .toBe(true);
  });

  await test.step('dave points ~/.ssh/authorized_keys at /etc/shadow', async () => {
    dc('exec', '-T', '-u', 'dave', 'gpu01', 'bash', '-c',
      'mkdir -p /home/dave/.ssh && ln -sfn /etc/shadow /home/dave/.ssh/authorized_keys');
    expect(gpu01('stat', '-c', '%U:%G %a', '/etc/shadow').trim()).toBe('root:shadow 640');
  });

  let job: Job | undefined;
  await test.step('dave adds a key: the auto-confirmed job runs as dave, not root', async () => {
    const { job_id } = await api(dave.request, 'POST', '/api/me/keys', { pubkey: sshKey('dave@e2e') });
    expect(job_id, 'key-only users job queued').toBeTruthy();
    job = await waitForJob(admin.request, job_id);
    // dave can't read /etc/shadow, so his own item fails; nothing else happens
    expect(job.output ?? '').toContain("Permission denied: '/home/dave/.ssh/authorized_keys'");
  });

  await test.step('/etc/shadow is untouched and never shown', async () => {
    expect(gpu01('stat', '-c', '%U:%G %a', '/etc/shadow').trim()).toBe('root:shadow 640');
    expect(gpu01('stat', '-c', '%F', '/home/dave/.ssh/authorized_keys').trim()).toBe('symbolic link');
    const detail = await api(admin.request, 'GET', `/api/admin/jobs/${job!.id}`);
    for (const text of [detail.output ?? '', detail.check_output ?? '']) {
      expect(text).not.toMatch(/(^|[\s"'\\n])(root|daemon|admin|labbot):[^:\s]*:\d+:/m);
    }
  });
});
