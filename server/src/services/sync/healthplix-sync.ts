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

const TIMEOUT = 120_000; // 2 minutes — Healthplix can be slow

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
  const downloadDir = path.resolve('uploads');
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

  // Use system Chrome locally, Playwright's Chromium on cloud
  const isProd = process.env.NODE_ENV === 'production';
  const browser = await chromium.launch({
    ...(isProd ? {} : { channel: 'chrome' }),
    headless: isProd,
    args: [
      '--disable-blink-features=AutomationControlled',
      ...(isProd ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : []),
    ],
  });
  const context: BrowserContext = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();

  try {
    // ── Step 1: Go directly to the report page URL ──
    // This will redirect to login if not authenticated, then back to the report
    const REPORT_URL = 'https://md.healthplix.com/report/viewFDBillingReport.php';
    progress(opts, 'login', 'Opening Healthplix report page...', 5);
    await page.goto(REPORT_URL, { waitUntil: 'networkidle', timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    // ── Step 2: Login if redirected to login page ──
    // Check the URL pathname (not query string) to detect login redirect
    const currentUrl = new URL(page.url());
    const isOnReportPage = currentUrl.pathname.includes('viewFDBillingReport');
    if (!isOnReportPage) {
      progress(opts, 'login', 'Entering credentials...', 10);

      const usernameInput = page.locator('input[type="text"], input[type="email"], input[name="username"], input[name="email"], input[placeholder*="mail"], input[placeholder*="user"], input[placeholder*="phone"]').first();
      await usernameInput.fill(opts.username, { timeout: TIMEOUT });

      const passwordInput = page.locator('input[type="password"]').first();
      await passwordInput.fill(opts.password, { timeout: TIMEOUT });

      const loginBtn = page.locator('button[type="submit"], button:has-text("Login"), button:has-text("Sign In"), button:has-text("Log In")').first();
      await loginBtn.click({ timeout: TIMEOUT });

      await page.waitForTimeout(3000);
      await page.waitForLoadState('networkidle', { timeout: TIMEOUT });
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
    await getBillsBtn.click({ timeout: TIMEOUT });

    // Wait for report to load
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle', { timeout: 180_000 });
    progress(opts, 'generate', 'Bills loaded', 78);

    // ── Step 7: Download the report ──
    // After GET BILLS, a detailed Bills table loads below with tabs (Bills, Collections, etc.)
    // The download icon (⬇) is in the top-right of the Bills table, near pagination "1 - N of N"
    // We need to scroll down to the table area first
    progress(opts, 'download', 'Looking for download button...', 80);

    // Scroll down to find the detailed Bills table
    await page.evaluate(() => window.scrollBy(0, 500));
    await page.waitForTimeout(1000);

    const downloadPromise = page.waitForEvent('download', { timeout: 180_000 });

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
    await browser.close();
    throw new Error(`Healthplix sync failed: ${err.message}`);
  }
}
