import { test, expect } from '@playwright/test';

test('Definitive Payment Visibility (Incognito)', async ({ page, context }) => {
    test.setTimeout(120000);
    // 强制清理
    await context.clearCookies();
    await context.clearPermissions();

    // 1. 登录
    await page.goto('/hu/sign-in', { waitUntil: 'networkidle' });
    await page.locator('input[type="email"]').fill('test2@example.com');
    await page.locator('input[type="password"]').fill(process.env.EVALUATION_ADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD');
    await page.locator('button[type="submit"]').click();
    await page.waitForResponse(r => r.url().includes('graphql'), { timeout: 30000 });

    // 2. 检查结算页
    await page.goto('/hu/checkout', { waitUntil: 'networkidle' });
    const wfLabel = page.locator('text=WorldFirst');
    await expect(wfLabel).toBeVisible({ timeout: 20000 });
    
    // 终极取证
    await page.screenshot({ path: 'test-results/DEFINITIVE_PAYMENT_FIXED.png', fullPage: true });
    console.log('✅ TRUTH_CONFIRMED: PAYMENT METHOD IS VISIBLE ON FRONTEND');
});
