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

  log('Opening Booking Events report...');
  await page.goto('https://app.clubready.com/Reporting/ReportViewer');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.menuItem114 a', { state: 'attached', timeout: 30000 });
  await page.evaluate(() => document.querySelector('.menuItem114 a').click());

  // Wait for the report form + date widget to render
  await page.waitForSelector('#fromdate', { state: 'attached', timeout: 15000 });
  await page.waitForSelector('#EventType', { timeout: 15000 });

  // Set both date inputs to today (M/D/YYYY — ClubReady's format)
  const now = new Date();
  const todayStr = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;
  log(`Setting date to: ${todayStr}`);

  await page.evaluate((d) => {
    document.querySelector('#fromdate').value = d;
    document.querySelector('#todate').value = d;
  }, todayStr);

  // Select EventType = 3 (Logged as Complete)
  log('Setting EventType = 3 (Logged as Complete)...');
  await page.selectOption('#EventType', '3');

  log('Running report...');
  await page.click('#showReport-0');

  log('Waiting for report to render...');
  await page.waitForSelector('#reportViewer iframe', { timeout: 30000 });
  await page.waitForTimeout(15000);

  const ssrsFrame = page.frames().find(f => f.url().includes('reportviewer.aspx'));
  if (!ssrsFrame) throw new Error('SSRS frame not found — report may not have rendered');
  log('Report rendered.');

  const exportUrlBase = await ssrsFrame.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const s of scripts) {
      const m = s.textContent.match(/"ExportUrlBase":"(.*?)"/);
      if (m) return m[1].replace(/\\u0026/g, '&');
    }
    return null;
  });

  if (!exportUrlBase) throw new Error('ExportUrlBase not found — report session may have expired');

  const csvUrl = 'https://reports.clubready.com' +
    exportUrlBase
      .replace('ContentDisposition=OnlyHtmlInline', 'ContentDisposition=AlwaysAttachment') +
    'CSV';

  log('Downloading CSV...');
  const response = await context.request.get(csvUrl);
  if (!response.ok()) throw new Error(`CSV download failed: HTTP ${response.status()}`);
  const csvBytes = await response.body();

  const date = now.toISOString().split('T')[0];
  const filename = `booking-events-${date}.csv`;
  const savePath = path.join(DOWNLOAD_DIR, filename);
  fs.writeFileSync(savePath, csvBytes);
  log(`Saved: ${savePath}`);

  await browser.close();
  process.stdout.write(savePath);
}

run().catch(err => {
  process.stderr.write('ERROR: ' + err.message + '\n');
  process.exit(1);
});
