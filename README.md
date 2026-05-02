# ClubReady Report Automation

Headless Playwright script that logs into ClubReady, runs a report, and downloads it as a CSV. Ships as a Docker container — no Node.js, Playwright, or browser install required.

---

## Quick Start (Docker)

### 1. Install Docker

Download and install [Docker Desktop](https://www.docker.com/products/docker-desktop/).

### 2. Build the image

```bash
docker build -t clubready-reports .
```

This downloads the base image (~1.5 GB on first run) and installs dependencies. Subsequent builds are fast.

### 3. Create your credentials file

Copy the example and fill in your ClubReady login:

```bash
cp .env.example .env
```

Edit `.env`:

```
CLUBREADY_USER=your_username
CLUBREADY_PASS="your_password"   # keep the quotes — required if password contains #
DOWNLOAD_DIR=/output
```

### 4. Run it

```bash
docker run --rm \
  --env-file .env \
  -v "$(pwd)/output:/output" \
  clubready-reports
```

The CSV lands in `./output/completed-classes-YYYY-MM-DD.csv`.

**Windows (PowerShell):**
```powershell
docker run --rm `
  --env-file .env `
  -v "${PWD}/output:/output" `
  clubready-reports
```

### Passing credentials without a .env file

```bash
docker run --rm \
  -e CLUBREADY_USER=pavan.katariya \
  -e CLUBREADY_PASS="4@e9NtK#K*R3V*K8" \
  -v "$(pwd)/output:/output" \
  clubready-reports
```

---

## Output

- **stdout** — the full path to the saved CSV (used by automation tools like n8n)
- **stderr** — progress logs (`Logging in...`, `Running report...`, etc.)
- **exit code 1** — on any error, with a message on stderr

---

## Adding a New Report

### 1. Find the report ID

Open the Reports page in your browser, right-click the target report in the left nav → Inspect. Note the number in `menuItem{N}`.

### 2. Copy the script

```bash
cp completed-classes.js my-new-report.js
```

### 3. Update the selector and filename

Change two things in the new script:

```javascript
// Update the CSS class with the new report ID
await page.waitForSelector('.menuItem93 a', { state: 'attached', timeout: 30000 });
await page.evaluate(() => document.querySelector('.menuItem93 a').click());

// Update the filename
const filename = `lost-members-${date}.csv`;
```

### 4. Add it to the Dockerfile

```dockerfile
COPY my-new-report.js ./
```

And rebuild:

```bash
docker build -t clubready-reports .
docker run --rm --env-file .env -v "$(pwd)/output:/output" clubready-reports node -r dotenv/config my-new-report.js
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
CLUBREADY_PASS="4@e9NtK#K*R3V*K8"   ✓
CLUBREADY_PASS=4@e9NtK#K*R3V*K8     ✗  (truncated at #)
```

---

### Report Navigation

The Reports page (`/Reporting/ReportViewer`) renders a left sidebar where every report link has a predictable CSS class: `.menuItem{reportId}`.

Examples:
- Classes Completed → `.menuItem60`
- Lost Members → `.menuItem93`
- Gross Sales → `.menuItem29`

**Finding a report's ID:** Open the Reports page, right-click the report in the left nav, Inspect Element. You'll see something like:
```html
<li class="menuItem menuItem60 cr-sidenav-item-active">
  <a href="javascript:loadReportParams(60, 0, '')">Classes Completed</a>
</li>
```
The number in `menuItem{N}` and `loadReportParams({N}, ...)` is the report ID.

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

Rather than clicking through the SSRS export dropdown (fragile), the script extracts the export base URL directly from the frame's JavaScript and fetches the CSV programmatically using the browser's session cookies:

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

## n8n Workflow Architecture

```
Schedule Trigger (daily 7am ET)
  → SSH: Run Docker Container
      command: docker run --rm --env-file /home/pkatariya/clubready-reports/.env \
               -v /tmp/clubready-downloads:/output clubready-reports
      → stdout: /output/completed-classes-YYYY-MM-DD.csv
  → SSH: Download CSV from Server
      path: ={{ $json.stdout.trim() }}
  → Google Drive: Upload
      folder: 1pPGf6hVCC47MwTSOQKXFb0mh37UZo95y
```

---

## File Structure

```
.
├── Dockerfile
├── .dockerignore
├── .env.example          # copy to .env and fill in credentials
├── completed-classes.js  # Classes Completed by Member report
├── package.json
└── package-lock.json
```
