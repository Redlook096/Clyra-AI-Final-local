const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.connect({
    browserURL: 'http://localhost:9222'
  });
  const pages = await browser.pages();
  const page = pages[0];
  
  await page.reload({ waitUntil: 'networkidle0', timeout: 10000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/opt/cursor/artifacts/companion-web-fullbleed.webp', type: 'webp' });
  
  console.log('Screenshot saved');
  await browser.disconnect();
})();
