import { test, expect } from '@playwright/test';

test('Robust UI Audit - Step by Step', async ({ page, context }) => {
    test.setTimeout(180000);
    
    // 步骤 A: 访问登录页并截图
    await page.goto('/hu/sign-in');
    await page.screenshot({ path: 'test-results/step_A_signin.png' });

    // 步骤 B: 执行登录
    await page.locator('input[type="email"]').fill('test2@example.com');
    await page.locator('input[type="password"]').fill(process.env.EVALUATION_ADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD');
    await page.locator('button[type="submit"]').click();
    
    // 等待网络空闲，不纠结 URL
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/step_B_after_login.png' });

    // 步骤 C: 强制跳转到钱包页浏览
    await page.goto('/hu/account/wallet');
    await page.waitForLoadState('networkidle');
    const walletContent = await page.content();
    await page.screenshot({ path: 'test-results/step_C_wallet.png' });
    console.log('Wallet Page Height:', await page.evaluate(() => document.body.scrollHeight));

    // 步骤 D: 跳转到结算页浏览
    await page.goto('/hu/checkout');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/step_D_checkout.png' });
});
