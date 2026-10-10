import { test, expect } from '@playwright/test';

test('verify orders page', async ({ page }) => {
  // 1. 访问首页并设置国家 (为了通过 middleware)
  await page.goto('http://localhost:3001');
  await page.waitForTimeout(2000);
  
  // 2. 模拟登录 (或者利用现有 Session)
  // 如果已经登录，直接访问 orders 页面
  await page.goto('http://localhost:3001/account/orders');
  await page.waitForTimeout(5000);
  
  // 3. 检查是否重定向到 sign-in
  const url = page.url();
  console.log(`Current URL: ${url}`);
  
  // 4. 截图
  await page.screenshot({ path: 'orders_verify.png', fullPage: true });
  
  // 5. 检查页面内容
  if (url.includes('sign-in')) {
    console.log('Error: Redirected to sign-in page.');
  } else {
    const ordersHeader = await page.textContent('h1');
    console.log(`Page Header: ${ordersHeader}`);
  }
});
