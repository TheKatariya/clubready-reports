// lead-activity.js
// Scrapes Lead Management > Activity for the previous day from ClubReady
// and inserts all rows into MySQL lead_management_activity table.
//
// Usage:  node -r dotenv/config lead-activity.js
// Output: row count written to stdout; all logs to stderr

const { chromium } = require('playwright');
const mysql = require('mysql2/promise');
const fs = require('fs');

const log = msg => process.stderr.write(`[lead-activity] ${msg}\n`);

async function main() {
  // ── DB connection ──────────────────────────────────────────────
  const db = await mysql.createConnection({
    host:     process.env.MYSQL_HOST     || '100.116.169.44',
    port:     parseInt(process.env.MYSQL_PORT || '49154'),
    user:     process.env.MYSQL_USER     || 'n8n',
    password: process.env.MYSQL_PASS     || 'n8n',
    database: process.env.MYSQL_DB       || 'n8n',
  });
  log('DB connected');

  // ── Browser ────────────────────────────────────────────────────
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page    = await context.newPage();

  try {
    // ── Login ──────────────────────────────────────────────────
    log('Logging in...');
    await page.goto('https://bodyfittraining.clubready.com/', { waitUntil: 'networkidle' });
    await page.fill('#uid', process.env.CLUBREADY_USER);
    await page.fill('#pw',  process.env.CLUBREADY_PASS);
    await page.click('input[type="submit"]');
    await page.waitForURL('**/app.clubready.com/**', { timeout: 15000 });
    log(`Logged in — ${page.url()}`);

    // ── Navigate to Lead Management ────────────────────────────
    log('Navigating to Lead Management...');
    await page.goto('https://app.clubready.com/Dashboard/SalesProcess/LeadManagement', {
      waitUntil: 'networkidle',
    });
    log(`At: ${page.url()}`);

    // ── Click Activity tab ─────────────────────────────────────
    // The tab lives inside div#tabactivity — click the first link/button in it
    log('Clicking Activity tab...');
    await page.waitForSelector('#tabactivity', { state: 'attached', timeout: 15000 });
    await page.evaluate(() => {
      const tab = document.querySelector('#tabactivity a') ||
                  document.querySelector('#tabactivity');
      tab.click();
    });
    await page.waitForTimeout(2000);

    // ── Click previous day ( < ) ───────────────────────────────
    log('Clicking previous day button...');
    await page.waitForSelector('input[onclick="loadpreviousdate()"]', {
      state: 'attached',
      timeout: 10000,
    });
    await page.evaluate(() => {
      document.querySelector('input[onclick="loadpreviousdate()"]').click();
    });
    await page.waitForTimeout(3000);

    // ── Select All Staff ───────────────────────────────────────
    log('Selecting All Staff...');
    // Find the staff dropdown — typically a <select> near the activity table
    const staffDropdown = await page.$('select[name*="staff" i], select[id*="staff" i], select[name*="Staff"], select[id*="Staff"]');
    if (staffDropdown) {
      await staffDropdown.selectOption({ label: 'All Staff' });
      log('All Staff selected via dropdown');
      await page.waitForTimeout(3000);
    } else {
      // Fall back: find any select whose options include "All Staff"
      const selected = await page.evaluate(() => {
        const selects = Array.from(document.querySelectorAll('select'));
        for (const sel of selects) {
          const opt = Array.from(sel.options).find(o => o.text.trim() === 'All Staff');
          if (opt) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      });
      if (selected) {
        log('All Staff selected via fallback');
        await page.waitForTimeout(3000);
      } else {
        log('WARNING: could not find All Staff dropdown — proceeding with whatever is shown');
      }
    }

    // ── Extract table rows ─────────────────────────────────────
    log('Extracting table rows...');
    await page.waitForTimeout(2000);

    const rows = await page.evaluate(() => {
      // Actual ClubReady column order: Status | Time | Lead Name | Activity | Staff Name
      // Anchor on the time column (cells[1]) matching a clock pattern to skip
      // all navigation/sidebar/dropdown tables that appear earlier in the DOM.
      const timePattern = /^\d{1,2}:\d{2}\s*(AM|PM)$/i;

      const allRows = Array.from(document.querySelectorAll('tr'));
      const dataRows = allRows.filter(tr => {
        const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
        return cells.length >= 5 && timePattern.test(cells[1]);
      });

      return dataRows.map(tr => {
        const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
        return {
          status:     cells[0] || '',
          time:       cells[1] || '',
          lead_name:  cells[2] || '',
          activity:   cells[3] || '',
          staff_name: cells[4] || '',
        };
      });
    });

    log(`Found ${rows.length} rows`);

    if (rows.length === 0) {
      log('No rows found — check the page state or selectors');
      process.stdout.write('0');
      return;
    }

    // ── Determine activity date (the date we navigated to = yesterday) ──
    // Parse it from the page if possible, otherwise compute it
    const activityDate = await page.evaluate(() => {
      // Look for a date input or display element that shows the current report date
      const dateInput = document.querySelector('input[name*="date" i][type="text"], input[id*="date" i][type="text"]');
      if (dateInput) return dateInput.value;
      const dateSpan = document.querySelector('[id*="date" i], [class*="date" i]');
      if (dateSpan) return dateSpan.textContent.trim();
      return null;
    });

    let reportDate;
    if (activityDate) {
      // Try to parse whatever format ClubReady uses (M/D/YYYY)
      const parsed = new Date(activityDate);
      reportDate = isNaN(parsed.getTime()) ? yesterdayISO() : toISO(parsed);
    } else {
      reportDate = yesterdayISO();
    }
    log(`Activity date: ${reportDate}`);

    // ── Bulk insert into MySQL ─────────────────────────────────
    const values = rows.map(row => [
      reportDate, row.time, row.lead_name, row.activity, row.staff_name, row.status,
    ]);
    const [result] = await db.query(
      `INSERT IGNORE INTO lead_management_activity
         (activity_date, time, lead_name, activity, staff_name, status)
       VALUES ?`,
      [values]
    );
    const inserted = result.affectedRows;
    log(`Inserted ${inserted} new rows (${rows.length - inserted} duplicates skipped)`);

    process.stdout.write(String(inserted));

  } finally {
    await browser.close();
    await db.end();
    log('Done');
  }
}

function yesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return toISO(d);
}

function toISO(d) {
  return d.toISOString().split('T')[0];
}

main().catch(err => {
  process.stderr.write(`[lead-activity] FATAL: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
