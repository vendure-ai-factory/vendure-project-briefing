import { test, expect } from '@playwright/test';
import * as path from 'path';

const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.resolve(process.cwd(), 'artifacts', 'final-acceptance');

test.describe('Financial Closed Loop & Compliance Alignment Acceptance', () => {

    test('Case 1 & 2: Payout Routing and KYC Thresholds', async ({ page }) => {
        // 1. 登录 (修正路径为 sign-in, 字段为 username, 增加重定向参数)
        await page.goto('http://localhost:3001/de/sign-in?redirectTo=/de/account', { timeout: 60000, waitUntil: 'networkidle' });
        await page.fill('input[name="username"]', 'test2@example.com', { timeout: 30000 });
        await page.fill('input[name="password"]', process.env.EVALUATION_ADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD', { timeout: 30000 });
        await page.click('button:has-text("Sign In")', { timeout: 30000 });
        
        // 等待登录成功跳转至 Account
        await page.waitForURL('**/account**', { timeout: 60000 });
        await page.waitForLoadState('networkidle');

        // 2. 进入钱包发起 €50 提现 (Small Payout)
        await page.goto('http://localhost:3001/de/account/wallet/withdraw', { timeout: 60000, waitUntil: 'networkidle' });
        
        // 填充提现信息 (包含必填的 wfAccountId)
        await page.fill('input[name="amount"]', '50', { timeout: 30000 });
        await page.fill('input[name="wfAccountId"]', 'WF-ACCEPTANCE-V20', { timeout: 30000 });
        
        // 点击立即申请提现
        const payoutBtn = page.getByRole('button', { name: /立即申请提现/ });
        await payoutBtn.click({ timeout: 30000 });
        
        // 验证提示 ✅
        await expect(page.locator('text=✅').first()).toBeVisible({ timeout: 30000 });
        console.log("✅ Case 1: Small payout verified.");

        // 3. 发起 €300 提现 (Large Payout -> KYC)
        await page.goto('http://localhost:3001/de/account/wallet/withdraw', { timeout: 60000, waitUntil: 'networkidle' });
        await page.fill('input[name="amount"]', '300', { timeout: 30000 });
        await page.fill('input[name="wfAccountId"]', 'WF-ACCEPTANCE-V20', { timeout: 30000 });
        await payoutBtn.click({ timeout: 30000 });
        
        // 验证合规拦截提示
        await expect(page.locator('text=WORLD CARD ASYNC LOOP').first()).toBeVisible({ timeout: 30000 });
        await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'case2_kyc_trigger.png') });
        console.log("✅ Case 2: Large payout KYC verified.");
    });

    test('Case 3: FX Sentinel & Alignment Button', async ({ page }) => {
        await page.goto('http://localhost:3001/de/checkout/review', { timeout: 60000, waitUntil: 'networkidle' });
        
        const alignBtn = page.getByRole('button', { name: /立即对齐汇率/ });
        await expect(alignBtn).toBeVisible({ timeout: 45000 });
        await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'case3_fx_sentinel.png') });
        
        await alignBtn.click();
        await expect(alignBtn).not.toBeVisible({ timeout: 30000 });
        console.log("✅ Case 3: FX Sentinel verified.");
    });
});
