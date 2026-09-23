import { test, expect } from '@playwright/test';

const accounts = [
  { email: 'test1@example.com', country: 'at', name: 'Austria' },
  { email: 'test2@example.com', country: 'hu', name: 'Hungary' },
  { email: 'test3@example.com', country: 'de', name: 'Germany' },
];

for (const account of accounts) {
  test('Verify payment tools for ' + account.name, async ({ page }) => {
    test.setTimeout(180000);
    console.log('--- Checking ' + account.name + ' ---');
    
    // 1. Clear state
    await page.context().clearCookies();
    
    // 2. Sign In
    await page.goto('/' + account.country + '/sign-in');
    
    const emailInput = page.locator('input[type=" email\]');
