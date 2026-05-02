const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const log = msg => process.stderr.write(msg + '\n');
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/tmp/clubready-downloads';

async function run() {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(40000);

  // Login
  log('Logging in...');
  await page.goto('https://bodyfittraining.clubready.com/');
  await page.fill('#uid', process.env.CLUBREADY_USER);
  await page.fill('#pw', process.env.CLUBREADY_PASS);
  await page.click('input[type="submit"]');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);

  if (!page.url().includes('app.clubready.com')) {
    throw new Error('Login failed — check credentials');
  }

  // Navigate to Reports > Frozen Members
  log('Opening Frozen Members report...');
  await page.goto('https://app.clubready.com/Reporting/ReportViewer');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.menuItem12 a', { state: 'attached', timeout: 30000 });
  await page.evaluate(() => document.querySelector('.menuItem12 a').click());
  await page.waitForTimeout(2000);

  // Click Run Report
  // Frozen Members uses #showReport-81 (not the generic #showReport-0)
  log('Running report...');
  await page.click('#showReport-81');

  // Wait for SSRS iframe to appear in #reportViewer
  log('Waiting for report to render...');
  await page.waitForSelector('#reportViewer iframe', { timeout: 30000 });
  await page.waitForTimeout(15000); // SSRS needs time to fetch and render

  // Find the SSRS frame
  const ssrsFrame = page.frames().find(f => f.url().includes('reportviewer.aspx'));
  if (!ssrsFrame) throw new Error('SSRS frame not found — report may not have rendered');
  log('Report rendered.');

  // Extract ExportUrlBase from SSRS frame JavaScript
  const exportUrlBase = await ssrsFrame.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const s of scripts) {
      const m = s.textContent.match(/"ExportUrlBase":"(.*?)"/);
      if (m) return m[1].replace(/\\u0026/g, '&');
    }
    return null;
  });

  if (!exportUrlBase) throw new Error('ExportUrlBase not found — report session may have expired');

  // Build download URL: change disposition to attachment and set format to CSV
  const csvUrl = 'https://reports.clubready.com' +
    exportUrlBase
      .replace('ContentDisposition=OnlyHtmlInline', 'ContentDisposition=AlwaysAttachment') +
    'CSV';

  // Fetch CSV directly using the browser's session cookies
  log('Downloading CSV...');
  const response = await context.request.get(csvUrl);
  if (!response.ok()) throw new Error(`CSV download failed: HTTP ${response.status()}`);
  const csvBytes = await response.body();

  const date = new Date().toISOString().split('T')[0];
  const filename = `frozen-members-${date}.csv`;
  const savePath = path.join(DOWNLOAD_DIR, filename);
  fs.writeFileSync(savePath, csvBytes);
  log(`Saved: ${savePath}`);

  await browser.close();

  // Write ONLY the file path to stdout so n8n can read it cleanly
  process.stdout.write(savePath);
}

run().catch(err => {
  process.stderr.write('ERROR: ' + err.message + '\n');
  process.exit(1);
});
