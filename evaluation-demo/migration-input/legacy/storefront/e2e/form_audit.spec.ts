import { test, expect } from '@playwright/test';

test('Deep Audit - Withdrawal Form Contents', async ({ page, context }) => {
    test.setTimeout(180000);
    
    // 1. 登录
    await page.goto('/hu/sign-in');
    await page.locator('input[type="email"]').fill('test2@example.com');
    await page.locator('input[type="password"]').fill(process.env.EVALUATION_ADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD');
    await page.locator('button[type="submit"]').click();
    await page.waitForLoadState('networkidle');

    // 2. 进入钱包并点击提现 (应该已经亮起)
    await page.goto('/hu/account/wallet');
    await page.waitForLoadState('networkidle');
    const withdrawBtn = page.locator('button:has-text("Withdraw"), button:has-text("Kifizetés")');
    
    // 增加一次截图确认按钮状态
    await page.screenshot({ path: 'test-results/audit_unlocked_button.png' });
    
    if (await withdrawBtn.isVisible()) {
        await withdrawBtn.click();
        await page.waitForTimeout(3000); // 等待弹出层
        await page.screenshot({ path: 'test-results/audit_withdrawal_modal.png' });
        console.log('✅ Modal Clicked and Screenshot taken.');
    } else {
        console.log('❌ Withdraw button STILL NOT VISIBLE even after DB injection.');
    }
});
