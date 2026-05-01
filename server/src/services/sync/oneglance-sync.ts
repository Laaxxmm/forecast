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

const TIMEOUT = 45_000;

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
    await page.screenshot({ path: path.join(DEBUG_DIR, filename), fullPage: false });
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

  // Wait for report to load — use short timeout, don't block on networkidle
  await page.waitForTimeout(3000);
  try {
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
  } catch {
    console.log(`[oneglance-sync] networkidle timeout for ${type}, proceeding`);
  }
  progress(opts, stepPrefix, `${type} report loaded`, pctBase + 15);

  // Click "csv" button to download
  progress(opts, stepPrefix, `Downloading ${type} CSV...`, pctBase + 18);

  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
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
  try { await page.waitForLoadState('networkidle', { timeout: 20_000 }); } catch {}
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

  // Wait for CSV button to appear (don't wait for full 30K-row table render)
  await page.waitForTimeout(3000);
  try {
    await page.locator('button.uti_btn, button:has-text("csv")').first()
      .waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    console.log('[oneglance-sync] CSV button not visible after 15s, trying anyway');
  }
  await debugScreenshot(page, '12-stock-report-loaded');
  progress(opts, 'stock', 'Stock report loaded', 80);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `oneglance-stock-${timestamp}.csv`;
  const filePath = path.join(downloadDir, filename);
  let saved = false;

  // Quick diagnostics (lightweight — no row counting to avoid iterating 30K DOM nodes).
  // Wrapped in try/catch because even a tiny evaluate can crash if the
  // renderer is already memory-pressured from the 50K-row table render.
  let pageInfo: { tableCount: number; hasCsvBtn: boolean; url: string };
  try {
    pageInfo = await page.evaluate(() => {
      const tables = document.querySelectorAll('table');
      const hasCsvBtn = !!document.querySelector('button.uti_btn');
      return { tableCount: tables.length, hasCsvBtn, url: location.href };
    });
  } catch (err: any) {
    await debugScreenshot(page, '13-pageinfo-crash').catch(() => {});
    throw new Error(
      `Stock report renderer crashed before scrape could start. ` +
      `The branch's inventory is too large to scrape via the browser. ` +
      `Try downloading the CSV manually from OneGlance and uploading it. ` +
      `(${err?.message || err})`
    );
  }
  console.log('[oneglance-sync] Stock page:', JSON.stringify(pageInfo));

  // ── Strategy 1: Click CSV button + wait for download (low memory) ──
  // Two capture paths only:
  //   1. Browser download event (when OneGlance triggers a real <a download>)
  //   2. HTTP response listener (when OneGlance returns CSV as a response)
  //
  // The previous third path — `URL.createObjectURL` override + FileReader —
  // was actively causing renderer crashes on large branches. The FileReader
  // held the full CSV as a string in window.__capturedCSV, and reading that
  // back through `page.evaluate()` serialized the entire string across CDP,
  // putting the CSV in memory ~3x at peak (blob + reader-string + CDP copy)
  // on top of the 50K-row DOM. That tipped renderers OOM.
  if (pageInfo.hasCsvBtn) {
    console.log('[oneglance-sync] Strategy 1: click CSV + download...');
    progress(opts, 'stock', 'Downloading stock CSV...', 82);

    let capturedCSV: string | null = null;
    const respListener = async (resp: any) => {
      try {
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        if (ct.includes('csv') || ct.includes('octet-stream') || ct.includes('text/plain')) {
          const text = await resp.text();
          if (text && text.length > 10 && text.includes(',')) capturedCSV = text;
        }
      } catch {}
    };
    page.on('response', respListener);

    const dlPromise = page.waitForEvent('download', { timeout: 30_000 })
      .then(async dl => { await dl.saveAs(filePath); return 'download' as const; })
      .catch(() => null);

    // Click CSV button
    await page.locator('button.uti_btn:has-text("csv"), button:has-text("csv")').first()
      .click({ timeout: 5000 }).catch(() => {});

    const dlResult = await Promise.race([
      dlPromise,
      new Promise<null>(r => setTimeout(() => r(null), 30_000)),
    ]);

    page.off('response', respListener);

    if (dlResult === 'download') {
      saved = true;
      console.log('[oneglance-sync] Strategy 1 succeeded via download event');
    } else if (capturedCSV) {
      fs.writeFileSync(filePath, capturedCSV, 'utf-8');
      saved = true;
      console.log('[oneglance-sync] Strategy 1 succeeded via response interception');
    } else {
      console.log('[oneglance-sync] Strategy 1: no download after 30s');
    }
  }

  // ── Strategy 2: Scrape table in chunks (fallback — higher memory but works offline) ──
  if (!saved) {
    console.log('[oneglance-sync] Strategy 2: scraping table in chunks...');
    progress(opts, 'stock', 'Extracting table data...', 82);
    // Snapshot the page state BEFORE the heavy evaluate so we can see
    // what crashed if it does. Strategy 1 already failed by this point;
    // a second screenshot post-crash is impossible because the tab is
    // dead, so capture preemptively.
    await debugScreenshot(page, '15-pre-strategy2').catch(() => {});

    // Get headers + row count first (lightweight). Wrapped because counting
    // tr.length on a 50K-row tbody can itself crash an already-pressed
    // renderer on the largest branches.
    let tableInfo: { headers: string[]; totalRows: number; tableIdx: number };
    try {
      tableInfo = await page.evaluate(() => {
        const tables = document.querySelectorAll('table');
        let bestTable = -1, bestCount = 0;
        tables.forEach((t, i) => {
          const rows = (t.querySelector('tbody') || t).querySelectorAll('tr').length;
          if (rows > bestCount) { bestTable = i; bestCount = rows; }
        });
        if (bestTable < 0) return { headers: [] as string[], totalRows: 0, tableIdx: -1 };
        const table = tables[bestTable];
        const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
        const headers: string[] = [];
        // textContent (not innerText) — innerText forces layout reflow and
        // is fine for the small header row but matters massively in the
        // chunk loop below where it ran 600K times.
        headerRow?.querySelectorAll('th, td').forEach(c => headers.push((c?.textContent || '').trim()));
        return { headers, totalRows: bestCount, tableIdx: bestTable };
      });
    } catch (err: any) {
      await debugScreenshot(page, '14-tableinfo-crash').catch(() => {});
      throw new Error(
        `Stock report renderer crashed while counting rows. ` +
        `The branch's inventory exceeds what the browser can handle. ` +
        `Try downloading the CSV manually from OneGlance and uploading it. ` +
        `(${err?.message || err})`
      );
    }

    if (tableInfo.totalRows > 0) {
      // Smaller chunk + textContent + post-chunk yield. The previous
      // 2000-row chunks with innerText ran 40K reflow-inducing calls
      // per evaluate, holding ~2MB of intermediate strings, on top of
      // the 30K-row DOM already loaded. Renderer ran out of memory →
      // "Target crashed" mid-evaluate. 500 rows × textContent is ~10x
      // less memory pressure per evaluate, and the 50ms gap between
      // chunks lets the renderer GC.
      const CHUNK = 500;
      const csvLines: string[] = [];
      if (tableInfo.headers.length > 0) csvLines.push(tableInfo.headers.join(','));

      for (let offset = 0; offset < tableInfo.totalRows; offset += CHUNK) {
        try {
          const chunk = await page.evaluate(({ idx, start, size }) => {
            const table = document.querySelectorAll('table')[idx];
            const tbody = table.querySelector('tbody') || table;
            const rows = tbody.querySelectorAll('tr');
            const startIdx = start + (table.querySelector('thead') ? 0 : (start === 0 ? 1 : 0));
            const lines: string[] = [];
            for (let i = startIdx; i < Math.min(startIdx + size, rows.length); i++) {
              const cells: string[] = [];
              rows[i].querySelectorAll('td, th').forEach(td => {
                // textContent is layout-free — no reflow per cell.
                let t = (td?.textContent || '').trim();
                if (t.includes(',') || t.includes('"') || t.includes('\n')) t = '"' + t.replace(/"/g, '""') + '"';
                cells.push(t);
              });
              if (cells.some(c => c.length > 0)) lines.push(cells.join(','));
            }
            return lines;
          }, { idx: tableInfo.tableIdx, start: offset, size: CHUNK });
          csvLines.push(...chunk);
        } catch (err: any) {
          // If the renderer crashed mid-chunk, we lose everything;
          // surface a clearer error so the user knows where it died.
          console.log(`[oneglance-sync] Strategy 2 chunk ${offset}/${tableInfo.totalRows} crashed:`, err?.message || err);
          throw new Error(
            `Stock report renderer crashed at row ~${offset}/${tableInfo.totalRows}. ` +
            `OneGlance loaded too many rows for the browser to scrape. ` +
            `Try a narrower date range or use the "Download CSV" button on OneGlance directly.`
          );
        }
        // Yield between chunks to let the renderer GC.
        await page.waitForTimeout(50);
      }

      if (csvLines.length > 1) {
        fs.writeFileSync(filePath, csvLines.join('\n') + '\n', 'utf-8');
        saved = true;
        console.log(`[oneglance-sync] Strategy 2 succeeded — scraped ${csvLines.length - 1} rows in chunks`);
      }
    }
  }

  if (!saved) {
    await debugScreenshot(page, '16-FAILED').catch(() => {});
    throw new Error(`Stock CSV failed: tables=${pageInfo.tableCount} csvBtn=${pageInfo.hasCsvBtn} url=${pageInfo.url}`);
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
      ...(isProd ? [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
        '--disable-extensions', '--disable-background-networking', '--disable-default-apps',
        '--disable-sync', '--disable-translate', '--metrics-recording-only',
        '--js-flags=--max-old-space-size=256',
        '--blink-settings=imagesEnabled=false', // skip loading images — saves memory
        '--disable-software-rasterizer',
      ] : []),
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
      // Close current page to free DOM memory before loading stock (30K rows)
      await page.close().catch(() => {});
      const stockPage = await context.newPage();

      const stockTimeout = 60_000;
      const stockResult = await Promise.race([
        downloadStockReport(stockPage, context, opts, downloadDir),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Stock report download timed out after ${stockTimeout / 1000}s`)), stockTimeout)
        ),
      ]);
      result.stockFile = stockResult;
      await stockPage.close().catch(() => {});
    }

    progress(opts, 'complete', 'Download complete!', 100);

    await browser.close().catch(() => {});
    return result;
  } catch (err: any) {
    await debugScreenshot(page, '99-ERROR').catch(() => {});
    await browser.close().catch(() => {});
    throw new Error(`Oneglance sync failed: ${err.message}`);
  }
}
