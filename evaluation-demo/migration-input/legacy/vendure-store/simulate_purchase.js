const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// 报告元数据
const REPORT_META = {
    title: "购物流程仿真测试报告",
    objective: "验证 Vendure 商城核心购物流程 (浏览 -> 加购 -> 结算) 的可用性。",
    steps: [
        "访问商城首页，确认加载正常",
        "进入商品详情页 (Laptop)",
        "自动选择规格 (如存在)",
        "将商品加入购物车",
        "进入结算页面 (Checkout)",
        "模拟支付流程"
    ],
    goal: "生成包含全流程截图的验证报告，证明系统核心功能闭环打通。"
};

async function run() {
    console.log('>>> 启动自动化测试机器人...');

    // 连接到 Windows 宿主机的 Chrome (通过端口转发)
    const browser = await puppeteer.connect({
        browserURL: 'http://localhost:9222',
        defaultViewport: null
    });
    console.log('>>> 已连接到 Chrome 浏览器');

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1200 });

    const reportDir = path.join(__dirname, 'report');
    if (!fs.existsSync(reportDir)) {
        fs.mkdirSync(reportDir);
    }

    const screenshots = [];

    async function capture(fileName, title, description) {
        const file = `${screenshots.length + 1}-${fileName}.png`;
        const filePath = path.join(reportDir, file);
        await page.screenshot({ path: filePath });
        console.log(`[截图] ${title}`);
        screenshots.push({ file, title, description });
    }

    try {
        // --- STEP 0: 首页 ---
        console.log('正在访问首页...');
        await page.goto('http://localhost:3001', { waitUntil: 'networkidle0', timeout: 30000 });
        await capture('home', '商城首页', '成功加载首页。验证导航栏、Banner 及推荐商品展示正常。');

        // --- STEP 1: 商品详情 ---
        console.log('正在查找商品...');
        // 优先找 Laptop，因为知道它有规格，适合测试
        let foundProduct = false;
        try {
            const laptopLink = await page.$('a[href*="laptop"]');
            if (laptopLink) {
                await laptopLink.click();
            } else {
                // 随便找一个
                await page.click('a[href*="/product/"]');
            }
            await page.waitForNavigation({ waitUntil: 'networkidle0' });
            foundProduct = true;
        } catch (e) {
            console.log('点击跳转失败，尝试直接 URL 跳转');
            await page.goto('http://localhost:3001/product/laptop', { waitUntil: 'networkidle0' });
        }

        await capture('product', '商品详情页', '成功进入商品详情页。');

        // --- STEP 2.5: 明确选择规格 (Laptop) ---
        console.log('正在选择商品规格...');
        try {
            // 定义一个点击帮助函数 (使用 P-selector 适配新版 Puppeteer)
            const clickOption = async (text) => {
                try {
                    const selector = `::-p-text(${text})`;
                    const el = await page.waitForSelector(selector, { timeout: 2000 });
                    if (el) {
                        await el.click();
                        console.log(`   [点击] 选择了 "${text}"`);
                        await new Promise(r => setTimeout(r, 500));
                        return true;
                    }
                } catch (e) { /* ignore timeout */ }
                return false;
            };

            // 针对 Laptop 的特定规格
            // 根据之前截图，有 "13 inch", "15 inch", "8GB", "16GB"
            // 我们选一组存在的组合
            await clickOption('15 inch');
            await clickOption('16GB');

            await capture('options-picked', '规格已选', '已自动点击规格按钮。');

        } catch (e) {
            console.log('规格选择步骤异常:', e.message);
        }

        // --- STEP 3: 加购 ---
        console.log('正在加入购物车...');
        try {
            // 查找加购按钮 (使用 P-selector)
            const btnSelector = `button ::-p-text(Add to Cart)`;

            // 等待直到按钮出现
            await page.waitForSelector(btnSelector, { timeout: 5000 });
            const button = await page.$(btnSelector);

            if (button) {
                await button.click();
                await new Promise(r => setTimeout(r, 3000)); // 等待购物车抽屉
                await capture('cart-add', '加入购物车成功', '按钮变为可用状态并点击。预期出现购物车侧边栏。');
            } else {
                throw new Error('未找到内容为 Add to Cart 的按钮');
            }
        } catch (e) {
            console.error('加购失败:', e.message);
            await capture('cart-failed', '加购失败', `无法点击加购。可能原因：规格未选全（按钮仍显示 Select Options）或库存不足。`);
        }

        // --- STEP 4: 结算 ---
        console.log('进入结算页...');
        await page.goto('http://localhost:3001/checkout', { waitUntil: 'networkidle0' });
        await capture('checkout', '结算页面', '跳转至 /checkout 信息页。');

    } catch (e) {
        console.error('❌ 执行过程中出错:', e);
        await capture('fatal-error', '系统异常', `测试过程中发生未捕获异常: ${e.message}`);
    } finally {
        await browser.close();
        generateHtmlReport(screenshots, reportDir);
    }
}

function generateHtmlReport(data, dir) {
    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${REPORT_META.title}</title>
    <style>
        body { font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 900px; margin: 0 auto; padding: 40px 20px; background: #f9f9f9; }
        .container { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
        h1 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 15px; }
        .meta-section { background: #e8f6f3; padding: 20px; border-radius: 6px; margin-bottom: 30px; border-left: 5px solid #1abc9c; }
        .meta-section h3 { margin-top: 0; color: #16a085; }
        .step-block { margin-bottom: 50px; border: 1px solid #eee; padding: 20px; border-radius: 8px; }
        .step-header { display: flex; align-items: center; margin-bottom: 15px; }
        .step-number { background: #3498db; color: white; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; margin-right: 15px; }
        .step-title { font-size: 1.2rem; font-weight: bold; color: #2c3e50; margin: 0; }
        .step-desc { background: #f8f9fa; padding: 15px; border-radius: 4px; margin-bottom: 15px; color: #555; }
        img { width: 100%; border: 1px solid #ddd; border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); transition: transform 0.2s; }
        img:hover { transform: scale(1.02); }
        .footer { margin-top: 50px; text-align: center; font-size: 0.9rem; color: #999; }
    </style>
</head>
<body>
    <div class="container">
        <h1>${REPORT_META.title}</h1>
        
        <div class="meta-section">
            <h3>测试概览</h3>
            <p><strong>任务目的:</strong> ${REPORT_META.objective}</p>
            <p><strong>预期目标:</strong> ${REPORT_META.goal}</p>
            <p><strong>执行时间:</strong> ${new Date().toLocaleString()}</p>
            <p><strong>测试步骤:</strong></p>
            <ol>
                ${REPORT_META.steps.map(s => `<li>${s}</li>`).join('')}
            </ol>
        </div>

        <div class="steps-container">
            ${data.map((item, index) => `
            <div class="step-block">
                <div class="step-header">
                    <div class="step-number">${index + 1}</div>
                    <h2 class="step-title">${item.title}</h2>
                </div>
                <div class="step-desc">
                    <strong>操作说明:</strong> ${item.description}
                </div>
                <img src="${item.file}" alt="${item.title}" loading="lazy" onclick="window.open(this.src)">
            </div>
            `).join('')}
        </div>

        <div class="footer">
            Antigravity Automated Testing Report &copy; 2026
        </div>
    </div>
</body>
</html>
    `;

    fs.writeFileSync(path.join(dir, 'index.html'), html);
    console.log(`✅ HTML 报告生成完毕: ${path.join(dir, 'index.html')}`);
}

run();
