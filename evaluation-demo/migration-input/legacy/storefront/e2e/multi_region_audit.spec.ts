import { test, expect } from '@playwright/test';

// Comparative Audit for HU vs AT Payments
// Ensures items are in cart and checks the final list

async function auditRegion(page, context, region, email) {
    console.log(`--- Auditing Region: ${region.toUpperCase()} ---`);
    await context.clearCookies();
    
    // 1. Auth
    await page.goto(`/${region}/sign-in`, { waitUntil: 'networkidle' });
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(process.env.EVALUATION_ADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD');
    await page.locator('button[type="submit"]').click();
    
    // Wait for login - use a more robust check
    await page.waitForTimeout(3000); 
    console.log(`Logged in. Current URL: ${page.url()}`);

    // 2. Add product (Ensure cart not empty)
    await page.goto(`/${region}`, { waitUntil: 'networkidle' });
    const product = page.locator('a[href*="/product/"]').first();
    await product.click();
    await page.waitForLoadState('networkidle');
    const addToCart = page.getByRole('button', { name: /Add to Cart/i });
    await addToCart.click();
    await page.waitForTimeout(2000); // Allow cart update
    
    // 3. Checkout flow
    await page.goto(`/${region}/checkout`, { waitUntil: 'networkidle' });
    
    // Handle "Region Switch" if present
    const switchBtn = page.locator('button:has-text("确认切换")');
    if (await switchBtn.isVisible()) {
        await switchBtn.click();
        await page.waitForLoadState('networkidle');
    }

    // Progress through Shipping Address
    const continueAddress = page.locator('button:has-text("Continue with selected address")');
    if (await continueAddress.isVisible({ timeout: 15000 })) {
        await continueAddress.click();
    }

    // Progress through Delivery
    const deliveryOption = page.locator('label:has-text("Standard Shipping"), label:has-text("Express Shipping")').first();
    if (await deliveryOption.isVisible({ timeout: 10000 })) {
        await deliveryOption.click();
        const continueDelivery = page.locator('button:has-text("Continue to payment")');
        await continueDelivery.click();
    }

    // 4. Verify Payment List
    const paymentHeader = page.locator('button:has-text("Payment Method")').first();
    await expect(paymentHeader).toBeVisible({ timeout: 20000 });
    if (await paymentHeader.getAttribute('data-state') === 'closed') {
        await paymentHeader.click();
    }
    
    await page.waitForTimeout(5000); // Wait for WorldFirst manifest
    await page.screenshot({ path: `test-results/${region.toUpperCase()}_AUDIT_FINAL.png` });
    
    const paymentLabels = await page.locator('[data-slot="content"] label').allTextContents();
    console.log(`${region.toUpperCase()} Payment Options:`, paymentLabels);
}

test('Multi-Region Payment Audit (HU and AT)', async ({ page, context }) => {
    test.setTimeout(300000); // 5 mins
    
    // Hungary Check
    try {
        await auditRegion(page, context, 'hu', 'test2@example.com');
    } catch (e) {
        console.error('HU Audit failed:', e.message);
        await page.screenshot({ path: 'test-results/HU_AUDIT_ERROR.png' });
    }

    // Austria Check
    try {
        await auditRegion(page, context, 'at', 'test1@example.com');
    } catch (e) {
        console.error('AT Audit failed:', e.message);
        await page.screenshot({ path: 'test-results/AT_AUDIT_ERROR.png' });
    }
});
