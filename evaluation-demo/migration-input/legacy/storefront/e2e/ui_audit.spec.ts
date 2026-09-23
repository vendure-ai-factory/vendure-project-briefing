import { test, expect } from '@playwright/test';

test('Frontend UI Gap Analysis', async ({ page, context }) => {
    test.setTimeout(180000);
    
    // 1. 登录
    await page.goto('/hu/sign-in', { waitUntil: 'networkidle' });
    await page.locator('input[type="email"]').fill('test2@example.com');
    await page.locator('input[type="password"]').fill(process.env.EVALUATION_ADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD');
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/account/profile');

    // 2. 检查 Profile 页面 (KYC 状态)
    await page.screenshot({ path: 'test-results/audit_profile_kyc.png' });
    console.log('✅ Profile UI Captured');

    // 3. 检查钱包页面 (提现功能)
    await page.goto('/hu/account/wallet', { waitUntil: 'networkidle' });
    await page.screenshot({ path: 'test-results/audit_wallet_page.png' });
    const withdrawBtn = page.locator('button:has-text("Withdraw"), button:has-text("Kifizetés")');
    console.log('Withdraw Button Visible: ', await withdrawBtn.isVisible());

    // 4. 检查结算页面 (支付手段)
    await page.goto('/hu/checkout', { waitUntil: 'networkidle' });
    await page.screenshot({ path: 'test-results/audit_checkout_page.png' });
    console.log('✅ Checkout UI Captured');
});
