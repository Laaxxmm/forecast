// Hyderabad-specific OneGlance scraper.
//
// Same conceptual flow as oneglance-sync.ts (login → navigate → set
// filters → click action → download CSV) but targets a different
// OneGlance instance and a different navigation tree:
//
//   emr7  flow: Utility page → expand PHARMACY → Purchase/Sales Report
//   emr25 flow: Reports tab (sidebar icon) → expand STORE → Purchase/
//               Sales Report - Store
//
// The filter UI is also slightly different on emr25: the Hyderabad
// version has Stockist / Invoice No / Batch No / Product Name / Brand
// Name fields in addition to the type radio + center text input, and
// the action buttons are Detailed / Drug wise / Batch wise.
//
// IMPORTANT: oneglance-sync.ts (emr7) is intentionally left untouched
// so non-Hyderabad branches keep working with their existing flow. The
// runner dispatches between the two scrapers based on branch role +
// city.
//
// Coverage of this file evolves report-by-report. Today only the
// Purchase Report at the central Store is wired up. Sales / Stock /
// Stock Transfer at the satellites land in subsequent passes.

import { chromium, type Page, type BrowserContext } from 'playwright';
import path from 'path';
import fs from 'fs';

export interface OneglanceHyderabadSyncOptions {
  username: string;
  password: string;
  fromDate: string;  // YYYY-MM-DD
  toDate: string;    // YYYY-MM-DD
  /** Which reports to download in this run. Subset progressively grows. */
  reports: Array<'purchase'>;
  onProgress?: (step: string, message: string, pct: number) => void;
}

export interface OneglanceHyderabadSyncResult {
  purchaseFile?: { filePath: string; filename: string };
  // Future entries (one per supported report):
  //   salesFile?, stockFile?, transferFile?
}

const TIMEOUT = 45_000;
const isProd = process.env.NODE_ENV === 'production';
const DATA_DIR = process.env.DATA_DIR || (isProd ? '/data' : '.');
const DEBUG_DIR = path.join(DATA_DIR, 'uploads', 'debug-hyderabad');
const ONEGLANCE_BASE = 'https://emr25.oneglancehealth.com';

function progress(opts: OneglanceHyderabadSyncOptions, step: string, msg: string, pct: number) {
  opts.onProgress?.(step, msg, pct);
}

async function debugScreenshot(page: Page, stepName: string) {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const filename = `${Date.now()}-${stepName.replace(/[^a-z0-9]/gi, '_')}.png`;
    await page.screenshot({ path: path.join(DEBUG_DIR, filename), fullPage: false });
    console.log(`[oneglance-hyderabad] screenshot ${stepName} → ${filename}`);
  } catch (e) {
    console.log(`[oneglance-hyderabad] screenshot ${stepName} failed:`, e);
  }
}

/** Convert YYYY-MM-DD to DD/MM/YYYY for OneGlance date inputs. */
function toOneglanceDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Log in to OneGlance Hyderabad. Same form patterns as emr7 — username
 * + password + submit. Idempotent: if the page is already past login,
 * returns quickly without re-authenticating.
 */
async function login(page: Page, opts: OneglanceHyderabadSyncOptions): Promise<void> {
  progress(opts, 'login', 'Opening Oneglance (Hyderabad)...', 5);
  await page.goto(ONEGLANCE_BASE, { waitUntil: 'networkidle', timeout: TIMEOUT });
  await page.waitForTimeout(2000);
  await debugScreenshot(page, '01-homepage');

  const hasPasswordField = await page.locator('input[type="password"]').isVisible({ timeout: 3000 }).catch(() => false);
  if (!hasPasswordField) {
    progress(opts, 'login', 'Already authenticated', 12);
    return;
  }

  progress(opts, 'login', 'Entering credentials...', 8);
  const usernameInput = page.locator(
    'input[type="text"], input[type="email"], input[name*="user"], input[name*="login"], input[placeholder*="user"], input[placeholder*="email"]'
  ).first();
  await usernameInput.fill(opts.username, { timeout: TIMEOUT });

  const passwordInput = page.locator('input[type="password"]').first();
  await passwordInput.fill(opts.password, { timeout: TIMEOUT });

  const loginBtn = page.locator(
    'button[type="submit"], button:has-text("Login"), button:has-text("Sign In"), input[type="submit"], button:has-text("Log In")'
  ).first();
  await loginBtn.click({ timeout: TIMEOUT });

  await page.waitForTimeout(3000);
  await page.waitForLoadState('networkidle', { timeout: TIMEOUT });
  await debugScreenshot(page, '02-after-login');
  progress(opts, 'login', 'Logged in', 12);
}

/**
 * From the post-login Dashboard, navigate to the Purchase/Sales Report
 * for the Store: click Reports icon in the left sidebar → expand STORE
 * group → click "Purchase/Sales Report - Store".
 */
async function navigateToStorePurchaseSalesReport(page: Page, opts: OneglanceHyderabadSyncOptions): Promise<void> {
  progress(opts, 'navigate', 'Opening Reports section...', 18);

  // The sidebar has a column of icons. "Reports" is the wrench/tools
  // icon. We can't rely on a stable label, so we try a sequence of
  // selectors: aria-label/title, then a child SVG / class hint, then
  // a positional fallback (the icon shows the word REPORTS in the
  // top header after click — we use that as a confirmation signal).
  const reportsClickResult = await page.evaluate(() => {
    const candidates = document.querySelectorAll('a[title], a[aria-label], button[title], button[aria-label]');
    for (const el of candidates) {
      const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
      if (label.includes('report')) {
        (el as HTMLElement).click();
        return 'aria';
      }
    }
    // Try sidebar links / nav items whose class or text mentions report
    const sidebarLinks = document.querySelectorAll('aside a, nav a, [class*="sidebar"] a, [class*="side-bar"] a, aside li, nav li');
    for (const el of sidebarLinks) {
      const txt = (el.textContent || '').trim().toLowerCase();
      const cls = (el.className || '').toString().toLowerCase();
      if (txt === 'reports' || cls.includes('report')) {
        (el as HTMLElement).click();
        return 'sidebar';
      }
    }
    return null;
  });

  if (!reportsClickResult) {
    // Fallback: try a Playwright text locator for any "Reports" label
    const loc = page.locator('text=/^Reports$/i').first();
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
      await loc.click({ timeout: 5_000 });
    }
  }

  await page.waitForTimeout(2000);
  await debugScreenshot(page, '03-reports-menu');

  progress(opts, 'navigate', 'Expanding STORE menu...', 22);
  const storeClicked = await page.evaluate(() => {
    const els = document.querySelectorAll('a, div, span, li, button, h3, h4');
    for (const el of els) {
      const ownText = el.childNodes.length <= 2 ? el.textContent?.trim() : '';
      if (ownText && /^store$/i.test(ownText)) {
        (el as HTMLElement).click();
        return true;
      }
    }
    return false;
  });
  if (!storeClicked) {
    await page.locator('text=/^STORE$/i').first().click({ timeout: 5_000 }).catch(() => {});
  }
  await page.waitForTimeout(1500);
  await debugScreenshot(page, '04-store-expanded');

  progress(opts, 'navigate', 'Opening Purchase/Sales Report - Store...', 25);
  const reportClicked = await page.evaluate(() => {
    const els = document.querySelectorAll('a, div, span, li, button');
    for (const el of els) {
      const text = el.textContent?.trim() || '';
      // Match "Purchase/Sales Report - Store" with various spacings/dashes
      if (text.match(/purchase\s*\/?\s*sales\s*report\s*[-–]?\s*store/i) && text.length < 80) {
        (el as HTMLElement).click();
        return true;
      }
    }
    return false;
  });

  if (!reportClicked) {
    const loc = page.locator('text=/Purchase.*Sales.*Report.*Store/i').first();
    if (await loc.isVisible({ timeout: 2000 }).catch(() => false)) {
      await loc.click({ timeout: 5_000 });
    } else {
      await debugScreenshot(page, '05-FAILED-purchase-sales-not-found');
      throw new Error('Could not find "Purchase/Sales Report - Store" link in the STORE menu.');
    }
  }

  await page.waitForTimeout(2500);
  try { await page.waitForLoadState('networkidle', { timeout: 20_000 }); } catch {
    console.log('[oneglance-hyderabad] networkidle timeout while loading report page; proceeding');
  }
  await debugScreenshot(page, '06-report-page-loaded');
  progress(opts, 'navigate', 'Report page loaded', 30);
}

/**
 * On the Purchase/Sales Report - Store page: set Period dates, ensure
 * Type=Purchase, click Detailed, wait for the report to render, click
 * the csv button, save the download.
 */
async function downloadPurchaseReport(
  page: Page,
  opts: OneglanceHyderabadSyncOptions,
  downloadDir: string,
): Promise<{ filePath: string; filename: string }> {
  progress(opts, 'purchase', 'Setting Purchase Report filters...', 35);

  const fromDateStr = toOneglanceDate(opts.fromDate);
  const toDateStr = toOneglanceDate(opts.toDate);

  // Date inputs: same readonly+dateclass pattern as emr7. Strip readonly,
  // set value, dispatch change/input. Press Escape to dismiss any
  // datepicker that opens.
  const dateInputs = page.locator('input.dateclass, input[placeholder="DD/MM/YYYY"]');
  const dateCount = await dateInputs.count();
  if (dateCount < 2) {
    await debugScreenshot(page, '07-FAILED-no-date-inputs');
    throw new Error(`Expected at least 2 date inputs on the Purchase/Sales Report filter, found ${dateCount}.`);
  }
  const fromInput = dateInputs.first();
  const toInput = dateInputs.nth(1);

  async function setDateInput(input: any, dateStr: string) {
    await input.evaluate((el: HTMLInputElement, val: string) => {
      el.removeAttribute('readonly');
      el.value = val;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, dateStr);
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }

  await setDateInput(fromInput, fromDateStr);
  await setDateInput(toInput, toDateStr);
  progress(opts, 'purchase', `Dates: ${fromDateStr} → ${toDateStr}`, 40);

  // Ensure Type = Purchase. Default is already Purchase per the user's
  // confirmation, but click defensively in case the previous session
  // left it on Sales.
  const radioClicked = await page.evaluate(() => {
    const radios = document.querySelectorAll('input[type="radio"]');
    for (const r of radios) {
      const value = (r as HTMLInputElement).value?.trim().toLowerCase() || '';
      const labelText = (r.parentElement?.textContent || r.nextSibling?.textContent || '').trim().toLowerCase();
      if (value === 'purchase' || labelText.includes('purchase')) {
        (r as HTMLInputElement).click();
        return true;
      }
    }
    return false;
  });
  if (!radioClicked) {
    await page.locator('label:has-text("Purchase")').first().click({ timeout: 3000 }).catch(() => {});
  }
  await page.waitForTimeout(400);
  progress(opts, 'purchase', 'Type set to Purchase', 44);

  await debugScreenshot(page, '08-filters-set');

  // Click Detailed to render the report
  progress(opts, 'purchase', 'Generating report...', 48);
  await page.locator(
    'button:has-text("Detailed"), a:has-text("Detailed"), input[value="Detailed"]'
  ).first().click({ timeout: TIMEOUT });

  // Wait for the data + csv/pdf header to appear
  await page.waitForTimeout(3000);
  try {
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
  } catch {
    console.log('[oneglance-hyderabad] networkidle timeout while loading Purchase Report; proceeding');
  }
  await debugScreenshot(page, '09-report-loaded');
  progress(opts, 'purchase', 'Report rendered', 65);

  // Download the CSV. The header has csv + pdf buttons; we only want csv.
  progress(opts, 'purchase', 'Downloading CSV...', 70);
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
  await page.locator(
    'button:has-text("csv"), a:has-text("csv"), input[value="csv"]'
  ).first().click({ timeout: TIMEOUT });
  const download = await downloadPromise;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `oneglance-hyderabad-purchase-${timestamp}.csv`;
  const filePath = path.join(downloadDir, filename);
  await download.saveAs(filePath);
  progress(opts, 'purchase', 'CSV downloaded', 80);
  await debugScreenshot(page, '10-after-csv-click');

  return { filePath, filename };
}

/**
 * Main entry. Spawns Chromium, runs the requested set of Hyderabad
 * downloads, returns file paths. Browser is always closed in `finally`
 * even when a step throws so we don't leak processes.
 */
export async function syncOneglanceHyderabad(
  opts: OneglanceHyderabadSyncOptions,
): Promise<OneglanceHyderabadSyncResult> {
  const downloadDir = path.join(DATA_DIR, 'uploads');
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

  const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium';
  const browser = await chromium.launch({
    ...(isProd ? { executablePath: chromiumPath } : { channel: 'chrome' }),
    headless: isProd ? true : false,
    args: [
      '--disable-blink-features=AutomationControlled',
      ...(isProd ? [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
        '--disable-extensions', '--disable-background-networking', '--disable-default-apps',
        '--disable-sync', '--disable-translate', '--metrics-recording-only',
        '--js-flags=--max-old-space-size=256',
        '--blink-settings=imagesEnabled=false',
        '--disable-software-rasterizer',
      ] : []),
    ],
  });
  const context: BrowserContext = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
    geolocation: { latitude: 17.385, longitude: 78.4867 }, // Hyderabad
    permissions: ['geolocation'],
  });
  const page = await context.newPage();

  const result: OneglanceHyderabadSyncResult = {};

  try {
    // Clean old debug screenshots so each run starts fresh
    if (fs.existsSync(DEBUG_DIR)) {
      try { fs.readdirSync(DEBUG_DIR).forEach(f => fs.unlinkSync(path.join(DEBUG_DIR, f))); } catch {}
    }

    await login(page, opts);

    if (opts.reports.includes('purchase')) {
      await navigateToStorePurchaseSalesReport(page, opts);
      result.purchaseFile = await downloadPurchaseReport(page, opts, downloadDir);
    }

    return result;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
