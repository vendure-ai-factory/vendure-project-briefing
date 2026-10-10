import { test, expect } from '@playwright/test';

test('Channel handshake appearing and switching session', async ({ page, context }) => {
    // 0. 清除 Cookie 确保环境干净
    console.log('Clearing cookies...');
    await context.clearCookies();

    // 监听浏览器控制台日志
    page.on('console', msg => {
        console.log(`[BROWSER] ${msg.type().toUpperCase()}: ${msg.text()}`);
    });

    // 1. 登录 DE 频道
    console.log('Navigating to /de/sign-in...');
    await page.goto('/de/sign-in', { waitUntil: 'load' });
    
    console.log('Waiting for Email field...');
    await page.waitForSelector('label:has-text("Email")', { timeout: 10000 });
    
    console.log('Filling login form...');
    // 使用 Label 定位，更健壮
    await page.getByLabel('Email').fill('test1@example.com');
    await page.getByLabel('Password').fill(process.env.EVALUATION_TEST_PASSWORD || 'REPLACE_WITH_EVALUATION_TEST_PASSWORD');
    
    console.log('Submitting login form...');
    // 使用 exact: true 避免与 Header 中的 Sign in 冲突
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    
    // 显式等待 URL 发生变化 (Next.js 15 重定向)
    console.log('Waiting for login redirect to home...');
    await page.waitForURL('http://localhost:3001/**', { timeout: 15000 });
    
    // 检查并记录关键 Cookie
    const cookies = await context.cookies();
    const authToken = cookies.find(c => c.name === 'vendure-auth-token');
    console.log('Auth Token Cookie Status:', authToken ? 'FOUND' : 'MISSING');
    
    // 2. 模拟跨越边界前往匈牙利 (/hu/)
    console.log('Simulating navigation to /hu/ (crossing borders)...');
    await page.goto('/hu/', { waitUntil: 'load' });
    
    // 给一点时间让 Client Side useEffect 加载 getSession
    await page.waitForTimeout(3000);
    
    // 3. 检查握手弹出框
    console.log('Checking for Handshake Popup...');
    const handshakePopup = page.locator('text=检测到地区切换');
    
    try {
        await expect(handshakePopup).toBeVisible({ timeout: 15000 });
        console.log('SUCCESS: Handshake popup is visible!');
    } catch (e) {
        // 如果没看到，截图确认当前 header 状态
        await page.screenshot({ path: 'handshake-failure-header.png', fullPage: false });
        // 获取页面上的所有文本以防翻译差异
        const bodyText = await page.innerText('body');
        console.log('Body Text Snippet:', bodyText.substring(0, 500));
        throw e;
    }
    
    // 4. 点击“确认切换”
    console.log('Clicking "确认切换"...');
    await page.click('button:has-text("确认切换")');
    
    // 5. 验证弹出框消失并显示成功提示
    await expect(handshakePopup).toBeHidden({ timeout: 10000 });
    await expect(page.locator('text=已切换至 HU 频道会话')).toBeVisible();
    
    // 6. [NEW] 验证持久化：导航到另一个 HU 页面，不应再弹出
    console.log('Verifying persistence: Navigating to another /hu/ page...');
    await page.goto('/hu/cart', { waitUntil: 'load' });
    await page.waitForTimeout(3000);
    await expect(page.locator('text=检测到地区切换')).not.toBeVisible();
    console.log('SUCCESS: Popup did not reappear after navigation.');

    // 7. [NEW] 验证刷新后不弹出
    console.log('Verifying persistence: Reloading the page...');
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(3000);
    await expect(page.locator('text=检测到地区切换')).not.toBeVisible();
    console.log('SUCCESS: Popup did not reappear after reload.');

    console.log('FINAL SUCCESS: Channel Handshake verified and persistence confirmed.');
    await page.screenshot({ path: 'handshake-success-final.png' });
});
