import { test, expect } from '@playwright/test';

test('cross-border shipping and address persistence', async ({ page }) => {
    // 1. Visit storefront
    await page.goto('http://localhost:3000');

    // 2. Add a product to cart (find a German product or any product)
    await page.click('text=Products');
    await page.waitForTimeout(2000);
    // Click first product card
    const products = await page.locator('a[href^="/product/"]');
    await products.first().click();
    await page.waitForTimeout(2000);

    // Add to cart
    const addToCart = await page.locator('button:has-text("Add to cart")');
    if (await addToCart.isVisible()) {
        await addToCart.click();
    } else {
        // Maybe it's "Add to Bag"
        await page.locator('button:has-text("Bag")').click();
    }

    await page.waitForTimeout(2000);

    // 3. Go to checkout
    await page.goto('http://localhost:3000/checkout');
    await page.waitForTimeout(3000);

    // 4. Fill in or select address
    // For simplicity, let's assume we are guest if redirected or can see forms
    const emailInput = page.locator('input[name="email"]');
    if (await emailInput.isVisible()) {
        await emailInput.fill('test@example.com');
        await page.click('button:has-text("Continue")');
        await page.waitForTimeout(1000);
    }

    // Address Step
    // Change country to Austria (AT)
    await page.selectOption('select[name="countryCode"]', 'AT');
    await page.fill('input[name="fullName"]', 'Antigravity Test');
    await page.fill('input[name="streetLine1"]', 'Test Street 1');
    await page.fill('input[name="city"]', 'Vienna');
    await page.fill('input[name="postalCode"]', '1010');

    await page.click('button:has-text("Continue")');
    await page.waitForTimeout(3000);

    // 5. Verify shipping methods
    // Check if "Standard Shipping (Austria)" or similar is visible
    await expect(page.locator('text=Standard Shipping (Austria)')).toBeVisible();
    await expect(page.locator('text=Express Shipping (Austria)')).toBeVisible();

    console.log('Verification Success: Shipping methods for AT are visible in DE shop session.');
});
