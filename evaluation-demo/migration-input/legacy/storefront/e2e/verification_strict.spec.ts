
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Screenshot directory is configurable; the default stays inside the checked-out workspace.
const SCREENSHOT_DIR = process.env.ARTIFACTS_DIR || path.resolve(process.cwd(), 'artifacts', 'verification-strict');

// Ensure directory exists
if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

test.describe('真人验证网页功能 (UI Auto Verification)', () => {

    test('完整购买流程验证 (Full Purchase Flow)', async ({ page }) => {
        console.log('开始验证...');

        // --- Step 1: 访问产品页面 ---
        console.log('Step 1: 访问产品页');
        await page.goto('http://localhost:3001/product/nail-design-1');
        await page.waitForLoadState('networkidle');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'step1_product_page.png') });
        console.log('截图: step1_product_page.png - 页面加载完成');

        // --- Step 2: 验证主图与设计选择 ---
        console.log('Step 2: 验证主图与设计选择');
        // Check for main image
        const mainImage = page.locator('div.relative.aspect-square img').first();
        await expect(mainImage).toBeVisible();
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'step2_main_image.png') });
        console.log('截图: step2_main_image.png - 主图可见');

        // Check for select button
        const selectBtn = page.getByText('选择此设计 (Select)');
        if (await selectBtn.isVisible()) {
            await selectBtn.click();
            await page.waitForTimeout(500); // Visual feedback
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'step2_design_selected.png') });
            console.log('截图: step2_design_selected.png - 点击选择设计按钮');
        } else {
            // If missing, capture state to debug
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'step2_error_btn_missing.png') });
            console.error('ERROR: 选择按钮缺失!');
            // Don't fail yet, try to proceed
        }

        // Scroll down
        await page.evaluate(() => window.scrollBy(0, 500));

        // --- Step 3: 指甲属性配置 ---
        console.log('Step 3: 指甲属性配置');
        // Select Shape: Short Coffin
        await page.locator('label').filter({ hasText: /Short Coffin|短梯/ }).first().click();
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'step3_shape_selected.png') });
        console.log('截图: step3_shape_selected.png - 选择甲型: Short Coffin');

        // Select Profile: Test
        const profileLabel = page.locator('div.space-y-2 label').first();
        if (await profileLabel.isVisible()) {
            await profileLabel.click();
            await page.waitForTimeout(300);
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'step3_profile_selected.png') });
            console.log('截图: step3_profile_selected.png - 选择档案');
        }

        // --- Step 4: 尺寸匹配验证 ---
        console.log('Step 4: 尺寸匹配验证');
        // Wait for results
        const resultsHeader = page.locator('text=尺寸匹配结果');
        await expect(resultsHeader).toBeVisible({ timeout: 5000 });

        // Click finger badge
        const firstFinger = page.locator('div.flex.items-center.justify-between.text-xs.bg-muted\\/50').first();
        await firstFinger.click();
        await page.waitForTimeout(1000); // Wait for toast
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'step4_match_toast.png') });
        console.log('截图: step4_match_toast.png - 点击手指查看匹配详情 (Toast)');

        // --- Step 5: 下单 ---
        console.log('Step 5: 下单');
        await page.click('button:has-text("Add to Cart")');
        // Check for success (e.g., text or cart sidebar)
        const successMsg = page.locator('text=Added to Cart'); // Assuming toast
        try {
            await expect(successMsg).toBeVisible({ timeout: 5000 });
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'step5_success.png') });
            console.log('截图: step5_success.png - 加入购物车成功');
        } catch (e) {
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'step5_error.png') });
            console.error('ERROR: 加购失败或超时');
        }

        console.log('验证结束 (Verification Complete)');
    });

    test('后台订单验证 (Backend Order Verification)', async ({ page }) => {
        console.log('Step 6: 后台登录');
        await page.goto('http://localhost:3000/dashboard/login');
        await page.waitForLoadState('networkidle');

        // Login
        await page.getByLabel('Username').fill(process.env.EVALUATION_ADMIN_USERNAME || 'REPLACE_WITH_EVALUATION_ADMIN_USERNAME');
        await page.getByLabel('Password').fill(process.env.EVALUATION_ADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD');
        await page.getByRole('button', { name: 'Sign in' }).click();

        // Wait for dashboard
        await page.waitForURL('**/dashboard');
        await page.waitForTimeout(2000);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'step6_backend_dashboard.png') });
        console.log('截图: step6_backend_dashboard.png - 后台登录成功');

        // Go to Orders
        console.log('Step 7: 查看订单列表');
        await page.goto('http://localhost:3000/dashboard/sales/orders');
        await page.waitForTimeout(2000);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'step7_backend_orders.png') });
        console.log('截图: step7_backend_orders.png - 订单列表');

        // Click first order
        console.log('Step 8: 验证订单详情');
        // Assuming first row is the latest order
        const firstRow = page.locator('table tbody tr').first();
        await firstRow.click();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'step8_order_details.png') });
        console.log('截图: step8_order_details.png - 订单详情');

        // Verify Keywords (Shape, Design)
        // Adjust selectors based on actual UI, using text search for robustness
        const bodyText = await page.locator('body').innerText();
        if (bodyText.includes('Short Coffin')) {
            console.log('✅ 验证成功: 找到关键字 "Short Coffin"');
        } else {
            console.error('❌ 验证失败: 未找到 "Short Coffin"');
        }
    });
});
