const puppeteer = require('puppeteer');

(async () => {
    console.log('>>> Starting Puppeteer Bridge Test...');
    try {
        // Connect to the Windows Chrome instance via the WSL Proxy
        // Proxy Listen: 0.0.0.0:9222 -> Windows:9222
        console.log('1. Connecting to browser at http://localhost:9222...');
        const browser = await puppeteer.connect({
            browserURL: 'http://localhost:9222',
            defaultViewport: null
        });
        console.log('   [SUCCESS] Connected to Chrome!');

        console.log('2. Opening Product Page (http://localhost:3001/product/laptop)...');
        const page = await browser.newPage();

        // Use a generous timeout
        await page.goto('http://localhost:3001/product/laptop', {
            waitUntil: 'networkidle0',
            timeout: 30000
        });
        console.log('   [SUCCESS] Page Loaded. Title:', await page.title());

        // 3. Check for the button
        console.log('3. Searching for "Add to Cart" button...');
        const btnSelector = `//button[contains(., 'Add to Cart')]`;

        // Wait briefly
        try {
            await page.waitForXPath(btnSelector, { timeout: 5000 });
            const elements = await page.$x(btnSelector);
            if (elements.length > 0) {
                console.log('   [FOUND!] "Add to Cart" button is visible.');
                // Highlight it to prove control
                await page.evaluate((el) => el.style.border = '5px solid red', elements[0]);
                console.log('   (I have highlighted it in RED on your screen)');
            } else {
                console.log('   [MISSING] XPath returned empty list.');
            }
        } catch (e) {
            console.log('   [MISSING] Timeout waiting for selector.');
        }

        // Dump page content for debugging if missing
        // const html = await page.content();
        // console.log('HTML Dump Length:', html.length);

        console.log('4. keeping connection open for 5s...');
        await new Promise(r => setTimeout(r, 5000));

        await browser.disconnect();
        console.log('>>> Test Complete.');

    } catch (error) {
        console.error('!!! TEST FAILED !!!');
        console.error(error);
        process.exit(1);
    }
})();
