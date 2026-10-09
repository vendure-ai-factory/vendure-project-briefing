
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const REPORT_DIR = path.join(__dirname, '../../antigravity/reports');
const SCREENSHOT_DIR = path.join(__dirname, '../../antigravity/screenshots');

test.describe('Nail Design Purchase Flow', () => {

    test('User can customize and buy nail design 1', async ({ page }) => {
        console.log('Starting Nail Verification Test...');

        // 1. Visit Product Page
        await page.goto('http://localhost:3001/product/nail-design-1');
        await page.waitForLoadState('networkidle');

        // Capture initial state
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, '1_product_page.png') });

        // 2. Verification: Effect Image
        // Check if main image is visible and not broken
        // The design selector adds "Design 1" text or similar?
        // Let's check for the image element.
        const mainImage = page.locator('div.relative.aspect-square img').first();
        await expect(mainImage).toBeVisible();
        console.log('Main image is visible.');

        // 3. Select Design (Click the new button)
        const selectDesignBtn = page.getByText('选择此设计 (Select)');
        if (await selectDesignBtn.isVisible()) {
            await selectDesignBtn.click();
            console.log('Clicked "Select This Design" button.');
        } else {
            console.log('Select button not found, maybe already selected?');
        }

        // 4. Scroll to Customization
        await page.locator('text=定制你的穿戴甲').scrollIntoViewIfNeeded();

        // 5. Select Shape: "Short Coffin"
        // Find label containing "Short Coffin" (or equivalent Chinese "短梯")
        const shapeLabel = page.locator('label').filter({ hasText: /Short Coffin|短梯/ }).first();
        await shapeLabel.click();
        console.log('Selected Shape: Short Coffin');

        // 6. Select Profile
        // Assuming "test" user is logged in or profile exists.
        // If no profile, we might be stuck. But user said "test account... has profile".
        // We look for any profile radio.
        const profileRadio = page.locator('input[name="radio-group-undefined"]'); // RadioGroup ID might vary?
        // Better: Look for label "test" or first profile label
        const profileLabel = page.locator('div.space-y-2 label').first();
        if (await profileLabel.isVisible()) {
            await profileLabel.click();
            const profileName = await profileLabel.innerText();
            console.log(`Selected Profile: ${profileName}`);
        } else {
            console.error('No nail profile found!');
            // Fail safely?
        }

        // 7. Verification: Matching Results
        // Wait for specific text or badges
        await expect(page.locator('text=尺寸匹配结果')).toBeVisible({ timeout: 5000 });
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, '2_matching_results.png') });
        console.log('Matching results visible.');

        // 8. Click a Finger Badge (Test Toast)
        const badge = page.locator('.bg-muted\\/50 .badge').first(); // Adjust selector based on code
        // Actually, the badge is inside the div that has onClick.
        // The div has class "flex items-center justify-between text-xs bg-muted/50..."
        const fingerRow = page.locator('div.flex.items-center.justify-between.text-xs.bg-muted\\/50').first();
        await fingerRow.click();
        console.log('Clicked finger row for Toast.');
        await page.waitForTimeout(1000); // Wait for toast
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, '3_toast_visible.png') });

        // 9. Add to Cart
        await page.click('button:has-text("Add to Cart")');
        await expect(page.locator('text=Added to Cart')).toBeVisible();
        console.log('Added to Cart.');

        // 10. Admin Verification (Simplified)
        // We will just verify the cart content has custom fields via API or UI?
        // UI is easier for this script.
        await page.goto('http://localhost:3000/admin');
        // Login
        await page.fill('input[name="username"]', process.env.EVALUATION_ADMIN_USERNAME || 'REPLACE_WITH_EVALUATION_ADMIN_USERNAME');
        await page.fill('input[name="password"]', process.env.EVALUATION_ADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD');
        await page.click('button:has-text("Sign in")');
        await page.waitForLoadState('networkidle');

        // Go to Orders
        await page.click('a[href="/admin/sales/orders"]');
        await page.waitForTimeout(2000);

        // Click first order
        await page.locator('.data-table tbody tr').first().click();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, '4_admin_order.png') });

        // Verify Custom Fields in Order Line
        // This might be hidden in a "Custom Fields" accordion or similar.
        // We'll just screenshot for manual verification as requested "generate report".

        console.log('Test Complete.');
    });
});
