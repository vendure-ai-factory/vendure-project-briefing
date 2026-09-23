import { test, expect } from '@playwright/test';
import { sqlite3 } from 'sqlite3';

test('Financial Closed Loop: Purchase -> Payout -> Audit', async ({ page }) => {
    // 强制清除 Session，确保以 TestHU 登录
    await page.context().clearCookies();
    
    // 1. 登录
    await page.goto('http://localhost:3001/hu/login');
    await page.fill('input[name="email"]', 'test2@example.com');
    await page.fill('input[name="password"]', process.env.EVALUATION_ADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/account**');
    console.log('✅ Logged in as TestHU');

    // 2. 进入钱包并触发提现 (使用波次 24 补全的 UI)
    await page.goto('http://localhost:3001/hu/account/wallet');
    await page.waitForTimeout(2000); // 等待 Hydration
    await page.screenshot({ path: 'test-results/debug_wallet_pre_click.png' });
    
    // 点击补全后的提现按钮 (使用更宽松的正则匹配)
    await page.click('text=/立即提现/');
    await page.waitForURL('**/withdraw**');
    console.log('✅ Entered Withdrawal Page');

    // 3. 填写补全后的表单 (包含 WF Account ID)
    await page.fill('input[name="amount"]', '30000');
    await page.fill('input[name="wfAccountId"]', 'WF-AUDIT-2026-0414');
    await page.screenshot({ path: 'test-results/audit_02_form_filled.png' });
    
    // 提交
    await page.click('button[type="submit"]');
    
    // 等待成功响应
    await page.waitForSelector('text=已成功提交', { timeout: 15000 });
    console.log('✅ Payout Request Submitted Successfully');
    await page.screenshot({ path: 'test-results/audit_03_submission_success.png' });

    // 4. 返回列表验证审计标签 (波次 24 注入的 UI)
    await page.goto('http://localhost:3001/hu/account/wallet');
    await page.waitForSelector('text=3100 (HU)');
    console.log('✅ Audit Tag 3100 (HU) detected in list');
    
    // 验证 Account ID 是否也在 UI 显示
    const historyText = await page.innerText('body');
    expect(historyText).toContain('WF-AUDIT-2026-0414');
    
    await page.screenshot({ path: 'test-results/audit_04_history_verified.png' });
});
