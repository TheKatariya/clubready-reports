# ClubReady Report Automation

Headless Playwright scripts that log into ClubReady, extract data, and either download it as CSV or write it directly to MySQL. Runs via Node.js on the server — triggered by n8n on a schedule.

---

## Scripts

| Script | Output | Schedule |
|---|---|---|
| `completed-classes.js` | CSV → Google Drive | Daily 7am ET |
| `booking-events.js` | CSV → Google Drive | Daily |
| `frozen-members.js` | CSV → Google Drive | Daily |
| `member-list.js` | CSV → Google Drive | Daily |
| `lead-activity.js` | MySQL `lead_management_activity` | Daily 2:30am ET |

---

## Quick Start

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Create your credentials file

```bash
cp .env.example .env
```

Edit `.env` with your ClubReady login and (for `lead-activity.js`) MySQL credentials.

### 3. Run a script

```bash
# CSV-output scripts
node -r dotenv/config completed-classes.js

# MySQL-output scripts
node -r dotenv/config lead-activity.js
```

---

## lead-activity.js

Scrapes the Lead Management → Activity view for the previous day and bulk-inserts all rows into MySQL.

### Navigation path

```
https://app.clubready.com/Dashboard/SalesProcess/LeadManagement
  → click #tabactivity (Activity tab)
  → click input[onclick="loadpreviousdate()"] (< button)
  → select All Staff from dropdown
  → extract table
```

### MySQL table

```sql
CREATE TABLE IF NOT EXISTS lead_management_activity (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  activity_date DATE         NOT NULL,
  time          VARCHAR(20)  NOT NULL,
  lead_name     VARCHAR(255) NOT NULL,
  activity      VARCHAR(255) NOT NULL,
  staff_name    VARCHAR(255) NOT NULL,
  status        VARCHAR(100) NOT NULL,
  scraped_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_activity (activity_date, time, lead_name(100), activity(100), staff_name(100))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### Key gotchas

- **Column order** — ClubReady renders `Status | Time | Lead Name | Activity | Staff Name` (Status is first, not last)
- **Table targeting** — the page has many tables (nav, sidebar, dropdowns). Filter rows by anchoring on `cells[1]` matching `/^\d{1,2}:\d{2}\s*(AM|PM)$/i` — this reliably identifies real data rows
- **All Staff dropdown** — no reliable name/id attribute; found via fallback that scans all `<select>` elements for an option with text `All Staff`
- **Bulk insert** — uses a single `INSERT IGNORE ... VALUES ?` with all rows; row-by-row inserts are too slow and will time out the SSH session
- **stdout** — prints the count of inserted rows; n8n reads this as `$json.stdout`

### n8n workflow

```
Schedule Trigger (daily 2:30am ET)  [ID: ZQVcU4pql3nGQ7gp]
  → SSH: Run Script
      command: cd /home/pkatariya/clubready-reports && node -r dotenv/config lead-activity.js
      credential: SSH Tysons01
```

---

## Adding a New CSV Report

### 1. Find the report ID

Open the Reports page in your browser, right-click the target report in the left nav → Inspect. Note the number in `menuItem{N}`.

### 2. Copy the script

```bash
cp completed-classes.js my-new-report.js
```

### 3. Update the selector and filename

```javascript
// Update the CSS class with the new report ID
await page.waitForSelector('.menuItem93 a', { state: 'attached', timeout: 30000 });
await page.evaluate(() => document.querySelector('.menuItem93 a').click());

// Update the filename
const filename = `lost-members-${date}.csv`;
```

### 4. Test it

```bash
cd ~/clubready-reports
node -r dotenv/config my-new-report.js
```

---

## How ClubReady Works (the hard-won knowledge)

### Authentication

ClubReady has two domains. You log in at the studio subdomain but land on the main app:

```
Login:   https://bodyfittraining.clubready.com/
App:     https://app.clubready.com/
Reports: https://reports.clubready.com/  ← SSRS server, separate domain
```

Login form field IDs:
- Username: `#uid`
- Password: `#pw`
- Submit: `input[type="submit"]`

After submitting, verify login succeeded by checking the URL redirected to `app.clubready.com`. If credentials are wrong, it stays on `invalidlogin.asp`.

**Important:** The `.env` password must be quoted if it contains `#`, because dotenv treats `#` as a comment character.
```
CLUBREADY_PASS="your_password"   ✓
CLUBREADY_PASS=your_password     ✗  (truncated at #)
```

---

### Report Navigation (SSRS reports)

The Reports page (`/Reporting/ReportViewer`) renders a left sidebar where every report link has a predictable CSS class: `.menuItem{reportId}`.

Examples:
- Classes Completed → `.menuItem60`
- Lost Members → `.menuItem93`
- Gross Sales → `.menuItem29`

**Clicking the menu item:** The sidebar is scrollable and items are often off-screen, so Playwright's normal `click()` fails with a visibility error. Use a JS click instead:
```javascript
await page.waitForSelector('.menuItem60 a', { state: 'attached', timeout: 30000 });
await page.evaluate(() => document.querySelector('.menuItem60 a').click());
```

---

### The SSRS Iframe (the tricky part)

ClubReady's report viewer is a two-layer iframe setup:

```
app.clubready.com (main page)
  └── #reportViewer > iframe  (src: reports.clubready.com/Reports/Index?reportParams=...)
        └── SSRS frame  (src: reports.clubready.com/reports/reportviewer.aspx?reportParams=...)
```

The SSRS frame is on a **different domain** (`reports.clubready.com`) from the main page. This means:

- You **cannot** detect the inner frame using `waitForFunction` from the main page — cross-origin access throws a SecurityError
- You **can** use `page.frames().find(f => f.url().includes('reportviewer.aspx'))` after waiting for the outer iframe to appear
- You **can** call `ssrsFrame.evaluate(...)` from within the frame's own context

Wait sequence:
```javascript
await page.waitForSelector('#reportViewer iframe', { timeout: 30000 });
await page.waitForTimeout(15000); // SSRS fetches data from an internal server asynchronously
const ssrsFrame = page.frames().find(f => f.url().includes('reportviewer.aspx'));
```

---

### Downloading as CSV (the export trick)

Rather than clicking through the SSRS export dropdown (fragile), extract the export base URL directly from the frame's JavaScript and fetch the CSV using the browser's session cookies:

```javascript
const exportUrlBase = await ssrsFrame.evaluate(() => {
  const scripts = Array.from(document.querySelectorAll('script'));
  for (const s of scripts) {
    const m = s.textContent.match(/"ExportUrlBase":"(.*?)"/);
    if (m) return m[1].replace(/\\u0026/g, '&');
  }
  return null;
});

const csvUrl = 'https://reports.clubready.com' +
  exportUrlBase
    .replace('ContentDisposition=OnlyHtmlInline', 'ContentDisposition=AlwaysAttachment') +
  'CSV';

const response = await context.request.get(csvUrl);
```

---

### stdout vs stderr

All status messages go to **stderr**. Only the result (file path or row count) goes to **stdout**:

```javascript
const log = msg => process.stderr.write(msg + '\n');
process.stdout.write(result); // clean value for n8n to read as $json.stdout
```

---

## File Structure

```
~/clubready-reports/
├── .env                    # credentials (never commit)
├── .env.example
├── completed-classes.js    # Classes Completed by Member → CSV
├── booking-events.js       # Booking events → CSV
├── frozen-members.js       # Frozen members → CSV
├── member-list.js          # Member list → CSV
├── lead-activity.js        # Lead Management Activity → MySQL
├── package.json
└── node_modules/
```

## Environment Variables (.env)

```
# ClubReady login (all scripts)
CLUBREADY_USER=pavan.katariya
CLUBREADY_PASS="..."         # quotes required — password contains #
DOWNLOAD_DIR=/tmp/clubready-downloads

# MySQL (lead-activity.js only)
MYSQL_HOST=100.116.169.44
MYSQL_PORT=49154
MYSQL_USER=n8n
MYSQL_PASS=n8n
MYSQL_DB=n8n
```

---

## n8n Workflows

| Workflow | ID | Schedule |
|---|---|---|
| ClubReady — Completed Classes Daily Export | `cooaRBSaf9d6J4ER` | Daily 7am ET |
| ClubReady — Lead Management Activity Daily Import | `ZQVcU4pql3nGQ7gp` | Daily 2:30am ET |

All workflows SSH into `100.124.184.65` (credential: SSH Tysons01).
