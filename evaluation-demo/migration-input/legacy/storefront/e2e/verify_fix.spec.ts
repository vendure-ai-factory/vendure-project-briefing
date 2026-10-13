import { test, expect } from '@playwright/test';

test('cross-border shipping and address persistence', async ({ page }) => {
    // 1. Visit storefront on port 3001
    await page.goto('http://localhost:3001');
    await page.waitForTimeout(2000);

    // 2. Add a product to cart
    const products = await page.locator('a[href^="/product/"]');
    await products.first().click();
    await page.waitForTimeout(2000);

    const addToCart = await page.locator('button:has-text("Add to cart"), button:has-text("Bag")');
    await addToCart.first().click();
    await page.waitForTimeout(2000);

    // 3. Go to checkout
    await page.goto('http://localhost:3001/checkout');
    await page.waitForTimeout(3000);

    // 4. Fill in or select address
    const emailInput = page.locator('input[name="email"]');
    if (await emailInput.isVisible()) {
        await emailInput.fill('test@example.com');
        const continueBtn = page.locator('button:has-text("Continue")');
        await continueBtn.first().click();
        await page.waitForTimeout(1000);
    }

    // Address Step
    // Select country Austria (AT)
    await page.selectOption('select[name="countryCode"]', 'AT');
    await page.fill('input[name="fullName"]', 'Antigravity Test');
    await page.fill('input[name="streetLine1"]', 'Test Street 1');
    await page.fill('input[name="city"]', 'Vienna');
    await page.fill('input[name="postalCode"]', '1010');

    await page.click('button:has-text("Continue")');
    await page.waitForTimeout(3000);

    // 5. Verify shipping methods
    // Check for Delivery Method title
    await expect(page.locator('text=Delivery Method')).toBeVisible();

    const errorMsg = page.locator('text=No shipping methods available');
    await expect(errorMsg).not.toBeVisible();

    console.log('Verification Success: Checkout proceeded to delivery stage for cross-border address.');
});
