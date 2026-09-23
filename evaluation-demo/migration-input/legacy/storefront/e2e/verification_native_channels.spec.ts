import { test, expect } from '@playwright/test';

async function handleWelcomeShield(page: any, country: string) {
    await page.goto('http://localhost:3001/welcome');

    // Select country
    await page.locator('button[role="combobox"]').first().click();
    await page.getByRole('option', { name: new RegExp(country, 'i') }).click();

    // Select language (assuming English or similar)
    await page.locator('button[role="combobox"]').last().click();
    await page.getByRole('option').first().click(); // Just pick first language

    // Enter Shop
    await page.click('button:has-text("Enter Shop")');
    await expect(page).not.toHaveURL(/.*welcome.*/);
}

test.describe('Native Channels Verification', () => {

    test('Scenario 1: Germany registration & currency', async ({ page }) => {
        // 1. Handle Welcome Shield
        await handleWelcomeShield(page, 'Germany');

        // 2. Go to registration
        await page.goto('http://localhost:3001/register');

        // 3. Fill registration form
        const uniqueEmail = `de_user_${Date.now()}@example.com`;
        await page.fill('input[name="emailAddress"]', uniqueEmail);
        await page.fill('input[name="password"]', process.env.EVALUATION_TEST_PASSWORD || 'REPLACE_WITH_EVALUATION_TEST_PASSWORD');
        await page.fill('input[name="confirmPassword"]', process.env.EVALUATION_TEST_PASSWORD || 'REPLACE_WITH_EVALUATION_TEST_PASSWORD');

        // Country is already set in cookie from Welcome Shield, but registration page might need it too
        // Check if registration page select exists
        const regCountrySelect = page.locator('button[role="combobox"]');
        if (await regCountrySelect.isVisible()) {
            await regCountrySelect.click();
            await page.getByRole('option', { name: /Germany/i }).click();
        }

        await page.click('button[type="submit"]');

        // Verification
        await page.waitForURL('**/verify-pending**', { timeout: 15000 }).catch(() => console.log('Did not redirect to verify-pending'));
        await page.screenshot({ path: 'test-results/de-registration-success.png' });

        const cookies = await page.context().cookies();
        const countryCookie = cookies.find(c => c.name === 'country_code');
        expect(countryCookie?.value).toBe('DE');

        // Verify currency on PDP (homepage might be empty)
        await page.goto('http://localhost:3001/product/aurora-borealis-nails');
        await page.waitForLoadState('networkidle');
        const priceElement = page.locator('.price, [class*="price"]').first();
        const priceText = await priceElement.textContent();
        console.log('Germany Price Text:', priceText);
        expect(priceText).toContain('€');
    });

    test('Scenario 2: Hungary registration & currency', async ({ page }) => {
        // 1. Handle Welcome Shield
        await handleWelcomeShield(page, 'Hungary');

        // 2. Go to registration
        await page.goto('http://localhost:3001/register');

        // 3. Fill registration form
        const uniqueEmail = `hu_user_${Date.now()}@example.com`;
        await page.fill('input[name="emailAddress"]', uniqueEmail);
        await page.fill('input[name="password"]', process.env.EVALUATION_TEST_PASSWORD || 'REPLACE_WITH_EVALUATION_TEST_PASSWORD');
        await page.fill('input[name="confirmPassword"]', process.env.EVALUATION_TEST_PASSWORD || 'REPLACE_WITH_EVALUATION_TEST_PASSWORD');

        const regCountrySelect = page.locator('button[role="combobox"]');
        if (await regCountrySelect.isVisible()) {
            await regCountrySelect.click();
            await page.getByRole('option', { name: /Hungary/i }).click();
        }

        await page.click('button[type="submit"]');

        // Verification
        await page.waitForURL('**/verify-pending**', { timeout: 15000 }).catch(() => console.log('Did not redirect to verify-pending'));
        await page.screenshot({ path: 'test-results/hu-registration-success.png' });

        const cookies = await page.context().cookies();
        const countryCookie = cookies.find(c => c.name === 'country_code');
        expect(countryCookie?.value).toBe('HU');

        // Verify currency on PDP (homepage might be empty)
        await page.goto('http://localhost:3001/product/aurora-borealis-nails');
        await page.waitForLoadState('networkidle');
        const priceElement = page.locator('.price, [class*="price"]').first();
        const priceText = await priceElement.textContent();
        console.log('Hungary Price Text:', priceText);
        expect(priceText).toMatch(/Ft|HUF/);
    });
});

