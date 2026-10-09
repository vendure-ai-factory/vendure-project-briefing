// e2e/merge-order.spec.ts
import { test, expect } from '@playwright/test';

test('Order Merge Flow Simulation', async ({ page }) => {
    // 1. Log in to the application
    await page.goto('http://localhost:3000/login'); // Adjust URL as per storefront routing

    // Fill in login details (assuming an existing account for simulation)
    await page.fill('input[name="email"]', 'admin@medusa.com');
    await page.fill('input[name="password"]', process.env.EVALUATION_ADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD');
    await page.click('button[type="submit"]');

    // Wait for login to complete
    await page.waitForTimeout(2000);

    // 2. Add first item to cart and checkout (Order 1 -> PaymentAuthorized)
    await page.goto('http://localhost:3000/products'); // Adjust URL
    // Click first product
    await page.locator('.product-card').first().click();
    // Click Add to Cart
    await page.click('button:has-text("Add to cart")');
    await page.waitForTimeout(1000);

    // Go to Cart and Checkout
    await page.goto('http://localhost:3000/cart');
    await page.click('a:has-text("Checkout")');

    // Proceed through checkout process (mocked steps)
    await page.fill('input[name="firstName"]', 'Test');
    await page.fill('input[name="lastName"]', 'User');
    await page.fill('input[name="streetLine1"]', '123 E2E Street');
    await page.fill('input[name="city"]', 'Berlin');
    await page.fill('input[name="postalCode"]', '10115');
    await page.click('button:has-text("Next")'); // To Shipping
    await page.waitForTimeout(1000);

    await page.click('button:has-text("Next")'); // To Payment
    await page.waitForTimeout(1000);

    await page.click('button:has-text("Place order")');
    await page.waitForSelector('text="Thank you for your order"');

    // 3. Add second item to cart
    await page.goto('http://localhost:3000/products');
    // Click second product
    await page.locator('.product-card').nth(1).click();
    await page.click('button:has-text("Add to cart")');
    await page.waitForTimeout(1000);

    // 4. Go to Cart and trigger Merge
    await page.goto('http://localhost:3000/cart');

    // Verify the merge prompt is visible
    await expect(page.locator('text="您有一个已经支付但尚未发货的订单"')).toBeVisible();

    // Click Merge
    await page.click('button:has-text("合并订单 (Merge Orders)")');

    // Wait for page reload/update
    await page.waitForTimeout(3000);

    // Verify successful merge (e.g., total price updated, prompt is gone)
    await expect(page.locator('text="您有一个已经支付但尚未发货的订单"')).toBeHidden();

    // Verify cart contains > 1 item meaning it successfully merged
    const itemsCount = await page.locator('.cart-item').count();
    expect(itemsCount).toBeGreaterThan(1);

    console.log('Merge Order Simulation Completed Successfully.');
});
