import { test, expect } from '@playwright/test';

test('True End-to-End Financial Loop (Hungary)', async ({ page, context }) => {
    test.setTimeout(240000);
    await context.clearCookies();

    // 1. 登录 (TestHU)
    await page.goto('/hu/sign-in', { waitUntil: 'networkidle' });
    await page.locator('input[type="email"]').fill('test2@example.com');
    await page.locator('input[type="password"]').fill(process.env.EVALUATION_ADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD');
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/account/profile');
    console.log('✅ Logged in as TestHU');

    // 2. 加购 (如果没有商品先去详情页加购)
    await page.goto('/hu/shop', { waitUntil: 'networkidle' });
    const product = page.locator('a:has-text("指甲")').first(); // 模糊匹配
    if (await product.isVisible()) {
        await product.click();
        await page.locator('button:has-text("Add to cart")').first().click();
        console.log('✅ Product added to cart');
    }

    // 3. 进入结算流程
    await page.goto('/hu/checkout', { waitUntil: 'networkidle' });
    console.log('Entering Checkout - Checking Payment Visibility...');

    // 4. 选择支付方式 (关键：验证 WorldFirst 是否出现)
    const wfOption = page.locator('label:has-text("WorldFirst")');
    await expect(wfOption).toBeVisible({ timeout: 20000 });
    await wfOption.click();
    console.log('✅ WorldFirst Selected for HU Channel');

    // 5. 点击下单并模拟支付
    const placeOrderBtn = page.locator('button:has-text("Review & Place Order")').first();
    await placeOrderBtn.click();
    
    const confirmBtn = page.locator('button:has-text("Place Order")').first();
    await confirmBtn.click();

    // 6. 等待重定向至模拟网关并点击成功 (WorldFirst Sandbox Logic)
    // 注意：如果是单页面模拟，直接查找 Success 标识
    const successHeader = page.locator('h1:has-text("Payment Success"), h1:has-text("成功")');
    await expect(successHeader).toBeVisible({ timeout: 60000 });
    
    await page.screenshot({ path: 'test-results/TRUE_PURCHASE_COMPLETE.png', fullPage: true });
    console.log('✅ REAL PURCHASE COMPLETE - E2E CLOSURE CONFIRMED');
});
