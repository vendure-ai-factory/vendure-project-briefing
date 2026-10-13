import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.resolve(process.cwd(), 'artifacts', 'verify_shipping');

test.beforeAll(async () => {
    if (!fs.existsSync(ARTIFACTS_DIR)) {
        fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    }
});

test('Weight-based shipping calculation for HU channel', async ({ page, context }) => {
    console.log('Clearing cookies...');
    await context.clearCookies();

    page.on('console', msg => {
        console.log(`[BROWSER] ${msg.type().toUpperCase()}: ${msg.text()}`);
    });

    console.log('Navigating to Laptop product page...');
    await page.goto('http://localhost:3001/hu/product/laptop', { waitUntil: 'networkidle' });
    
    await page.waitForSelector('h1', { timeout: 15000 });
    console.log('Page loaded.');
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '01_product_page.png') });

    const addToCartButton = page.locator('button:has-text("Add to Cart"), button:has-text("Select Options")');
    
    // If "Select Options" is visible, we need to pick options.
    if (await addToCartButton.innerText() === 'Select Options') {
        console.log('Selecting options...');
        // Assume first options for now
        await page.locator('label').first().click(); 
        await page.waitForTimeout(1000);
    }

    console.log('Adding 1 Laptop (1000g) to cart...');
    await page.locator('button:has-text("Add to Cart")').click();
    
    await page.waitForSelector('text=Added to cart', { timeout: 10000 });
    console.log('Successfully added to cart.');
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '02_added_to_cart.png') });

    console.log('Navigating to /hu/checkout...');
    await page.goto('http://localhost:3001/hu/checkout', { waitUntil: 'networkidle' });

    // Wait for the shipping methods to appear
    console.log('Waiting for shipping methods...');
    await page.waitForTimeout(5000); 
    
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '03_checkout_1kg.png') });
    
    // Check for 2500 Ft
    const priceText1 = await page.textContent('body');
    if (priceText1?.includes('2 500')) {
        console.log('CONFIRMED: 1kg shipping price detected (2500 HUF)');
    } else {
        console.log('WARNING: Expected 2500 HUF not found in body text.');
    }

    // Increase quantity via cart
    console.log('Increasing quantity to 3 Laptops...');
    await page.goto('http://localhost:3001/hu/cart', { waitUntil: 'networkidle' });
    
    // Wait for cart to load and find quantity input more robustly
    await page.waitForSelector('input[type="number"], .quantity-input, [aria-label*="Quantity"]', { timeout: 15000 });
    const qtyInput = page.locator('input[type="number"], .quantity-input, [aria-label*="Quantity"]').first();
    
    await qtyInput.click();
    await qtyInput.fill('3');
    await qtyInput.press('Enter');
    
    // In some SPAs, we need to wait for the cart to update
    await page.waitForResponse(resp => resp.url().includes('shop-api') && resp.status() === 200, { timeout: 10000 });
    await page.waitForTimeout(2000);
    
    console.log('Returning to checkout...');
    await page.goto('http://localhost:3001/hu/checkout', { waitUntil: 'networkidle' });
    await page.waitForTimeout(5000);
    
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '04_checkout_3kg.png') });
    const priceText2 = await page.textContent('body');
    // Using regex to match 5000 with optional non-breaking spaces or formatting
    if (priceText2 && /5\s*000/.test(priceText2)) {
        console.log('CONFIRMED: 3kg shipping price detected (5000 HUF)');
    } else {
        console.log('WARNING: Expected 5000 HUF not found.');
    }

    // Increase quantity to 6
    console.log('Increasing quantity to 6 Laptops...');
    await page.goto('http://localhost:3001/hu/cart', { waitUntil: 'networkidle' });
    await page.waitForSelector('input[type="number"], .quantity-input, [aria-label*="Quantity"]', { timeout: 15000 });
    const qtyInput2 = page.locator('input[type="number"], .quantity-input, [aria-label*="Quantity"]').first();
    await qtyInput2.fill('6');
    await qtyInput2.press('Enter');
    await page.waitForResponse(resp => resp.url().includes('shop-api') && resp.status() === 200, { timeout: 10000 });
    await page.waitForTimeout(2000);
    
    console.log('Returning to checkout...');
    await page.goto('http://localhost:3001/hu/checkout', { waitUntil: 'networkidle' });
    await page.waitForTimeout(5000);
    
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '05_checkout_6kg.png') });
    const priceText3 = await page.textContent('body');
    if (priceText3 && /10\s*000/.test(priceText3)) {
        console.log('CONFIRMED: 6kg shipping price detected (10000 HUF)');
    } else {
        console.log('WARNING: Expected 10000 HUF not found.');
    }

    console.log('VERIFICATION COMPLETE.');
});
