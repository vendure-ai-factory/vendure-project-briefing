import { test, expect } from '@playwright/test';

test('Vienna Payment Check', async ({ page, context }) => {
    test.setTimeout(120000);
    await context.clearCookies();
    
    // 1. 登录
    await page.goto('/at/sign-in', { waitUntil: 'networkidle' });
    await page.locator('input[type="email"]').fill('test1@example.com');
    await page.locator('input[type="password"]').fill(process.env.EVALUATION_ADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD');
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/account/profile');

    // 2. 进入购物车并结算 (假定已有商品或直接进已开启的订单)
    await page.goto('/at/checkout', { waitUntil: 'networkidle' });
    
    // 3. 检查支付列表
    const paymentArea = page.locator('div:has-text("Payment Method")');
    await expect(paymentArea).toBeVisible({ timeout: 15000 });
    
    // 截图取证
    await page.screenshot({ path: 'test-results/HUNGARY_PAYMENT_READY.png' });
    
    // 检查是否出现了 WorldFirst
    const wfOption = page.locator('text=WorldFirst');
    await expect(wfOption).toBeVisible({ timeout: 10000 });
    console.log('✅ HUNGARY LOCALIZED PAYMENT DETECTED SUCCESSFULLY');
});
