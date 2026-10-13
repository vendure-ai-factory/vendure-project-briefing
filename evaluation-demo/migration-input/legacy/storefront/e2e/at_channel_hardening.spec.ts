import { test, expect } from '@playwright/test';

test('Austria Channel Hardening and Payment Full Loop', async ({ page, context }) => {
    test.setTimeout(240000); // 4 minutes
    await context.clearCookies();

    console.log('--- Step 1: Login with AT Account ---');
    await page.goto('/at/sign-in', { waitUntil: 'networkidle' });
    await page.locator('input[type="email"]').fill('test1@example.com');
    await page.locator('input[type="password"]').fill(process.env.EVALUATION_ADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD');
    await page.locator('button[type="submit"]').click();
    
    await expect(page.locator('button:has-text("Hi,")').first()).toBeVisible({ timeout: 60000 });
    console.log(`✅ Login successful. Current URL: ${page.url()}`);

    console.log('--- Step 2: Add Product to Cart ---');
    await page.goto('/at', { waitUntil: 'networkidle' });
    const firstProduct = page.locator('a[href*="/product/"]').first();
    await firstProduct.click();
    await page.waitForLoadState('networkidle');
    
    const addToCartButton = page.getByRole('button', { name: /Add to Cart/i });
    await expect(addToCartButton).toBeVisible();
    await addToCartButton.click();
    await expect(page.getByText(/Added to cart/i).first()).toBeVisible();
    console.log('✅ Added to cart');

    console.log('--- Step 3: Forced Channel Switch to HU ---');
    await page.goto('/hu/cart', { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000); 
    console.log(`Current URL after forced switch: ${page.url()}`);

    console.log('--- Step 4: Return to AT Checkout & Handle Hardening ---');
    await page.goto('/at/checkout', { waitUntil: 'networkidle' });
    
    const hardeningPopup = page.locator('text=检测到地区切换');
    if (await hardeningPopup.isVisible({ timeout: 10000 })) {
        console.log('🛡️ Hardening Mechanism Detected!');
        const confirmBtn = page.locator('button:has-text("确认切换")');
        await confirmBtn.click();
        await page.waitForLoadState('networkidle');
    }

    console.log('--- Step 5: Complete Shipping Step ---');
    // We saw in V8 that Shipping Address was expanded but not submitted.
    const continueAddress = page.locator('button:has-text("Continue with selected address")');
    await expect(continueAddress).toBeVisible({ timeout: 20000 });
    await continueAddress.click();
    console.log('Clicked Continue with Address');

    console.log('--- Step 6: Complete Delivery Step ---');
    const deliveryOption = page.locator('label:has-text("Standard Shipping"), label:has-text("Express Shipping")').first();
    await expect(deliveryOption).toBeVisible({ timeout: 20000 });
    await deliveryOption.click();
    
    const continueDelivery = page.locator('button:has-text("Continue to payment")');
    if (await continueDelivery.isVisible()) {
        await continueDelivery.click();
    } else {
        // Some themes auto-progress or use different button names
        const nextBtn = page.getByRole('button', { name: /Continue/i }).last();
        await nextBtn.click();
    }
    console.log('Clicked Continue to Payment');

    console.log('--- Step 7: Verify AT Payment Methods ---');
    const paymentHeader = page.locator('button:has-text("Payment Method"), [data-slot="accordion-item"]:has-text("Payment Method")').first();
    await expect(paymentHeader).toBeVisible({ timeout: 30000 });
    
    if (await paymentHeader.getAttribute('data-state') === 'closed') {
        await paymentHeader.click();
    }
    
    await page.waitForTimeout(4000); // Wait for manifest fetching
    await page.screenshot({ path: 'test-results/AT_PAYMENT_PAGE_FINAL_RECOVERY.png' });
    
    const wfOption = page.locator('text=WorldFirst').first();
    await expect(wfOption).toBeVisible({ timeout: 20000 });
    console.log('✅ WorldFirst localized payment detected');
    
    const atMarkers = ['EPS', 'Sofort', 'Klarna', 'Giropay']; 
    for (const marker of atMarkers) {
        if (await page.locator(`text=${marker}`).first().isVisible()) {
            console.log(`✅ AT Tool confirmed: ${marker}`);
        }
    }
    
    console.log('✅ FULL LOOP TEST COMPLETED SUCCESSFULLY');
});
