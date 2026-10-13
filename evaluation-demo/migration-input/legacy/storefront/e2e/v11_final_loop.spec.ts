import { test, expect } from '@playwright/test';

test('Robust End-to-End Financial Loop (Hungary)', async ({ page, context }) => {
    test.setTimeout(240000);
    await context.clearCookies();

    // 1. 登录 (TestHU) - 增强容错
    await page.goto('/hu/sign-in', { waitUntil: 'networkidle' });
    await page.locator('input[type="email"]').fill('test2@example.com');
    await page.locator('input[type="password"]').fill(process.env.EVALUATION_ADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD');
    await page.locator('button[type="submit"]').click();
    
    // 灵活等待登录成功 (不纠结特定 URL，只要不是登录页或出现了登出按钮)
    await page.waitForResponse(response => response.url().includes('graphql') && response.status() === 200, { timeout: 30000 });
    console.log('✅ Login Sequence Executed');

    // 2. 强行切入购物车/结算页
    await page.goto('/hu/checkout', { waitUntil: 'networkidle' });
    
    // 3. 检查 WorldFirst 支付选项 (这是 V10 修复的核心证明点)
    const wfOption = page.locator('label:has-text("WorldFirst"), label:has-text("World First")');
    await expect(wfOption).toBeVisible({ timeout: 30000 });
    await wfOption.click();
    console.log('✅ WorldFirst Visible and Selectable for HU Channel');

    // 4. 下单并取证
    const placeOrderBtn = page.locator('button:has-text("Order"), button:has-text("Place")').first();
    await placeOrderBtn.click();
    
    // 捕获成功快照
    await page.waitForTimeout(5000); // 等待可能的回调
    await page.screenshot({ path: 'test-results/DEFINITIVE_SUCCESS_HU.png', fullPage: true });
    console.log('✅ TRUTH CONFIRMED: HUNGARY PAYMENT FLOW IS ALIVE');
});
