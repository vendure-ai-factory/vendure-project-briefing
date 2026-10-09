import { test } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || path.resolve(process.cwd(), 'artifacts', 'verify_shipping');

test('Capture Admin Shipping Method Configuration', async ({ page }) => {
    if (!fs.existsSync(ARTIFACTS_DIR)) fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

    console.log('Logging into Admin panel...');
    await page.goto('http://localhost:54321/admin', { waitUntil: 'networkidle' });
    
    await page.fill('input[name="username"]', process.env.EVALUATION_ADMIN_USERNAME || 'REPLACE_WITH_EVALUATION_ADMIN_USERNAME');
    await page.fill('input[name="password"]', process.env.EVALUATION_ADMIN_PASSWORD || 'REPLACE_WITH_EVALUATION_ADMIN_PASSWORD');
    await page.click('button[type="submit"]');
    
    await page.waitForTimeout(3000);
    console.log('Navigating to Shipping Methods...');
    await page.goto('http://localhost:54321/admin/settings/shipping-methods', { waitUntil: 'networkidle' });
    
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'admin_shipping_list.png'), fullPage: true });
    
    console.log('Opening Standard Shipping (Hungary)...');
    await page.click('text="Standard Shipping (Hungary)"');
    await page.waitForTimeout(2000);
    
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'admin_shipping_detail_hu.png'), fullPage: true });
    
    console.log('DONE.');
});
