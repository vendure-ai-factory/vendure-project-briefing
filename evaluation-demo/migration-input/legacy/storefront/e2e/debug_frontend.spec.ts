import { test } from '@playwright/test';
import * as fs from 'fs';

test('Capture Frontend Errors', async ({ page }) => {
    const errorLogs: string[] = [];
    const requestErrors: string[] = [];

    page.on('console', msg => {
        if (msg.type() === 'error') {
            errorLogs.push(`[CONSOLE ERROR] ${msg.text()}`);
        }
    });

    page.on('pageerror', error => {
        errorLogs.push(`[PAGE ERROR] ${error.message}\n${error.stack}`);
    });

    page.on('requestfailed', request => {
        requestErrors.push(`[REQUEST FAILED] ${request.url()}: ${request.failure()?.errorText}`);
    });

    try {
        // 1. Authenticate (using test2 as it was the HU account)
        await page.goto('/hu/sign-in', { waitUntil: 'networkidle' });
        await page.locator('input[type="email"]').fill('test2@example.com');
        await page.locator('input[type="password"]').fill(process.env.EVALUATION_ADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD');
        await page.locator('button[type="submit"]').click();
        await page.waitForTimeout(3000);

        // 2. Go to product and add to cart to ensure checkout is accessible
        await page.goto('/hu', { waitUntil: 'networkidle' });
        const product = page.locator('a[href*="/product/"]').first();
        if (await product.isVisible()) {
            await product.click();
            await page.waitForLoadState('networkidle');
            const addToCart = page.getByRole('button', { name: /Add to Cart/i });
            if (await addToCart.isVisible()) {
                await addToCart.click();
                await page.waitForTimeout(2000);
            }
        }

        // 3. Navigate to checkout
        console.log('Navigating to checkout...');
        await page.goto('/hu/checkout', { waitUntil: 'networkidle' });
        await page.waitForTimeout(5000); // Wait for potential crashes

        // Save logs
        const results = {
            url: page.url(),
            consoleErrors: errorLogs,
            requestErrors: requestErrors,
            content: await page.content()
        };
        fs.writeFileSync('test-results/frontend_debug.json', JSON.stringify(results, null, 2));
        await page.screenshot({ path: 'test-results/frontend_error_capture.png' });

    } catch (e) {
        errorLogs.push(`[TEST SCRIPT ERROR] ${e.message}`);
        fs.writeFileSync('test-results/frontend_debug.json', JSON.stringify({ errorLogs, requestErrors }, null, 2));
    }
});
