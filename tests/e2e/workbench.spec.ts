import { expect, test } from '@playwright/test';

test.describe('Roku RAF Ad Tool — 5-Tab Browser Workbench E2E', () => {
  test('navigates all 5 tabs, validates tags/manifests, builds vendor URLs, audits beacons & snapshots', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toContainText('Roku RAF Ad Tool');

    // Tab 1: Validator, Manifest Inspector & Vendor Builder
    await page.getByRole('button', { name: '3-Ad Pod + Buffet' }).click();
    await expect(page.getByText('RAF Compatible')).toBeVisible();

    await page.getByRole('button', { name: /HLS \(\.m3u8\) & MPEG-DASH/i }).click();
    await page.getByRole('button', { name: 'Load VOD SSAI Playlist' }).click();
    await expect(page.getByText('DATERANGE', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: /GAM \/ DAI \/ SpringServe/i }).click();
    await page.getByRole('button', { name: /Build Request, Audit Params/i }).click();
    await expect(page.getByText('Compliance Score: 100/100')).toBeVisible();
    await expect(page.locator('pre.code-box')).toContainText('Library "Roku_Ads.brs"');

    await page.getByRole('button', { name: /BrightScript Repo Scanner/i }).click();
    await expect(page.getByText(/RAF Ready • Score: 100\/100/i)).toBeVisible();

    // Tab 2: Live Mock, SSAI & DAI Studio
    await page.getByRole('button', { name: /2\. Live Mock, SSAI & DAI Studio/i }).click();
    await page.getByRole('button', { name: /Cue Live SCTE-35/i }).click();
    await expect(page.getByText(/Live Cue Injected:/i)).toBeVisible();
    await expect(page.getByText(/Ad Chaos & Network Fault Injector/i)).toBeVisible();

    // Tab 3: Beacon Diff & Cert Auditor
    await page.getByRole('button', { name: /3\. Beacon Diff & Cert Auditor/i }).click();
    await page.getByRole('button', { name: /Simulate Full Ad Beacons/i }).click();
    await expect(page.getByText('Impression').first()).toBeVisible();
    await page.getByRole('button', { name: /Save Session Snapshot/i }).click();
    await expect(page.getByText(/Saved snapshot/i)).toBeVisible();

    // Tab 4: Roku Roster & Suite Runner
    await page.getByRole('button', { name: /4\. Roku Roster & Suite Runner/i }).click();
    await expect(page.getByText(/Attach & Deep-Link Your Own Channel/i)).toBeVisible();
    await expect(page.getByText(/Roku OS :8080 Memory & Texture VRAM Profiler/i)).toBeVisible();
    await expect(page.getByText(/5-Mode RAF Deep-Link Launcher/i)).toBeVisible();
    await expect(page.getByText(/Automated Scenario Suite Runner/i)).toBeVisible();

    // Tab 5: Sessions & HAR Reports
    await page.getByRole('button', { name: /5\. Sessions & HAR Reports/i }).click();
    await expect(page.getByText(/SQLite Snapshot Archive/i)).toBeVisible();
    await page.getByRole('button', { name: /Inspect/i }).first().click();
    await expect(page.getByText(/Roku Certification Checks/i)).toBeVisible();
  });
});
