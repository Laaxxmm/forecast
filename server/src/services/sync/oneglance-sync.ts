import { chromium, type Page, type BrowserContext } from 'playwright';
import path from 'path';
import fs from 'fs';

export interface OneglanceSyncOptions {
  username: string;
  password: string;
  fromDate: string; // YYYY-MM-DD
  toDate: string;   // YYYY-MM-DD
  reportType: 'sales' | 'purchase' | 'stock' | 'both' | 'all';
  onProgress?: (step: string, message: string, pct: number) => void;
}

export interface OneglanceSyncResult {
  salesFile?: { filePath: string; filename: string };
  purchaseFile?: { filePath: string; filename: string };
  stockFile?: { filePath: string; filename: string };
}

const TIMEOUT = 120_000;

// Use persistent volume in production
const isProd = process.env.NODE_ENV === 'production';
const DATA_DIR = process.env.DATA_DIR || (isProd ? '/data' : '.');

// Debug screenshots directory
const DEBUG_DIR = path.join(DATA_DIR, 'uploads', 'debug');

function progress(opts: OneglanceSyncOptions, step: string, msg: string, pct: number) {
  opts.onProgress?.(step, msg, pct);
}

/** Save a debug screenshot with a numbered step name */
async function debugScreenshot(page: Page, stepName: string) {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const filename = `${Date.now()}-${stepName.replace(/[^a-z0-9]/gi, '_')}.png`;
    await page.screenshot({ path: path.join(DEBUG_DIR, filename), fullPage: true });
    console.log(`[debug-screenshot] ${stepName} → ${filename}`);
  } catch (e) {
    console.log(`[debug-screenshot] Failed for ${stepName}:`, e);
  }
}

/** Get visible text content from the page for debugging */
async function getPageDebugInfo(page: Page): Promise<string> {
  try {
    const info = await page.evaluate(() => {
      const url = window.location.href;
      const title = document.title;
      // Get all visible text elements that might be menu items
      const menuItems: string[] = [];
      document.querySelectorAll('a, li, span, div, button, h3, h4').forEach(el => {
        const text = el.textContent?.trim() || '';
        if (text.length > 1 && text.length < 80 && el.children.length <= 2) {
          menuItems.push(text);
        }
      });
      // Deduplicate and take first 50
      const unique = [...new Set(menuItems)].slice(0, 50);
      return { url, title, menuItems: unique };
    });
    return `URL: ${info.url}\nTitle: ${info.title}\nVisible items: ${info.menuItems.join(' | ')}`;
  } catch {
    return 'Could not get page info';
  }
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
 * Download Stock Available Report from Oneglance
 * Navigates to PHARMACY > Stock Available Report, clicks Stock values, downloads CSV
 */
async function downloadStockReport(
  page: Page,
  context: BrowserContext,
  opts: OneglanceSyncOptions,
  downloadDir: string,
): Promise<{ filePath: string; filename: string }> {
  progress(opts, 'stock', 'Navigating to Stock Available Report...', 70);

  // Navigate back to Utility page if needed
  const currentUrl = page.url();
  if (!currentUrl.includes('/Utility')) {
    await page.goto('https://emr7.oneglancehealth.com/Utility', { waitUntil: 'networkidle', timeout: TIMEOUT });
    await page.waitForTimeout(2000);
  }

  // Click PHARMACY section in sidebar to expand
  await page.evaluate(() => {
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      const ownText = el.childNodes.length <= 2 ? el.textContent?.trim() : '';
      if (ownText && (ownText === 'PHARMACY' || ownText === 'Pharmacy')) {
        (el as HTMLElement).click(); break;
      }
    }
  });
  await page.waitForTimeout(2000);

  // Click "Stock Available Report"
  let stockFound = await page.evaluate(() => {
    const allEls = document.querySelectorAll('a, div, span, li, button');
    for (const el of allEls) {
      const text = el.textContent?.trim() || '';
      if (text.match(/stock\s*available\s*report/i) && text.length < 60) {
        (el as HTMLElement).click();
        return true;
      }
    }
    return false;
  });

  if (!stockFound) {
    const loc = page.locator('text=/Stock.*Available.*Report/i').first();
    stockFound = await loc.isVisible({ timeout: 3000 }).catch(() => false);
    if (stockFound) await loc.click({ timeout: 5000 });
  }

  if (!stockFound) {
    await debugScreenshot(page, 'FAILED-stock-report-not-found');
    throw new Error('Could not find "Stock Available Report" link');
  }

  await page.waitForTimeout(2000);
  await page.waitForLoadState('networkidle', { timeout: TIMEOUT });
  progress(opts, 'stock', 'Stock Available Report page loaded', 73);

  // Click Filter button to show filter options
  const filterBtn = page.locator('button:has-text("Filter"), a:has-text("Filter")').first();
  const filterVisible = await filterBtn.isVisible({ timeout: 3000 }).catch(() => false);
  if (filterVisible) {
    await filterBtn.click();
    await page.waitForTimeout(1000);
  }

  // Set date range (widest range to capture all batches)
  const fromDateStr = toOneglanceDate(opts.fromDate);
  const toDateStr = toOneglanceDate(opts.toDate);

  const dateInputs = page.locator('input.dateclass, input[placeholder="DD/MM/YYYY"]');
  const dateCount = await dateInputs.count();

  if (dateCount >= 2) {
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
    progress(opts, 'stock', `Date range set: ${fromDateStr} to ${toDateStr}`, 75);
  }

  // Click "Stock values" button to generate stock valuation report
  progress(opts, 'stock', 'Generating stock valuation report...', 77);
  const stockValuesBtn = page.locator('button:has-text("Stock values"), a:has-text("Stock values"), input[value="Stock values"]').first();
  await stockValuesBtn.click({ timeout: TIMEOUT });

  // Wait for report to fully load (stock reports can be large)
  await page.waitForTimeout(5000);
  await page.waitForLoadState('networkidle', { timeout: 180_000 });
  await debugScreenshot(page, '12-stock-report-loaded');
  progress(opts, 'stock', 'Stock report loaded', 80);

  // ── Download Stock CSV using multiple strategies ──
  progress(opts, 'stock', 'Preparing CSV download...', 81);
  await debugScreenshot(page, '13-before-csv-download');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `oneglance-stock-${timestamp}.csv`;
  const filePath = path.join(downloadDir, filename);
  let saved = false;

  // Inspect the CSV button to understand its type and attributes
  const csvBtnInfo = await page.evaluate(() => {
    const allEls = document.querySelectorAll('a, button, input, span, div');
    for (const el of allEls) {
      const text = (el.textContent?.trim() || '').toLowerCase();
      const val = (el as HTMLInputElement).value?.toLowerCase() || '';
      // Match "csv" but exclude elements inside the data table
      if ((text === 'csv' || val === 'csv') && !el.closest('table') && el.tagName !== 'SCRIPT') {
        return {
          tag: el.tagName.toLowerCase(),
          href: (el as HTMLAnchorElement).href || '',
          target: el.getAttribute('target') || '',
          outerHTML: el.outerHTML.slice(0, 500),
        };
      }
    }
    return null;
  });
  console.log('[oneglance-sync] CSV button info:', JSON.stringify(csvBtnInfo));

  if (!csvBtnInfo) {
    await debugScreenshot(page, '14-FAILED-csv-not-found');
    throw new Error('CSV button not found on stock report page');
  }

  // ── Strategy 1: Direct fetch via href (most reliable) ──
  if (!saved && csvBtnInfo.tag === 'a' && csvBtnInfo.href && !csvBtnInfo.href.endsWith('#') && !csvBtnInfo.href.startsWith('javascript:')) {
    console.log('[oneglance-sync] Strategy 1: fetching CSV via href:', csvBtnInfo.href);
    progress(opts, 'stock', 'Downloading stock CSV (direct)...', 82);
    try {
      const content = await page.evaluate(async (url: string) => {
        const resp = await fetch(url, { credentials: 'include' });
        return resp.text();
      }, csvBtnInfo.href);
      if (content && content.trim().length > 10) {
        fs.writeFileSync(filePath, content, 'utf-8');
        saved = true;
        console.log('[oneglance-sync] Strategy 1 succeeded — CSV fetched directly');
      }
    } catch (e: any) {
      console.log('[oneglance-sync] Strategy 1 failed:', e.message);
    }
  }

  // ── Strategy 2: Click + intercept response / download / new tab ──
  if (!saved) {
    console.log('[oneglance-sync] Strategy 2: click + intercept response...');
    progress(opts, 'stock', 'Downloading stock CSV...', 82);

    // Capture any network response that looks like CSV
    let capturedCSV: string | null = null;
    const responseListener = async (resp: any) => {
      try {
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        const url = (resp.url() || '').toLowerCase();
        if (ct.includes('csv') || ct.includes('text/plain') || ct.includes('octet-stream') ||
            url.includes('csv') || url.includes('export') || url.includes('download')) {
          const text = await resp.text();
          if (text && text.trim().length > 10 && text.includes(',')) {
            capturedCSV = text;
          }
        }
      } catch {}
    };
    page.on('response', responseListener);

    // Also listen for download event and new page
    const dlHandler = page.waitForEvent('download', { timeout: 20_000 })
      .then(async (dl) => { await dl.saveAs(filePath); return 'download' as const; })
      .catch(() => null);
    const npHandler = context.waitForEvent('page', { timeout: 20_000 })
      .then(async (np) => {
        await np.waitForLoadState('load', { timeout: 15_000 });
        const c = await np.evaluate(() => document.body.innerText || document.body.textContent || '');
        if (c && c.trim().length > 10) {
          fs.writeFileSync(filePath, c, 'utf-8');
          await np.close();
          return 'newpage' as const;
        }
        await np.close();
        return null;
      })
      .catch(() => null);

    // Click the csv button via evaluate (more reliable than locator for custom buttons)
    await page.evaluate(() => {
      const allEls = document.querySelectorAll('a, button, input, span, div');
      for (const el of allEls) {
        const text = (el.textContent?.trim() || '').toLowerCase();
        const val = (el as HTMLInputElement).value?.toLowerCase() || '';
        if ((text === 'csv' || val === 'csv') && !el.closest('table')) {
          (el as HTMLElement).click();
          return;
        }
      }
    });

    // Wait for any mechanism to fire (20s timeout)
    const result = await Promise.race([
      dlHandler,
      npHandler,
      new Promise<null>(r => setTimeout(() => r(null), 20_000)),
    ]);

    // Small extra wait for response interception
    if (!result && !capturedCSV) {
      await page.waitForTimeout(3000);
    }

    page.off('response', responseListener);

    if (result === 'download') {
      saved = true;
      console.log('[oneglance-sync] Strategy 2 succeeded via download event');
    } else if (result === 'newpage') {
      saved = true;
      console.log('[oneglance-sync] Strategy 2 succeeded via new tab');
    } else if (capturedCSV) {
      fs.writeFileSync(filePath, capturedCSV, 'utf-8');
      saved = true;
      console.log('[oneglance-sync] Strategy 2 succeeded via response interception');
    }
  }

  // ── Strategy 3: Scrape the HTML table directly (ultimate fallback) ──
  if (!saved) {
    console.log('[oneglance-sync] Strategy 3: scraping table data from page...');
    progress(opts, 'stock', 'Extracting table data...', 82);
    await debugScreenshot(page, '15-scrape-fallback');

    // Try to show ALL rows by changing DataTables page length
    await page.evaluate(() => {
      const sel = document.querySelector('select[name$="_length"]') as HTMLSelectElement;
      if (sel) {
        const allOpt = Array.from(sel.options).find(o => o.value === '-1' || o.textContent?.trim().toLowerCase() === 'all');
        if (allOpt) { sel.value = allOpt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        else {
          // Use largest available option
          const largest = Array.from(sel.options).reduce((a, b) => parseInt(a.value) > parseInt(b.value) ? a : b);
          if (largest) { sel.value = largest.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        }
      }
    });
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

    // Scrape all pages of the table
    const allRows: string[][] = [];
    let headers: string[] = [];
    let pageNum = 0;
    const MAX_PAGES = 50;

    while (pageNum < MAX_PAGES) {
      const tableData = await page.evaluate(() => {
        const table = document.querySelector('table');
        if (!table) return { headers: [] as string[], rows: [] as string[][], hasNext: false };
        const ths: string[] = [];
        table.querySelectorAll('thead th').forEach(th => ths.push((th as HTMLElement).innerText?.trim() || ''));
        const rows: string[][] = [];
        table.querySelectorAll('tbody tr').forEach(tr => {
          const cells: string[] = [];
          tr.querySelectorAll('td').forEach(td => {
            let t = (td as HTMLElement).innerText?.trim() || '';
            if (t.includes(',') || t.includes('"') || t.includes('\n')) t = '"' + t.replace(/"/g, '""') + '"';
            cells.push(t);
          });
          if (cells.length > 0 && cells.some(c => c.length > 0)) rows.push(cells);
        });
        const nextBtn = document.querySelector('.paginate_button.next:not(.disabled), a.next:not(.disabled)');
        return { headers: ths, rows, hasNext: !!nextBtn };
      });

      if (pageNum === 0 && tableData.headers.length > 0) headers = tableData.headers;
      allRows.push(...tableData.rows);
      pageNum++;

      if (!tableData.hasNext || tableData.rows.length === 0) break;

      // Click next page
      await page.locator('.paginate_button.next, a.next').first().click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    }

    if (allRows.length > 0) {
      const csvLines: string[] = [];
      if (headers.length > 0) csvLines.push(headers.join(','));
      for (const row of allRows) csvLines.push(row.join(','));
      fs.writeFileSync(filePath, csvLines.join('\n'), 'utf-8');
      saved = true;
      console.log(`[oneglance-sync] Strategy 3 succeeded — scraped ${allRows.length} rows from ${pageNum} pages`);
    }
  }

  if (!saved) {
    await debugScreenshot(page, '16-FAILED-all-strategies');
    throw new Error('All CSV download strategies failed (direct fetch, click+intercept, table scraping)');
  }

  progress(opts, 'stock', 'Stock CSV downloaded', 84);
  return { filePath, filename };
}

/**
 * Main Oneglance sync function
 */
export async function syncOneglance(opts: OneglanceSyncOptions): Promise<OneglanceSyncResult> {
  const downloadDir = path.join(DATA_DIR, 'uploads');
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

  // Use system Chrome locally, system Chromium (apt) on cloud
  const isProd = process.env.NODE_ENV === 'production';
  const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium';
  const browser = await chromium.launch({
    ...(isProd ? { executablePath: chromiumPath } : { channel: 'chrome' }),
    headless: isProd ? true : false,
    args: [
      '--disable-blink-features=AutomationControlled',
      ...(isProd ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : []),
    ],
  });
  const context: BrowserContext = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
    geolocation: { latitude: 12.9716, longitude: 77.5946 }, // Bangalore
    permissions: ['geolocation'],
  });
  const page = await context.newPage();

  try {
    // Clean old debug screenshots
    if (fs.existsSync(DEBUG_DIR)) {
      fs.readdirSync(DEBUG_DIR).forEach(f => fs.unlinkSync(path.join(DEBUG_DIR, f)));
    }

    // ── Step 1: Navigate to Oneglance ──
    progress(opts, 'login', 'Opening Oneglance...', 5);
    await page.goto('https://emr7.oneglancehealth.com', { waitUntil: 'networkidle', timeout: TIMEOUT });
    await page.waitForTimeout(2000);
    await debugScreenshot(page, '01-homepage');

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
      await debugScreenshot(page, '02-after-login');
      progress(opts, 'login', 'Logged in successfully', 15);
    } else {
      progress(opts, 'login', 'Already authenticated', 15);
    }
    await debugScreenshot(page, '03-post-auth');

    // ── Step 3: Navigate to Reports / Utility page ──
    progress(opts, 'navigate', 'Navigating to Reports...', 20);

    // Go directly to the Utility/Reports page
    const currentUrl = page.url();
    if (!currentUrl.includes('/Utility')) {
      await page.goto('https://emr7.oneglancehealth.com/Utility', { waitUntil: 'networkidle', timeout: TIMEOUT });
      await page.waitForTimeout(2000);
    }
    await debugScreenshot(page, '04-utility-page');
    progress(opts, 'navigate', 'Reports page loaded', 25);

    // ── Step 4: Click on PHARMACY section, then Purchase/Sales Report ──
    // Skip Purchase/Sales navigation if only downloading stock report
    if (opts.reportType === 'stock') {
      progress(opts, 'navigate', 'Skipping to Stock Available Report...', 30);
    }

    let psrFound = opts.reportType === 'stock'; // Skip PSR navigation for stock-only
    if (!psrFound) {
    progress(opts, 'navigate', 'Opening Purchase/Sales Report...', 28);

    // Strategy 1: Click PHARMACY to expand, then click Purchase/Sales Report
    for (let attempt = 0; attempt < 3 && !psrFound; attempt++) {
      // Click PHARMACY section in sidebar to expand it
      const pharmacyClicked = await page.evaluate(() => {
        const allEls = document.querySelectorAll('*');
        for (const el of allEls) {
          const ownText = el.childNodes.length <= 2 ? el.textContent?.trim() : '';
          if (ownText && (ownText === 'PHARMACY' || ownText === 'Pharmacy')) {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
      if (!pharmacyClicked) {
        await page.locator('text=/pharmacy/i').first().click({ timeout: 5_000 }).catch(() => {});
      }
      await page.waitForTimeout(2000);
      await debugScreenshot(page, `05-after-pharmacy-click-attempt-${attempt + 1}`);

      // Now look for Purchase/Sales Report with partial matching
      psrFound = await page.evaluate(() => {
        const allEls = document.querySelectorAll('a, div, span, li, button');
        for (const el of allEls) {
          const text = el.textContent?.trim() || '';
          // Match various forms: "Purchase/Sales Report", "Purchase / Sales Report", etc.
          if (text.match(/purchase\s*\/?\s*sales\s*report/i) && text.length < 60) {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      if (!psrFound) {
        // Try Playwright locator with regex
        const loc = page.locator('text=/Purchase.*Sales.*Report/i').first();
        psrFound = await loc.isVisible({ timeout: 2000 }).catch(() => false);
        if (psrFound) {
          await loc.click({ timeout: 5_000 });
        }
      }

      if (!psrFound && attempt < 2) {
        progress(opts, 'navigate', `Retrying sidebar navigation (attempt ${attempt + 2})...`, 28);
        // Scroll sidebar or reload
        await page.evaluate(() => {
          const sidebar = document.querySelector('nav, [class*="sidebar"], [class*="menu"], [class*="panel"]');
          if (sidebar) (sidebar as HTMLElement).scrollTop += 300;
        });
        await page.waitForTimeout(1000);
      }
    }

    if (!psrFound) {
      // Strategy 2: Try navigating via URL hash or direct link
      const links = await page.evaluate(() => {
        const anchors = document.querySelectorAll('a[href]');
        return Array.from(anchors)
          .map(a => ({ href: (a as HTMLAnchorElement).href, text: a.textContent?.trim() || '' }))
          .filter(l => l.text.match(/purchase|sales.*report/i) || l.href.match(/purchase|sales/i));
      });
      if (links.length > 0) {
        await page.goto(links[0].href, { waitUntil: 'networkidle', timeout: TIMEOUT });
        psrFound = true;
      }
    }

    if (!psrFound) {
      await debugScreenshot(page, '06-FAILED-psr-not-found');
      const debugInfo = await getPageDebugInfo(page);
      console.log('[oneglance-sync] PSR not found. Page debug info:\n', debugInfo);
      throw new Error(`Could not find "Purchase/Sales Report" link. Debug screenshots saved. Page: ${page.url()}`);
    }

    await page.waitForTimeout(2000);
    await page.waitForLoadState('networkidle', { timeout: TIMEOUT });
    progress(opts, 'navigate', 'Purchase/Sales Report page ready', 30);
    } // end of PSR navigation block (skipped for stock-only)

    const result: OneglanceSyncResult = {};

    // ── Step 5: Download Sales report ──
    if (opts.reportType === 'sales' || opts.reportType === 'both' || opts.reportType === 'all') {
      progress(opts, 'sales', 'Starting Sales report...', 35);
      result.salesFile = await downloadReport(page, context, opts, 'Sales', downloadDir, 'sales', 35);
      progress(opts, 'sales', 'Sales report downloaded', 55);

      // Navigate back to the report page for purchase if needed
      if (opts.reportType === 'both' || opts.reportType === 'all') {
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
          // Re-click PHARMACY then Purchase/Sales Report
          await page.evaluate(() => {
            const allEls = document.querySelectorAll('*');
            for (const el of allEls) {
              const ownText = el.childNodes.length <= 2 ? el.textContent?.trim() : '';
              if (ownText && (ownText === 'PHARMACY' || ownText === 'Pharmacy')) {
                (el as HTMLElement).click(); break;
              }
            }
          });
          await page.waitForTimeout(2000);
          await page.evaluate(() => {
            const allEls = document.querySelectorAll('a, div, span, li, button');
            for (const el of allEls) {
              const text = el.textContent?.trim() || '';
              if (text.match(/purchase\s*\/?\s*sales\s*report/i) && text.length < 60) {
                (el as HTMLElement).click(); break;
              }
            }
          });
          await page.waitForTimeout(2000);
        }
      }
    }

    // ── Step 6: Download Purchase report ──
    if (opts.reportType === 'purchase' || opts.reportType === 'both' || opts.reportType === 'all') {
      const pctStart = (opts.reportType === 'both' || opts.reportType === 'all') ? 58 : 35;
      progress(opts, 'purchase', 'Starting Purchase report...', pctStart);
      result.purchaseFile = await downloadReport(page, context, opts, 'Purchase', downloadDir, 'purchase', pctStart);
      progress(opts, 'purchase', 'Purchase report downloaded', pctStart + 25);
    }

    // ── Step 7: Download Stock Available report ──
    if (opts.reportType === 'stock' || opts.reportType === 'all') {
      result.stockFile = await downloadStockReport(page, context, opts, downloadDir);
    }

    progress(opts, 'complete', 'Download complete!', 100);

    await browser.close();
    return result;
  } catch (err: any) {
    await debugScreenshot(page, '99-ERROR').catch(() => {});
    await browser.close();
    throw new Error(`Oneglance sync failed: ${err.message}`);
  }
}
