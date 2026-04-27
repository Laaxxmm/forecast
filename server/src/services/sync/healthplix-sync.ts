import { chromium, type Page, type BrowserContext, type FrameLocator, type Locator } from 'playwright';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

export interface SyncOptions {
  username: string;
  password: string;
  clinicName: string;
  fromDate: string; // YYYY-MM-DD
  toDate: string;   // YYYY-MM-DD
  onProgress?: (step: string, message: string, pct: number) => void;
  headless?: boolean;
}

export interface SyncResult {
  filePath: string;
  filename: string;
}

const TIMEOUT = 45_000;

function progress(opts: SyncOptions, step: string, msg: string, pct: number) {
  opts.onProgress?.(step, msg, pct);
}

/**
 * Parse a date string YYYY-MM-DD into { year, month (1-12), day }
 */
function parseDate(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { year: y, month: m, day: d };
}

/**
 * Month names as they appear in Healthplix calendar headers
 */
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

/**
 * Locate the from/to date input on the Healthplix report page.
 *
 * Healthplix has historically used `name="fdate"`/`name="tdate"` and
 * `class="report_from_date"`/`class="report_to_date"` on these inputs, but
 * vendor markup is not a stable contract — they rename freely. This helper
 * probes a wide list of candidate selectors against the main page first,
 * then falls back to iframes (some report viewers are embedded).
 *
 * Returns the located input AND the scope it was found in, so the calendar
 * popup can be searched in the same context (jQuery-style pickers render the
 * popup inside the iframe; React portals render at the document root).
 */
async function findDateInputScope(
  page: Page,
  kind: 'from' | 'to',
): Promise<{ locator: Locator; scope: Page | FrameLocator }> {
  const isFrom = kind === 'from';
  const candidates = isFrom
    ? [
        // Existing (legacy jQuery / php conventions)
        'input[name="fdate"]',
        'input.report_from_date',
        // Name variants
        'input[name*="from" i]',
        'input[name*="start" i]',
        'input[name*="frmDate" i]',
        'input[name*="from_date" i]',
        // Class variants
        'input[class*="from" i][class*="date" i]',
        'input[class*="start" i][class*="date" i]',
        // Placeholder-based (existing comment notes "placeholder DD-MMM-YYYY")
        'input[readonly][placeholder*="DD" i]',
        'input[placeholder*="From" i]',
        'input[placeholder*="Start" i]',
        // id / data-testid
        'input[id*="from" i][id*="date" i]',
        '[data-testid*="from-date" i]',
        '[data-testid*="start-date" i]',
        // ARIA
        'input[aria-label*="from" i]',
        'input[aria-label*="start" i]',
        // React/MUI/AntD wrappers
        '.ant-picker input:first-of-type',
        '[class*="MuiInputBase"] input[aria-label*="from" i]',
        '.react-datepicker__input-container input',
      ]
    : [
        // Existing
        'input[name="tdate"]',
        'input.report_to_date',
        // Name variants
        'input[name*="toDate" i]',
        'input[name*="to_date" i]',
        'input[name*="end" i]',
        // Class variants
        'input[class*="to" i][class*="date" i]',
        'input[class*="end" i][class*="date" i]',
        // Placeholder-based
        'input[placeholder*="To" i]',
        'input[placeholder*="End" i]',
        // id / data-testid
        'input[id*="to" i][id*="date" i]',
        '[data-testid*="to-date" i]',
        '[data-testid*="end-date" i]',
        // ARIA
        'input[aria-label*="to" i]',
        'input[aria-label*="end" i]',
        // React/MUI/AntD wrappers
        '.ant-picker input:nth-of-type(2)',
        '[class*="MuiInputBase"] input[aria-label*="to" i]',
      ];

  // Probe a scope (Page or FrameLocator) using a single combined CSS selector.
  // .first() resolves to the first match in document order.
  const probe = async (scope: Page | FrameLocator): Promise<Locator | null> => {
    const combined = candidates.join(', ');
    try {
      const loc = scope.locator(combined).first();
      await loc.waitFor({ state: 'visible', timeout: 5000 });
      return loc;
    } catch {
      return null;
    }
  };

  // 1. Try the main page first.
  let found = await probe(page);
  if (found) return { locator: found, scope: page };

  // 2. Fall back to iframes, in DOM order.
  const iframeCount = await page.locator('iframe').count().catch(() => 0);
  for (let i = 0; i < iframeCount; i++) {
    const frameLocator = page.frameLocator('iframe').nth(i);
    found = await probe(frameLocator);
    if (found) return { locator: found, scope: frameLocator };
  }

  throw new Error(
    `Couldn't find the '${kind}' date input on the Healthplix report page. ` +
    `The Healthplix UI may have changed. ` +
    `Check the saved screenshot/HTML at /uploads/debug/hp-error-<ts>.{png,html}.`,
  );
}

/**
 * Navigate the Healthplix calendar popup to a specific date.
 * Assumes the calendar popup is already open.
 *
 * `scope` is where the trigger input lives (Page or FrameLocator). The popup
 * itself usually renders in the same scope, but React-portal-based pickers
 * render at the document root regardless — so we probe `scope` first, then
 * fall back to `page` for the popup.
 */
async function selectDateInCalendar(
  scope: Page | FrameLocator,
  page: Page,
  targetDate: { year: number; month: number; day: number },
) {
  // Pick the scope where the calendar popup actually rendered. Try the input's
  // scope first (in-iframe / inline pickers), fall back to page (React portals).
  const popupSelectors = '.datepicker, .calendar, [class*="calendar"], [class*="datepicker"], .react-datepicker, .MuiPickersCalendar-root, [role="dialog"]';
  let popupScope: Page | FrameLocator = scope;
  try {
    await scope.locator(popupSelectors).first().waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    if (scope !== page) {
      try {
        await page.locator(popupSelectors).first().waitFor({ state: 'visible', timeout: 1500 });
        popupScope = page;
      } catch {
        // Popup not found anywhere; some inline pickers don't have a discrete popup. Continue.
      }
    }
  }

  // Give calendar a moment to render
  await page.waitForTimeout(500);

  // Try to navigate to the correct month/year
  // Healthplix may use different calendar implementations, so try multiple strategies
  const maxAttempts = 36; // max 3 years of navigation
  for (let i = 0; i < maxAttempts; i++) {
    // Read the current month/year displayed in the calendar header.
    // We route through `body` so the same call works for both Page and FrameLocator scopes.
    const headerText = await popupScope.locator('body').evaluate((body) => {
      const selectors = [
        '.datepicker-switch', '.react-datepicker__current-month',
        '.MuiPickersCalendarHeader-label',
        '[class*="month-year"]', '[class*="header"]',
        '.datepicker .datepicker-days .table-condensed thead tr:nth-child(1) th.datepicker-switch',
        '.month-picker-header', '.calendar-header',
      ];
      for (const sel of selectors) {
        const el = body.querySelector(sel);
        if (el?.textContent?.trim()) return el.textContent.trim();
      }
      // Fallback: find any element that looks like "Month Year"
      const allElements = body.querySelectorAll('*');
      for (const el of allElements) {
        const text = el.textContent?.trim() || '';
        const match = text.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/);
        if (match && el.children.length === 0) return text;
      }
      return '';
    }).catch(() => '');

    if (!headerText) {
      // Can't read header, try clicking the day directly
      break;
    }

    // Parse current month/year from header
    const monthMatch = headerText.match(/(January|February|March|April|May|June|July|August|September|October|November|December)/i);
    const yearMatch = headerText.match(/\d{4}/);

    if (monthMatch && yearMatch) {
      const currentMonth = MONTH_NAMES.findIndex(m => m.toLowerCase() === monthMatch[1].toLowerCase()) + 1;
      const currentYear = parseInt(yearMatch[0]);

      if (currentYear === targetDate.year && currentMonth === targetDate.month) {
        // We're on the right month — break out and select the day
        break;
      }

      // Calculate direction
      const currentTotal = currentYear * 12 + currentMonth;
      const targetTotal = targetDate.year * 12 + targetDate.month;
      const goingBack = currentTotal > targetTotal;

      const navSelectors = goingBack
        ? '.datepicker .prev, [class*="prev"], [aria-label*="revious"], button:has(svg[class*="left"]), .datepicker-days .prev, th.prev, button.prev'
        : '.datepicker .next, [class*="next"], [aria-label*="ext"], button:has(svg[class*="right"]), .datepicker-days .next, th.next, button.next';

      const navBtn = popupScope.locator(navSelectors).first();
      const navCount = await navBtn.count().catch(() => 0);
      if (navCount > 0) {
        await navBtn.click().catch(() => {});
      } else {
        break;
      }
      await page.waitForTimeout(300);
    } else {
      break;
    }
  }

  // Click the target day
  await page.waitForTimeout(300);

  const dayStr = String(targetDate.day);

  // Strategy 1: scan for a cell with exact day text in the popup scope
  const clicked = await popupScope.locator('body').evaluate((body, day) => {
    const selectors = [
      'td.day', '.datepicker td', '.react-datepicker__day',
      '[class*="calendar"] td', '[role="gridcell"]',
      '.datepicker-days td:not(.old):not(.new)',
    ];

    for (const sel of selectors) {
      const cells = body.querySelectorAll(sel);
      for (const cell of cells) {
        const text = cell.textContent?.trim();
        if (text === day && !cell.classList.contains('old') && !cell.classList.contains('new') &&
            !cell.classList.contains('disabled')) {
          (cell as HTMLElement).click();
          return true;
        }
      }
    }

    // Fallback: any clickable element with exact day text inside a calendar/datepicker container
    const container = body.querySelector('.datepicker, [class*="calendar"], [class*="datepicker"], [role="dialog"]');
    if (container) {
      const tds = container.querySelectorAll('td, button, div[role="button"]');
      for (const td of tds) {
        if (td.textContent?.trim() === day && td.children.length === 0) {
          (td as HTMLElement).click();
          return true;
        }
      }
    }
    return false;
  }, dayStr).catch(() => false);

  if (!clicked) {
    // Last resort: text-based locator
    try {
      await popupScope.locator(`td:text-is("${dayStr}")`).first().click({ timeout: 3000 });
    } catch {
      throw new Error(`Could not select day ${dayStr} in calendar`);
    }
  }

  await page.waitForTimeout(500);
}

/**
 * Main sync function: automates Healthplix billing report download
 *
 * Simplified flow:
 * 1. Go directly to the report URL (redirects to login if not authenticated)
 * 2. Login → auto-redirects back to report page
 * 3. Select clinic if prompted
 * 4. Set date range in YYYY-MM-DD text inputs
 * 5. Click "GET BILLS" button
 * 6. Click download (⬇) icon next to "Billed" row
 */
export async function syncHealthplix(opts: SyncOptions): Promise<SyncResult> {
  const isProd = process.env.NODE_ENV === 'production';
  const dataDir = process.env.DATA_DIR || (isProd ? '/data' : '.');
  const downloadDir = path.join(dataDir, 'uploads');
  const debugDir = path.join(downloadDir, 'debug');
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

  // Track the current sync step so error messages can name where we failed.
  let currentStep = 'init';
  const localProgress = (step: string, msg: string, pct: number) => {
    currentStep = step;
    progress(opts, step, msg, pct);
  };

  // Verify Chromium path exists
  const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium';
  if (isProd && !fs.existsSync(chromiumPath)) {
    // Try common alternative paths
    const alternatives = ['/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
    const found = alternatives.find(p => fs.existsSync(p));
    if (!found) {
      throw new Error(`Chromium not found at ${chromiumPath} or alternatives: ${alternatives.join(', ')}`);
    }
    console.log(`[HP Sync] Using alternative Chromium path: ${found}`);
  }

  localProgress('login', 'Launching browser...', 2);
  const browser = await chromium.launch({
    ...(isProd ? { executablePath: fs.existsSync(chromiumPath) ? chromiumPath : '/usr/bin/chromium-browser' } : { channel: 'chrome' }),
    headless: isProd ? true : false,
    args: [
      '--disable-blink-features=AutomationControlled',
      ...(isProd ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : []),
    ],
  });
  const context: BrowserContext = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();

  // Helper: save debug screenshot on failure (writes to /uploads/debug/ so the
  // existing GET /api/sync/debug/screenshots endpoint can serve it).
  const saveDebugScreenshot = async (label: string) => {
    try {
      if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
      const ssPath = path.join(debugDir, `hp-debug-${label}-${Date.now()}.png`);
      await page.screenshot({ path: ssPath, fullPage: true });
      console.log(`[HP Sync] Debug screenshot saved: ${ssPath}`);
    } catch (e) {
      console.log(`[HP Sync] Could not save screenshot: ${e}`);
    }
  };

  try {
    // ── Step 1: Go directly to the report page URL ──
    const REPORT_URL = 'https://md.healthplix.com/report/viewFDBillingReport.php';
    localProgress('login', 'Opening Healthplix...', 5);
    await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    // Wait a bit for JS to load, but don't require full networkidle (can be slow)
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {
      console.log('[HP Sync] networkidle timed out after 30s, continuing...');
    });
    await page.waitForTimeout(2000);

    // ── Step 2: Login if redirected to login page ──
    const currentUrl = new URL(page.url());
    const pageUrl = page.url();
    console.log(`[HP Sync] Current URL: ${pageUrl}`);
    const isOnReportPage = currentUrl.pathname.includes('viewFDBillingReport');
    if (!isOnReportPage) {
      localProgress('login', 'Entering credentials...', 10);

      // Wait for either a username input or a phone input (Healthplix may use phone login)
      const usernameInput = page.locator('input[type="text"], input[type="email"], input[type="tel"], input[name="username"], input[name="email"], input[name="phone"], input[placeholder*="mail"], input[placeholder*="user"], input[placeholder*="phone"], input[placeholder*="mobile"]').first();
      const usernameVisible = await usernameInput.isVisible({ timeout: 15_000 }).catch(() => false);
      if (!usernameVisible) {
        await saveDebugScreenshot('no-username-input');
        throw new Error(`Login page did not show username/email input. URL: ${pageUrl}`);
      }
      await usernameInput.fill(opts.username);
      console.log(`[HP Sync] Username entered`);

      const passwordInput = page.locator('input[type="password"]').first();
      const pwdVisible = await passwordInput.isVisible({ timeout: 10_000 }).catch(() => false);
      if (!pwdVisible) {
        await saveDebugScreenshot('no-password-input');
        throw new Error('Password field not found on login page');
      }
      await passwordInput.fill(opts.password);
      console.log(`[HP Sync] Password entered`);

      // Find and click login button
      const loginBtn = page.locator('button[type="submit"], button:has-text("Login"), button:has-text("Sign In"), button:has-text("Log In"), input[type="submit"]').first();
      const btnVisible = await loginBtn.isVisible({ timeout: 5_000 }).catch(() => false);
      if (!btnVisible) {
        await saveDebugScreenshot('no-login-btn');
        throw new Error('Login button not found');
      }
      await loginBtn.click();
      console.log(`[HP Sync] Login button clicked`);

      // Wait for navigation after login (login causes page redirect)
      await page.waitForLoadState('load', { timeout: 60_000 }).catch(() => {
        console.log('[HP Sync] Post-login load timed out, continuing...');
      });
      await page.waitForTimeout(3000);
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {
        console.log('[HP Sync] Post-login networkidle timed out, continuing...');
      });

      // Check if login succeeded
      const postLoginUrl = page.url();
      console.log(`[HP Sync] Post-login URL: ${postLoginUrl}`);

      // Check for login error messages (wrap in try/catch — navigation may destroy context)
      try {
        const errorText = await page.evaluate(() => {
          const els = document.querySelectorAll('.alert-danger, .error, [class*="error"], [class*="alert"], .text-danger');
          for (const el of els) {
            const text = (el as HTMLElement).innerText?.trim();
            if (text && text.length > 3 && text.length < 200) return text;
          }
          return '';
        });
        if (errorText) {
          await saveDebugScreenshot('login-error');
          throw new Error(`Login failed: ${errorText}`);
        }
      } catch (e: any) {
        // "Execution context was destroyed" means page navigated → login succeeded
        if (e.message?.includes('Execution context was destroyed') || e.message?.includes('navigation')) {
          console.log('[HP Sync] Context destroyed after login click — login succeeded, page navigated');
          await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => {});
          await page.waitForTimeout(2000);
        } else {
          throw e; // Re-throw non-navigation errors
        }
      }

      localProgress('login', 'Logged in successfully', 20);
    } else {
      localProgress('login', 'Already authenticated', 20);
    }

    // ── Step 3: Clinic selection (if prompted after login) ──
    localProgress('clinic', 'Checking for clinic selection...', 25);
    const postLoginPath = new URL(page.url()).pathname;
    if (!postLoginPath.includes('viewFDBillingReport')) {
      // May need to select clinic first
      try {
        const clinicLink = page.locator(`text=${opts.clinicName}`).first();
        const clinicExists = await clinicLink.isVisible({ timeout: 5000 }).catch(() => false);
        if (clinicExists) {
          await clinicLink.click();
          await page.waitForTimeout(2000);
          await page.waitForLoadState('networkidle', { timeout: TIMEOUT });
          localProgress('clinic', `Selected "${opts.clinicName}"`, 30);
        } else {
          localProgress('clinic', 'Auto-selected', 30);
        }
      } catch {
        localProgress('clinic', 'Skipped', 30);
      }

      // Now navigate to the report page directly
      localProgress('navigate', 'Navigating to report page...', 35);
      await page.goto(REPORT_URL, { waitUntil: 'networkidle', timeout: TIMEOUT });
      await page.waitForTimeout(2000);
    } else {
      localProgress('clinic', 'Already on report page', 30);
    }

    // ── Step 4: Confirm we're on the Billing Report page ──
    localProgress('navigate', 'Report page loaded', 50);

    // ── Step 5: Set date range ──
    // The date inputs are READONLY with a datepicker popup (placeholder DD-MMM-YYYY)
    // We must click each input to open the calendar, then navigate & select the date
    localProgress('dates', 'Setting date range...', 55);

    const fromDate = parseDate(opts.fromDate);
    const toDate = parseDate(opts.toDate);

    // Helper: open one date input's datepicker and pick the target date.
    const setOneDate = async (
      kind: 'from' | 'to',
      target: { year: number; month: number; day: number },
    ) => {
      const { locator, scope } = await findDateInputScope(page, kind);
      await locator.click({ timeout: TIMEOUT });
      await page.waitForTimeout(500);
      await selectDateInCalendar(scope, page, target);
    };

    // One retry on transient Playwright timeouts (page may have been mid-render).
    // We do NOT retry on "Couldn't find" errors — those mean Healthplix UI changed
    // and a retry won't help.
    const setDateWithRetry = async (
      kind: 'from' | 'to',
      target: { year: number; month: number; day: number },
    ) => {
      try {
        await setOneDate(kind, target);
      } catch (err: any) {
        const msg: string = err?.message || '';
        const isTransient =
          /Timeout \d+ms exceeded/.test(msg) && !/Couldn't find the/.test(msg);
        if (!isTransient) throw err;
        console.log(`[HP Sync] Transient timeout on ${kind} date, retrying once...`);
        await page.waitForTimeout(2000);
        await setOneDate(kind, target);
      }
    };

    await setDateWithRetry('from', fromDate);
    localProgress('dates', `From date set: ${opts.fromDate}`, 60);

    await page.waitForTimeout(500);

    await setDateWithRetry('to', toDate);
    localProgress('dates', `To date set: ${opts.toDate}`, 65);

    await page.waitForTimeout(500);

    // ── Step 6: Click GET BILLS ──
    localProgress('generate', 'Clicking GET BILLS...', 70);
    const getBillsBtn = page.locator('button:has-text("GET BILLS"), button:has-text("Get Bills"), button:has-text("GENERATE"), input[value="GET BILLS"], input[value="GENERATE"]').first();
    // noWaitAfter: don't block on navigation triggered by GET BILLS
    await getBillsBtn.click({ timeout: 30_000, noWaitAfter: true });

    // Wait for the page to settle after GET BILLS triggers a navigation/reload
    localProgress('generate', 'Waiting for report to generate...', 72);
    await page.waitForLoadState('domcontentloaded', { timeout: 120_000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Now poll for report content (pagination, download icon, or Bills tab)
    const reportReady = await page.waitForFunction(() => {
      const bodyText = document.body.innerText || '';
      if (/\d+\s*-\s*\d+\s+of\s+\d+/.test(bodyText)) return true;
      if (document.querySelector('.fa-download, .fa-file-download, [class*="download-icon"], [title*="ownload"]')) return true;
      if (bodyText.includes('Bills') && bodyText.includes('Collections')) return true;
      return false;
    }, { timeout: 120_000 }).catch(() => null);

    if (reportReady) {
      localProgress('generate', 'Bills loaded', 78);
    } else {
      console.log('[HP Sync] Report indicators not found after 120s, trying download anyway');
      localProgress('generate', 'Attempting download...', 78);
    }

    // ── Step 7: Click the "Download Report" button in the Bills tab ──
    // The Bills tab has a "Download Report" button (a[title="Download Report"])
    // which calls downloadTableToCSV() and includes ALL columns (ID, Addl. Disc,
    // Item Disc, Service Owner) that are missing from the old exportTable('exportBills').
    localProgress('download', 'Clicking download button...', 80);

    await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Scroll to bottom to ensure Bills table is in view
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(1500);

    // Wait for pagination text (confirms Bills table has loaded)
    try {
      await page.waitForFunction(() => {
        return /\d+\s*-\s*\d+\s+of\s+\d+/.test(document.body.innerText || '');
      }, { timeout: 30_000 });
    } catch {
      console.log('[HP Sync] Pagination text not found, trying download anyway');
    }
    await page.waitForTimeout(1000);

    // Ensure the Bills tab is active (it should be by default)
    await page.evaluate(() => {
      const billsTab = document.querySelector('a.nav-link.active');
      if (!billsTab || !billsTab.textContent?.includes('Bills')) {
        const tabs = document.querySelectorAll('a.nav-link');
        for (const t of tabs) {
          if (t.textContent?.trim() === 'Bills') { (t as HTMLElement).click(); break; }
        }
      }
    }).catch(() => {});
    await page.waitForTimeout(500);

    // Check for the "Download Report" button
    const preClickInfo = await page.evaluate(() => {
      const btn = document.querySelector('a[title="Download Report"]');
      return { downloadReportFound: !!btn };
    }).catch(() => ({ downloadReportFound: false }));
    console.log(`[HP Sync] Pre-click: downloadReport=${preClickInfo.downloadReportFound}`);

    if (!preClickInfo.downloadReportFound) {
      await saveDebugScreenshot('download-btn-not-found');
      throw new Error('Could not find "Download Report" button on Bills tab. Healthplix UI may have changed.');
    }

    // Click the "Download Report" button (Bills tab, first instance)
    // This uses downloadTableToCSV() which includes ALL columns (ID, Addl. Disc, etc.)
    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });

    await page.evaluate(() => {
      const btn = document.querySelector('a[title="Download Report"]') as HTMLElement;
      btn.click();
    });
    console.log(`[HP Sync] Download clicked: a[title="Download Report"]`);

    localProgress('download', 'Downloading file...', 85);
    const download = await downloadPromise;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `healthplix-sync-${timestamp}.csv`;
    const filePath = path.join(downloadDir, filename);
    await download.saveAs(filePath);

    const fileSize = fs.statSync(filePath).size;
    const filePreview = fs.readFileSync(filePath, 'utf-8');
    const lineCount = filePreview.split('\n').filter(l => l.trim()).length;
    console.log(`[HP Sync] Saved: ${filePath} (${fileSize} bytes, ${lineCount} non-empty lines)`);
    console.log(`[HP Sync] First 500 chars: ${filePreview.substring(0, 500)}`);
    if (fileSize < 100) {
      console.log(`[HP Sync] WARNING: File appears empty or too small`);
    }

    localProgress('download', 'File downloaded', 90);
    localProgress('complete', 'Download complete!', 100);

    await browser.close();
    return { filePath, filename };
  } catch (err: any) {
    // Save screenshot AND HTML so the next iteration can see exactly what
    // selector to add. Both go into /uploads/debug/ so the existing debug
    // endpoint can list and serve them.
    const ts = Date.now();
    try {
      if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
    } catch {}

    try {
      const ssPath = path.join(debugDir, `hp-error-${ts}.png`);
      await page.screenshot({ path: ssPath, fullPage: true });
      console.error(`[HP Sync] Error screenshot saved: ${ssPath}`);
    } catch {}

    try {
      const htmlPath = path.join(debugDir, `hp-error-${ts}.html`);
      const html = await page.content();
      fs.writeFileSync(htmlPath, html, 'utf8');
      console.error(`[HP Sync] Error HTML saved: ${htmlPath}`);
    } catch {}

    try {
      const url = page.url();
      const title = await page.title().catch(() => '');
      console.error(`[HP Sync] Failed at URL: ${url} (title: "${title}")`);
    } catch {}

    console.error(`[HP Sync] Error:`, err.message);
    await browser.close();

    // Friendlier error message for raw Playwright timeouts. Errors thrown by
    // findDateInputScope (which include "Couldn't find the") are already
    // friendly — pass them through as-is.
    const raw: string = err?.message || String(err);
    let friendly = raw;
    if (/Timeout \d+ms exceeded/.test(raw) && /locator\./.test(raw) && !/Couldn't find the/.test(raw)) {
      friendly =
        `Healthplix page didn't respond as expected at step '${currentStep}'. ` +
        `The Healthplix UI may have changed, or the page is loading slowly. ` +
        `Debug files: /uploads/debug/hp-error-${ts}.{png,html}`;
    }
    throw new Error(`Healthplix sync failed: ${friendly}`);
  }
}
