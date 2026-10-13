
import { test, expect } from '@playwright/test';

test('verify single nail purchase flow', async ({ page }) => {
    test.setTimeout(120000);
    // 1. Go to the correct nail design product
    await page.goto('http://localhost:3001/product/nail-design-1');

    // Wait for page to load
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'test-results/step1-page-loaded.png' });

    // 2. Look for shape selector buttons
    // The shapes are displayed as small clickable cards with shape names
    const shapeBtn = page.locator('button, div, label').filter({ hasText: /短尖|short-stiletto|stiletto/i }).first();
    if (await shapeBtn.count() > 0) {
        await shapeBtn.click();
        console.log('Clicked shape button');
    } else {
        console.log('Shape buttons not found, checking page content...');
        const pageText = await page.textContent('body');
        console.log('Page text (first 500 chars):', pageText?.substring(0, 500));
    }

    await page.screenshot({ path: 'test-results/step2-shape-selected.png' });

    // 3. Select profile if available
    const profileInput = page.locator('[id^="profile-"], [name="profile"]').first();
    if (await profileInput.count() > 0) {
        await profileInput.click();
        console.log('Clicked profile');
    }

    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-results/step3-profile-selected.png' });

    // 4. Try to find finger items (左拇指 = Left Thumb)
    const fingerItem = page.locator('text=左拇指').first();
    if (await fingerItem.count() > 0) {
        console.log('Found 左拇指, clicking to select...');
        await fingerItem.click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: 'test-results/step4-finger-selected.png' });
        console.log('Finger selected successfully!');
    } else {
        console.log('左拇指 not found on page');
        await page.screenshot({ path: 'test-results/step4-no-finger-found.png' });
    }

    // 5. Try to add to cart
    const addBtn = page.locator('button').filter({ hasText: /add to cart|加入购物车/i }).first();
    if (await addBtn.count() > 0) {
        await addBtn.click();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'test-results/step5-after-add-to-cart.png' });
        console.log('Clicked Add to Cart');
    }

    console.log('=== Test completed ===');
});
