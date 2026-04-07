import { chromium, type Page, type BrowserContext } from 'playwright';
import path from 'path';
import fs from 'fs';

export interface OneglanceSyncOptions {
  username: string;
  password: string;
  fromDate: string; // YYYY-MM-DD
  toDate: string;   // YYYY-MM-DD
  reportType: 'sales' | 'purchase' | 'both';
  onProgress?: (step: string, message: string, pct: number) => void;
}

export interface OneglanceSyncResult {
  salesFile?: { filePath: string; filename: string };
  purchaseFile?: { filePath: string; filename: string };
}

const TIMEOUT = 120_000;

function progress(opts: OneglanceSyncOptions, step: string, msg: string, pct: number) {
  opts.onProgress?.(step, msg, pct);
}

/**
 * Convert YYYY-MM-DD to DD/MM/YYYY for Oneglance date inputs
 */
function toOneglanceDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Download a Purchase/Sales report from Oneglance
 * Assumes we're already on the Purchase/Sales Report page
 */
async function downloadReport(
  page: Page,
  context: BrowserContext,
  opts: OneglanceSyncOptions,
  type: 'Purchase' | 'Sales',
  downloadDir: string,
  stepPrefix: string,
  pctBase: number,
): Promise<{ filePath: string; filename: string }> {
  // Set dates
  progress(opts, stepPrefix, `Setting date range for ${type}...`, pctBase);

  const fromDateStr = toOneglanceDate(opts.fromDate);
  const toDateStr = toOneglanceDate(opts.toDate);

  // Find the Period date inputs — they are readonly with class "dateclass"
  // Remove readonly, clear, type new value via keyboard
  const dateInputs = page.locator('input.dateclass, input[placeholder="DD/MM/YYYY"]');
  const dateCount = await dateInputs.count();

  const fromInput = dateInputs.first();
  const toInput = dateCount > 1 ? dateInputs.nth(1) : dateInputs.last();

  // Helper: set date on a readonly input
  async function setDateInput(input: any, dateStr: string) {
    // Remove readonly attribute via JS, clear value, and set new value
    await input.evaluate((el: HTMLInputElement, val: string) => {
      el.removeAttribute('readonly');
      el.value = val;
      // Trigger change event so the app recognizes the new value
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, dateStr);
    await page.waitForTimeout(300);
    // Press Escape to dismiss any datepicker that may have opened
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }

  await setDateInput(fromInput, fromDateStr);
  await setDateInput(toInput, toDateStr);

  progress(opts, stepPrefix, `Dates set: ${fromDateStr} to ${toDateStr}`, pctBase + 3);

  // Select the type (Purchase or Sales radio button)
  progress(opts, stepPrefix, `Selecting ${type} type...`, pctBase + 5);
  const radioClicked = await page.evaluate((typeName: string) => {
    // Find radio buttons near "Type" label
    const radios = document.querySelectorAll('input[type="radio"]');
    for (const radio of radios) {
      const label = radio.parentElement?.textContent?.trim() || '';
      const nextSibling = radio.nextSibling?.textContent?.trim() || '';
      if (label.includes(typeName) || nextSibling.includes(typeName)) {
        (radio as HTMLInputElement).click();
        return true;
      }
    }
    // Try by value
    for (const radio of radios) {
      const val = (radio as HTMLInputElement).value?.toLowerCase() || '';
      if (val === typeName.toLowerCase()) {
        (radio as HTMLInputElement).click();
        return true;
      }
    }
    return false;
  }, type);

  if (!radioClicked) {
    // Fallback: try clicking label text
    await page.locator(`text=${type}`).first().click({ timeout: 5000 }).catch(() => {});
  }
  await page.waitForTimeout(500);

  // Click "Detailed" button
  progress(opts, stepPrefix, `Generating ${type} report...`, pctBase + 8);
  await page.locator('button:has-text("Detailed"), a:has-text("Detailed"), input[value="Detailed"]').first().click({ timeout: TIMEOUT });

  // Wait for report to load
  await page.waitForTimeout(3000);
  await page.waitForLoadState('networkidle', { timeout: 180_000 });
  progress(opts, stepPrefix, `${type} report loaded`, pctBase + 15);

  // Click "csv" button to download
  progress(opts, stepPrefix, `Downloading ${type} CSV...`, pctBase + 18);

  const downloadPromise = page.waitForEvent('download', { timeout: 180_000 });
  await page.locator('button:has-text("csv"), a:has-text("csv"), input[value="csv"]').first().click({ timeout: TIMEOUT });

  const download = await downloadPromise;
  progress(opts, stepPrefix, `${type} CSV downloaded`, pctBase + 22);

  // Save the file
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `oneglance-${type.toLowerCase()}-${timestamp}.csv`;
  const filePath = path.join(downloadDir, filename);
  await download.saveAs(filePath);

  return { filePath, filename };
}

/**
 * Main Oneglance sync function
 */
export async function syncOneglance(opts: OneglanceSyncOptions): Promise<OneglanceSyncResult> {
  const downloadDir = path.resolve('uploads');
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context: BrowserContext = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
    geolocation: { latitude: 12.9716, longitude: 77.5946 }, // Bangalore
    permissions: ['geolocation'],
  });
  const page = await context.newPage();

  try {
    // ── Step 1: Navigate to Oneglance ──
    progress(opts, 'login', 'Opening Oneglance...', 5);
    await page.goto('https://emr7.oneglancehealth.com', { waitUntil: 'networkidle', timeout: TIMEOUT });
    await page.waitForTimeout(2000);

    // ── Step 2: Login if needed ──
    // Check if we're on a login page (look for password input)
    const hasPasswordField = await page.locator('input[type="password"]').isVisible({ timeout: 3000 }).catch(() => false);

    if (hasPasswordField) {
      progress(opts, 'login', 'Entering credentials...', 10);

      const usernameInput = page.locator('input[type="text"], input[type="email"], input[name*="user"], input[name*="login"], input[placeholder*="user"], input[placeholder*="email"]').first();
      await usernameInput.fill(opts.username, { timeout: TIMEOUT });

      const passwordInput = page.locator('input[type="password"]').first();
      await passwordInput.fill(opts.password, { timeout: TIMEOUT });

      // Click login/submit button
      const loginBtn = page.locator('button[type="submit"], button:has-text("Login"), button:has-text("Sign In"), input[type="submit"], button:has-text("Log In")').first();
      await loginBtn.click({ timeout: TIMEOUT });

      await page.waitForTimeout(3000);
      await page.waitForLoadState('networkidle', { timeout: TIMEOUT });
      progress(opts, 'login', 'Logged in successfully', 15);
    } else {
      progress(opts, 'login', 'Already authenticated', 15);
    }

    // ── Step 3: Navigate to Reports / Utility page ──
    progress(opts, 'navigate', 'Navigating to Reports...', 20);

    // Go directly to the Utility/Reports page
    const currentUrl = page.url();
    if (!currentUrl.includes('/Utility')) {
      await page.goto('https://emr7.oneglancehealth.com/Utility', { waitUntil: 'networkidle', timeout: TIMEOUT });
      await page.waitForTimeout(2000);
    }
    progress(opts, 'navigate', 'Reports page loaded', 25);

    // ── Step 4: Click on PHARMACY section, then Purchase/Sales Report ──
    progress(opts, 'navigate', 'Opening Purchase/Sales Report...', 28);

    // Click PHARMACY section in sidebar to expand it
    const pharmacyClicked = await page.evaluate(() => {
      const allEls = document.querySelectorAll('div, span, a, li, h3, h4, p');
      for (const el of allEls) {
        const text = el.textContent?.trim();
        if (text === 'PHARMACY') {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    });
    if (!pharmacyClicked) {
      await page.locator('text=PHARMACY').first().click({ timeout: 10_000 }).catch(() => {});
    }
    await page.waitForTimeout(1000);

    // Click "Purchase/Sales Report" link
    const psrClicked = await page.evaluate(() => {
      const links = document.querySelectorAll('a, div, span, li');
      for (const el of links) {
        const text = el.textContent?.trim();
        if (text === 'Purchase/Sales Report') {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    });
    if (!psrClicked) {
      await page.locator('text=Purchase/Sales Report').first().click({ timeout: 10_000 });
    }
    await page.waitForTimeout(2000);
    await page.waitForLoadState('networkidle', { timeout: TIMEOUT });
    progress(opts, 'navigate', 'Purchase/Sales Report page ready', 30);

    const result: OneglanceSyncResult = {};

    // ── Step 5: Download Sales report ──
    if (opts.reportType === 'sales' || opts.reportType === 'both') {
      progress(opts, 'sales', 'Starting Sales report...', 35);
      result.salesFile = await downloadReport(page, context, opts, 'Sales', downloadDir, 'sales', 35);
      progress(opts, 'sales', 'Sales report downloaded', 55);

      // Navigate back to the report page for purchase if needed
      if (opts.reportType === 'both') {
        // Click Filter button to show filters again, or reload
        const filterBtn = page.locator('button:has-text("Filter"), a:has-text("Filter")').first();
        const filterVisible = await filterBtn.isVisible({ timeout: 2000 }).catch(() => false);
        if (filterVisible) {
          await filterBtn.click();
          await page.waitForTimeout(1000);
        } else {
          // Re-navigate
          await page.goto('https://emr7.oneglancehealth.com/Utility#', { waitUntil: 'networkidle', timeout: TIMEOUT });
          await page.waitForTimeout(1000);
          // Re-click Purchase/Sales Report
          await page.evaluate(() => {
            const links = document.querySelectorAll('a, div, span, li');
            for (const el of links) {
              if (el.textContent?.trim() === 'PHARMACY') { (el as HTMLElement).click(); break; }
            }
          });
          await page.waitForTimeout(500);
          await page.evaluate(() => {
            const links = document.querySelectorAll('a, div, span, li');
            for (const el of links) {
              if (el.textContent?.trim() === 'Purchase/Sales Report') { (el as HTMLElement).click(); break; }
            }
          });
          await page.waitForTimeout(2000);
        }
      }
    }

    // ── Step 6: Download Purchase report ──
    if (opts.reportType === 'purchase' || opts.reportType === 'both') {
      const pctStart = opts.reportType === 'both' ? 58 : 35;
      progress(opts, 'purchase', 'Starting Purchase report...', pctStart);
      result.purchaseFile = await downloadReport(page, context, opts, 'Purchase', downloadDir, 'purchase', pctStart);
      progress(opts, 'purchase', 'Purchase report downloaded', pctStart + 25);
    }

    progress(opts, 'complete', 'Download complete!', 100);

    await browser.close();
    return result;
  } catch (err: any) {
    await browser.close();
    throw new Error(`Oneglance sync failed: ${err.message}`);
  }
}
