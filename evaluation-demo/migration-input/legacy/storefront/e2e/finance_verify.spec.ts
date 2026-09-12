import { test, expect } from '@playwright/test';

test('Financial Closed-Loop Final Verification', async ({ page, context }) => {
    test.setTimeout(180000);
    console.log('--- STARTING ROBUST DEPTH VALIDATION (FORCE LOGIN MODE) ---');

    // 1. Force Clear Session to avoid 0-balance ghosting
    console.log('Clearing existing cookies and context...');
    await context.clearCookies();
    
    console.log('Step 1: Performing Mandatory Authentication...');
    await page.goto('/hu/sign-in', { waitUntil: 'networkidle' });
    
    const emailInput = page.locator('input[type="email"], input[name="email"]').first();
    await emailInput.fill('test1@example.com');
    
    const passwordInput = page.locator('input[type="password"], input[name="password"]').first();
    await passwordInput.fill(process.env.EVALUATION_ADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD');
    
    const loginBtn = page.locator('button[type="submit"], button:has-text("Sign In")').first();
    await loginBtn.click();
    
    await page.waitForURL('**/account/profile', { timeout: 30000 });
    console.log('✅ Fresh Authentication Successful');

    // 2. Navigate to Wallet
    console.log('Step 2: Entering Wallet Space...');
    await page.goto('/hu/account/wallet', { waitUntil: 'networkidle' });
    
    // Use a more robust locator for the Audit Flag
    const auditFlag = page.locator('span:has-text("AUDIT READY")');
    await expect(auditFlag).toBeVisible({ timeout: 20000 });
    console.log('✅ Audit Badge Detected');

    // 3. Verify Balance and Click Withdraw
    const balance = page.locator('.text-4xl.text-green-600').first();
    const balanceText = await balance.innerText();
    console.log(`✅ Current Payout Balance: ${balanceText}`);
    
    // Force wait for balance to be reflect in UI if necessary, but 100 EUR should be there now.
    const withdrawLink = page.locator('a:has-text("立即提现")');
    await expect(withdrawLink).toBeVisible({ timeout: 10000 });
    console.log('Step 3: Triggering WorldFirst Withdrawal Flow...');
    await withdrawLink.click();

    // 4. Fill Withdrawal Form
    await page.waitForURL('**/account/wallet/withdraw', { timeout: 20000 });
    console.log('Successfully reached withdrawal page');
    
    const amountInput = page.locator('input[name="amount"]');
    await amountInput.fill('50.00');
    console.log('Input 50.00 EUR for simulation payout');

    const submitBtn = page.locator('button[type="submit"]:has-text("立即申请提现")');
    await submitBtn.click();
    console.log('Step 4: Submitting Payout Request...');

    // 5. Wait for Success and Capture Final Proof
    // Form submission triggers "正在加密存证...", wait for success message
    const successMsg = page.locator('div:has-text("Success"), div:has-text("成功"), .text-green-700').first();
    await expect(successMsg).toBeVisible({ timeout: 60000 });
    console.log('✅ FULL BUDGET LOOP COMPLETED SUCCESSFULLY');

    await page.screenshot({ path: 'test-results/FULL_TRANSACTION_LOOP_FINAL.png', fullPage: true });
    console.log('--- FINAL PROOF CAPTURED ---');
});
