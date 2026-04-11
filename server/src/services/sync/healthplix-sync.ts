import { chromium, type Page, type BrowserContext } from 'playwright';
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
 * Navigate the Healthplix calendar popup to a specific date.
 * Assumes the calendar popup is already open.
 */
async function selectDateInCalendar(page: Page, targetDate: { year: number; month: number; day: number }) {
  // Wait for calendar popup to appear
  await page.waitForSelector('.datepicker, .calendar, [class*="calendar"], [class*="datepicker"], .react-datepicker, .MuiPickersCalendar-root, [role="dialog"]', { timeout: 5000 }).catch(() => {});

  // Give calendar a moment to render
  await page.waitForTimeout(500);

  // Try to navigate to the correct month/year
  // Healthplix may use different calendar implementations, so try multiple strategies

  const maxAttempts = 36; // max 3 years of navigation
  for (let i = 0; i < maxAttempts; i++) {
    // Read the current month/year displayed in the calendar header
    const headerText = await page.evaluate(() => {
      // Try common calendar header selectors
      const selectors = [
        '.datepicker-switch', '.react-datepicker__current-month',
        '.MuiPickersCalendarHeader-label',
        '[class*="month-year"]', '[class*="header"]',
        '.datepicker .datepicker-days .table-condensed thead tr:nth-child(1) th.datepicker-switch',
        '.month-picker-header', '.calendar-header',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el?.textContent?.trim()) return el.textContent.trim();
      }
      // Fallback: find any element that looks like "Month Year"
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        const text = el.textContent?.trim() || '';
        const match = text.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/);
        if (match && el.children.length === 0) return text;
      }
      return '';
    });

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

      if (currentTotal > targetTotal) {
        // Need to go backward
        const prevBtn = await page.$('.datepicker .prev, [class*="prev"], [aria-label*="revious"], button:has(svg[class*="left"]), .datepicker-days .prev') ||
                        await page.$('th.prev, button.prev');
        if (prevBtn) await prevBtn.click();
        else break;
      } else {
        // Need to go forward
        const nextBtn = await page.$('.datepicker .next, [class*="next"], [aria-label*="ext"], button:has(svg[class*="right"]), .datepicker-days .next') ||
                        await page.$('th.next, button.next');
        if (nextBtn) await nextBtn.click();
        else break;
      }
      await page.waitForTimeout(300);
    } else {
      break;
    }
  }

  // Click the target day
  await page.waitForTimeout(300);

  // Try to click the day number
  const dayStr = String(targetDate.day);

  // Strategy 1: Find a td or button with exact text matching the day
  const clicked = await page.evaluate((day) => {
    // Look for calendar day cells
    const selectors = [
      'td.day', '.datepicker td', '.react-datepicker__day',
      '[class*="calendar"] td', '[role="gridcell"]',
      '.datepicker-days td:not(.old):not(.new)',
    ];

    for (const sel of selectors) {
      const cells = document.querySelectorAll(sel);
      for (const cell of cells) {
        const text = cell.textContent?.trim();
        if (text === day && !cell.classList.contains('old') && !cell.classList.contains('new') &&
            !cell.classList.contains('disabled')) {
          (cell as HTMLElement).click();
          return true;
        }
      }
    }

    // Fallback: find any clickable element with the day text inside a calendar/datepicker
    const container = document.querySelector('.datepicker, [class*="calendar"], [class*="datepicker"], [role="dialog"]');
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
  }, dayStr);

  if (!clicked) {
    // Last resort: use getByText
    try {
      await page.locator(`td:text-is("${dayStr}")`).first().click({ timeout: 3000 });
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
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

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

  progress(opts, 'login', 'Launching browser...', 2);
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

  // Helper: save debug screenshot on failure
  const saveDebugScreenshot = async (label: string) => {
    try {
      const ssPath = path.join(downloadDir, `hp-debug-${label}-${Date.now()}.png`);
      await page.screenshot({ path: ssPath, fullPage: true });
      console.log(`[HP Sync] Debug screenshot saved: ${ssPath}`);
    } catch (e) {
      console.log(`[HP Sync] Could not save screenshot: ${e}`);
    }
  };

  try {
    // ── Step 1: Go directly to the report page URL ──
    const REPORT_URL = 'https://md.healthplix.com/report/viewFDBillingReport.php';
    progress(opts, 'login', 'Opening Healthplix...', 5);
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
      progress(opts, 'login', 'Entering credentials...', 10);

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

      // Wait for navigation after login
      await page.waitForTimeout(3000);
      await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {
        console.log('[HP Sync] Post-login networkidle timed out, continuing...');
      });

      // Check if login succeeded
      const postLoginUrl = page.url();
      console.log(`[HP Sync] Post-login URL: ${postLoginUrl}`);

      // Check for login error messages
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

      progress(opts, 'login', 'Logged in successfully', 20);
    } else {
      progress(opts, 'login', 'Already authenticated', 20);
    }

    // ── Step 3: Clinic selection (if prompted after login) ──
    progress(opts, 'clinic', 'Checking for clinic selection...', 25);
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
          progress(opts, 'clinic', `Selected "${opts.clinicName}"`, 30);
        } else {
          progress(opts, 'clinic', 'Auto-selected', 30);
        }
      } catch {
        progress(opts, 'clinic', 'Skipped', 30);
      }

      // Now navigate to the report page directly
      progress(opts, 'navigate', 'Navigating to report page...', 35);
      await page.goto(REPORT_URL, { waitUntil: 'networkidle', timeout: TIMEOUT });
      await page.waitForTimeout(2000);
    } else {
      progress(opts, 'clinic', 'Already on report page', 30);
    }

    // ── Step 4: Confirm we're on the Billing Report page ──
    progress(opts, 'navigate', 'Report page loaded', 50);

    // ── Step 5: Set date range ──
    // The date inputs are READONLY with a datepicker popup (placeholder DD-MMM-YYYY)
    // We must click each input to open the calendar, then navigate & select the date
    progress(opts, 'dates', 'Setting date range...', 55);

    const fromDate = parseDate(opts.fromDate);
    const toDate = parseDate(opts.toDate);

    // Click the From date input to open its datepicker
    const fromInput = page.locator('input[name="fdate"], input.report_from_date').first();
    await fromInput.click({ timeout: TIMEOUT });
    await page.waitForTimeout(500);
    await selectDateInCalendar(page, fromDate);
    progress(opts, 'dates', `From date set: ${opts.fromDate}`, 60);

    await page.waitForTimeout(500);

    // Click the To date input to open its datepicker
    const toInput = page.locator('input[name="tdate"], input.report_to_date').first();
    await toInput.click({ timeout: TIMEOUT });
    await page.waitForTimeout(500);
    await selectDateInCalendar(page, toDate);
    progress(opts, 'dates', `To date set: ${opts.toDate}`, 65);

    await page.waitForTimeout(500);

    // ── Step 6: Click GET BILLS ──
    progress(opts, 'generate', 'Clicking GET BILLS...', 70);
    const getBillsBtn = page.locator('button:has-text("GET BILLS"), button:has-text("Get Bills"), button:has-text("GENERATE"), input[value="GET BILLS"], input[value="GENERATE"]').first();
    // noWaitAfter: don't wait for navigation — GET BILLS can trigger a long reload
    await getBillsBtn.click({ timeout: 30_000, noWaitAfter: true });

    // Wait for report to actually load — poll for pagination or download icon (up to 120s)
    // Healthplix can take a while to generate the report after GET BILLS
    progress(opts, 'generate', 'Waiting for report to generate...', 72);
    const reportReady = await page.waitForFunction(() => {
      // Check if pagination text appeared (e.g. "1 - 77 of 77")
      const bodyText = document.body.innerText;
      if (/\d+\s*-\s*\d+\s+of\s+\d+/.test(bodyText)) return true;
      // Check if a download icon appeared
      if (document.querySelector('.fa-download, .fa-file-download, [class*="download-icon"], [title*="ownload"]')) return true;
      // Check if a Bills tab appeared
      if (document.querySelector('[class*="tab"]:has-text("Bills")') || bodyText.includes('Bills') && bodyText.includes('Collections')) return true;
      return false;
    }, { timeout: 120_000 }).catch(() => null);

    if (reportReady) {
      progress(opts, 'generate', 'Bills loaded', 78);
    } else {
      console.log('[HP Sync] Report indicators not found after 120s, trying download anyway');
      progress(opts, 'generate', 'Report may still be loading, attempting download...', 78);
    }

    // ── Step 7: Download the report ──
    progress(opts, 'download', 'Looking for download button...', 80);

    // Scroll down to find the detailed Bills table
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.waitForTimeout(1000);

    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });

    // Look for the download icon near the pagination area in the Bills detail table
    const dlClicked = await page.evaluate(() => {
      // Strategy 1: Find download icon near pagination text like "1 - 77 of 77"
      const allEls = document.querySelectorAll('*');
      for (const el of allEls) {
        const text = el.textContent?.trim() || '';
        // Match pagination pattern "N - N of N"
        if (/^\d+\s*-\s*\d+\s+of\s+\d+$/.test(text)) {
          // Found pagination — look for download icon in same container/row
          const container = el.closest('div, tr, nav, ul') || el.parentElement;
          if (container) {
            const icons = container.querySelectorAll('a, button, i, svg, [class*="download"], [title*="ownload"]');
            for (const icon of icons) {
              const cls = (icon.className?.toString?.() || '').toLowerCase();
              const title = (icon.getAttribute('title') || '').toLowerCase();
              const href = (icon.getAttribute('href') || '').toLowerCase();
              if (cls.includes('download') || cls.includes('fa-download') || cls.includes('file-download') ||
                  title.includes('download') || href.includes('download') || href.includes('javascript')) {
                (icon as HTMLElement).click();
                return 'pagination-download';
              }
            }
            // Fallback: click the last clickable icon near pagination (download is usually last)
            const clickables = container.querySelectorAll('a, button, i.fa, svg');
            if (clickables.length > 0) {
              (clickables[clickables.length - 1] as HTMLElement).click();
              return 'pagination-last-icon';
            }
          }
        }
      }

      // Strategy 2: Find any download icon on the page (fa-download, fa-file-excel, etc.)
      const dlIcons = document.querySelectorAll('.fa-download, .fa-file-download, .fa-file-excel, [class*="download-icon"]');
      if (dlIcons.length > 0) {
        // Click the first one that's visible
        for (const icon of dlIcons) {
          const rect = (icon as HTMLElement).getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            (icon as HTMLElement).click();
            return 'generic-fa-download';
          }
        }
      }

      // Strategy 3: Find any element with download in title/class
      const dlBtns = document.querySelectorAll('[title*="ownload"], [title*="xport"], [class*="download"]');
      if (dlBtns.length > 0) {
        (dlBtns[0] as HTMLElement).click();
        return 'generic-download';
      }

      return false;
    });

    if (!dlClicked) {
      // Fallback: try Playwright locator for download icons
      await page.locator('a:has(i.fa-download), button:has(i.fa-download), i.fa-download, i.fa-file-download, [title*="ownload"]').first().click({ timeout: TIMEOUT });
    }

    progress(opts, 'download', 'Downloading file...', 85);
    const download = await downloadPromise;
    progress(opts, 'download', 'File downloaded', 90);

    // Save the file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `healthplix-sync-${timestamp}.xlsx`;
    const filePath = path.join(downloadDir, filename);
    await download.saveAs(filePath);

    progress(opts, 'complete', 'Download complete!', 100);

    await browser.close();
    return { filePath, filename };
  } catch (err: any) {
    // Save debug screenshot before closing
    try {
      const ssPath = path.join(downloadDir, `hp-error-${Date.now()}.png`);
      await page.screenshot({ path: ssPath, fullPage: true });
      console.error(`[HP Sync] Error screenshot saved: ${ssPath}`);
    } catch {}
    console.error(`[HP Sync] Error:`, err.message);
    await browser.close();
    throw new Error(`Healthplix sync failed: ${err.message}`);
  }
}
