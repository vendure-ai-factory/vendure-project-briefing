import { chromium } from 'playwright';
import path from 'node:path';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies([{name: 'country_code', value: 'HU', url: 'http://localhost:3001'}]);
  const page = await context.newPage();
  
  console.log('Navigating to homepage...');
  await page.goto('http://localhost:3001');
  await page.waitForTimeout(3000);
  
  console.log('Looking for a product link...');
  const productLink = await page.$('a[href^="/product/"]');
  if (productLink) {
    const href = await productLink.getAttribute('href');
    console.log('Clicked product link: ' + href);
    await productLink.click();
  } else {
    console.log('Fallback: navigating to a known product...');
    await page.goto('http://localhost:3001/product/nail-design-16');
  }
  
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);

  const screenshotPath = process.env.SCREENSHOT_PATH || path.resolve(process.cwd(), 'artifacts', 'verify_huf_final.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log('Screenshot saved to artifact directory: ' + screenshotPath);
  
  const bodyText = await page.evaluate(() => document.body.innerText);
  if (bodyText.includes('Ft') || bodyText.includes('HUF')) {
    console.log('SUCCESS: "Ft" or "HUF" found on the page.');
  } else {
    console.log('FAILURE: Currency indicator not found.');
    console.log(bodyText.substring(0, 500));
  }

  await browser.close();
})();
