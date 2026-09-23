import { test, expect } from '@playwright/test';

test('Debug identity and handshake logic', async ({ page, context }) => {
    // 1. Capture console logs
    page.on('console', msg => {
        console.log(`[BROWSER_${msg.type().toUpperCase()}] ${msg.text()}`);
    });

    // 2. Login as test1@example.com (Who we know is HU)
    console.log('--- Step 1: Login at /de/sign-in ---');
    await page.goto('/de/sign-in', { waitUntil: 'load' });
    await page.getByLabel('Email').fill('test1@example.com');
    await page.getByLabel('Password').fill(process.env.EVALUATION_TEST_PASSWORD || 'REPLACE_WITH_EVALUATION_TEST_PASSWORD');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    
    // 3. Wait for redirect
    await page.waitForURL('http://localhost:3001/**', { timeout: 15000 });
    console.log('Login successful, redirected to home.');

    // 4. Stay at /de/ and wait for Handshake useEffect
    console.log('Waiting for Handshake detection at /de/...');
    await page.waitForTimeout(5000);

    // 5. Take a screenshot to see if the popup is there
    await page.screenshot({ path: 'debug-identity-check.png' });
    
    const bodyText = await page.innerText('body');
    console.log('Body Text Snippet (first 500 chars):', bodyText.substring(0, 500));
    
    // 6. Check for Handshake popup
    const handshakePopup = page.locator('text=检测到地区切换');
    const isVisible = await handshakePopup.isVisible();
    console.log(`Handshake Popup Visible: ${isVisible}`);

    if (isVisible) {
        console.log('SUCCESS: Handshake popup located!');
    } else {
        console.log('FAILURE: Handshake popup NOT found.');
    }
});
