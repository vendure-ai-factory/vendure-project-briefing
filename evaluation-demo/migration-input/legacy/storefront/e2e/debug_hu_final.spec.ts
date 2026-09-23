import { test, expect } from '@playwright/test';

test('Hungary Payment Verification', async ({ page, context }) => {
    test.setTimeout(180000);
    await context.clearCookies();
    
    // 1. Login
    await page.goto('/hu/sign-in', { waitUntil: 'networkidle' });
    
    // Safety: Manual clear because model often fails at input
    const emailField = page.locator('input[type=" email\]');
