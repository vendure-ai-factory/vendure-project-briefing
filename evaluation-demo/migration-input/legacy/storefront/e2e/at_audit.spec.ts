import { test, expect } from '@playwright/test';
test('Austria Payment Audit', async ({ page, context }) => {
    test.setTimeout(120000);
    await context.clearCookies();
    await page.goto('/at/sign-in', { waitUntil: 'networkidle' });
    await page.locator('input[type="email"]').fill('test1@example.com');
    await page.locator('input[type="password"]').fill(process.env.EVALUATION_ADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD');
    await page.locator('button[type="submit"]').click();
    await page.goto('/at/checkout', { waitUntil: 'networkidle' });
    const paymentArea = page.locator('div:has-text("Payment Method")');
    await expect(paymentArea).toBeVisible({ timeout: 20000 });
    await page.screenshot({ path: 'test-results/AT_AUDIT.png' });
    console.log('--- AT Audit DOM Snapshot ---');
    console.log(await page.content());
});
