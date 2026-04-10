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

  // Wait for report to load (cap at 60s to avoid memory buildup)
  await page.waitForTimeout(5000);
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {
    console.log('[oneglance-sync] Stock report networkidle timed out at 60s, proceeding...');
  });
  await debugScreenshot(page, '12-stock-report-loaded');
  progress(opts, 'stock', 'Stock report loaded', 80);

  // ── Download Stock CSV using multiple strategies ──
  progress(opts, 'stock', 'Preparing CSV download...', 81);
  await debugScreenshot(page, '13-before-csv-download');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `oneglance-stock-${timestamp}.csv`;
  const filePath = path.join(downloadDir, filename);
  let saved = false;

  // Log page diagnostic info for debugging
  const pageInfo = await page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    const hasJQuery = !!(window as any).jQuery || !!(window as any).$;
    const hasDataTables = hasJQuery && typeof (window as any).jQuery?.fn?.dataTable === 'function';
    const dtTables = hasDataTables ? (window as any).jQuery('table.dataTable').length : 0;
    const allBtns: string[] = [];
    document.querySelectorAll('a, button, input, span').forEach(el => {
      const t = (el.textContent?.trim() || '').toLowerCase();
      const v = (el as HTMLInputElement).value?.toLowerCase() || '';
      if ((t === 'csv' || v === 'csv' || t.includes('export') || t.includes('download')) && !el.closest('table')) {
        allBtns.push(`<${el.tagName.toLowerCase()} class="${el.className}">${t || v}`);
      }
    });
    return { tableCount: tables.length, hasJQuery, hasDataTables, dtTables, csvButtons: allBtns };
  });
  console.log('[oneglance-sync] Page info:', JSON.stringify(pageInfo));

  // ── Strategy A: DataTables API extraction (most reliable) ──
  // DataTables stores ALL data in memory even when paginated — extract directly via API
  // IMPORTANT: Extract in CHUNKS to avoid OOM from serializing a huge string through CDP
  if (!saved && pageInfo.hasDataTables && pageInfo.dtTables > 0) {
    console.log('[oneglance-sync] Strategy A: extracting data via DataTables API (chunked)...');
    progress(opts, 'stock', 'Extracting data from table...', 82);

    try {
      // Step 1: Get headers and total row count (small payload)
      const meta = await page.evaluate(() => {
        try {
          const $ = (window as any).jQuery;
          if (!$ || !$.fn.dataTable) return null;
          const selectors = ['table.dataTable', 'table.display', 'table.table', '#DataTables_Table_0', 'table'];
          let dt: any = null;
          for (const sel of selectors) {
            try {
              const $t = $(sel).first();
              if ($t.length && $.fn.dataTable.isDataTable($t)) { dt = $t.DataTable(); break; }
            } catch {}
          }
          if (!dt) return null;
          const headers: string[] = [];
          dt.columns().every(function(this: any) { headers.push($(this.header()).text().trim()); });
          const totalRows = dt.rows({ search: 'none' }).count();
          return { headers, totalRows };
        } catch { return null; }
      });

      if (meta && meta.totalRows > 0) {
        console.log(`[oneglance-sync] Strategy A: found ${meta.totalRows} rows, ${meta.headers.length} columns`);
        // Write headers
        fs.writeFileSync(filePath, meta.headers.join(',') + '\n', 'utf-8');

        // Step 2: Extract in chunks of 200 rows to avoid OOM
        const CHUNK = 200;
        let extracted = 0;
        for (let start = 0; start < meta.totalRows; start += CHUNK) {
          const chunkCSV = await page.evaluate(({ s, c, colCount }: { s: number; c: number; colCount: number }) => {
            try {
              const $ = (window as any).jQuery;
              const selectors = ['table.dataTable', 'table.display', 'table.table', '#DataTables_Table_0', 'table'];
              let dt: any = null;
              for (const sel of selectors) {
                try {
                  const $t = $(sel).first();
                  if ($t.length && $.fn.dataTable.isDataTable($t)) { dt = $t.DataTable(); break; }
                } catch {}
              }
              if (!dt) return '';
              const allData = dt.rows({ search: 'none' }).data();
              const end = Math.min(s + c, allData.length);
              const lines: string[] = [];
              for (let i = s; i < end; i++) {
                const row: string[] = [];
                for (let j = 0; j < colCount; j++) {
                  let val = String(allData[i][j] ?? '').replace(/<[^>]*>/g, '').trim();
                  if (val.includes(',') || val.includes('"') || val.includes('\n'))
                    val = '"' + val.replace(/"/g, '""') + '"';
                  row.push(val);
                }
                lines.push(row.join(','));
              }
              return lines.join('\n');
            } catch { return ''; }
          }, { s: start, c: CHUNK, colCount: meta.headers.length });

          if (chunkCSV) {
            fs.appendFileSync(filePath, chunkCSV + '\n', 'utf-8');
            extracted += chunkCSV.split('\n').length;
          }
        }

        if (extracted > 0) {
          saved = true;
          console.log(`[oneglance-sync] Strategy A succeeded — extracted ${extracted} rows via DataTables API (chunked)`);
        }
      } else {
        console.log('[oneglance-sync] Strategy A: no DataTables data found');
      }
    } catch (e: any) {
      console.log('[oneglance-sync] Strategy A failed:', e.message);
    }
  }

  // ── Strategy B: Blob interception — monkey-patch URL.createObjectURL before clicking CSV ──
  // DataTables Buttons extension generates a Blob in JS and creates a temp <a> with blob URL
  // In headless mode, blob downloads often don't trigger Playwright's download event
  if (!saved) {
    console.log('[oneglance-sync] Strategy B: blob interception + click CSV...');
    progress(opts, 'stock', 'Downloading stock CSV...', 82);

    // Install blob interceptor BEFORE clicking the CSV button
    await page.evaluate(() => {
      (window as any).__capturedBlobCSV = null;
      const origCreateObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = function(obj: Blob | MediaSource) {
        // Intercept blob creation — read its content
        if (obj instanceof Blob) {
          const reader = new FileReader();
          reader.onload = () => {
            const text = reader.result as string;
            if (text && text.length > 10 && (text.includes(',') || text.includes('\t'))) {
              (window as any).__capturedBlobCSV = text;
            }
          };
          reader.readAsText(obj);
        }
        return origCreateObjectURL(obj);
      };
    });

    // Also set up download event + response listeners as secondary catches
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

    const dlHandler = page.waitForEvent('download', { timeout: 15_000 })
      .then(async (dl) => { await dl.saveAs(filePath); return 'download' as const; })
      .catch(() => null);

    // Click the CSV button
    await page.evaluate(() => {
      const allEls = document.querySelectorAll('a, button, input, span, div');
      for (const el of allEls) {
        const text = (el.textContent?.trim() || '').toLowerCase();
        const val = (el as HTMLInputElement).value?.toLowerCase() || '';
        if ((text === 'csv' || val === 'csv') && !el.closest('table') && el.tagName !== 'SCRIPT') {
          (el as HTMLElement).click();
          return;
        }
      }
    });

    // Wait for blob interception or download event (up to 10s)
    const dlResult = await Promise.race([
      dlHandler,
      new Promise<null>(r => setTimeout(() => r(null), 10_000)),
    ]);

    // Check blob interceptor result
    const blobCSV = await page.evaluate(() => (window as any).__capturedBlobCSV);

    page.off('response', responseListener);

    if (dlResult === 'download') {
      saved = true;
      console.log('[oneglance-sync] Strategy B succeeded via download event');
    } else if (blobCSV && blobCSV.trim().length > 50) {
      fs.writeFileSync(filePath, blobCSV, 'utf-8');
      saved = true;
      const rowCount = blobCSV.split('\n').length - 1;
      console.log(`[oneglance-sync] Strategy B succeeded via blob interception — ${rowCount} rows`);
    } else if (capturedCSV) {
      fs.writeFileSync(filePath, capturedCSV, 'utf-8');
      saved = true;
      console.log('[oneglance-sync] Strategy B succeeded via response interception');
    } else {
      console.log('[oneglance-sync] Strategy B: no data captured (blob:', !!blobCSV, 'download:', !!dlResult, 'response:', !!capturedCSV, ')');
    }
  }

  // ── Strategy C: Direct fetch via href (for anchor-based CSV buttons) ──
  if (!saved) {
    const csvBtnInfo = await page.evaluate(() => {
      const allEls = document.querySelectorAll('a, button, input, span, div');
      for (const el of allEls) {
        const text = (el.textContent?.trim() || '').toLowerCase();
        const val = (el as HTMLInputElement).value?.toLowerCase() || '';
        if ((text === 'csv' || val === 'csv') && !el.closest('table') && el.tagName !== 'SCRIPT') {
          return {
            tag: el.tagName.toLowerCase(),
            href: (el as HTMLAnchorElement).href || '',
          };
        }
      }
      return null;
    });

    if (csvBtnInfo?.tag === 'a' && csvBtnInfo.href && !csvBtnInfo.href.endsWith('#') && !csvBtnInfo.href.startsWith('javascript:') && !csvBtnInfo.href.startsWith('blob:')) {
      console.log('[oneglance-sync] Strategy C: fetching CSV via href...');
      progress(opts, 'stock', 'Downloading stock CSV (direct)...', 83);
      try {
        const content = await page.evaluate(async (url: string) => {
          const resp = await fetch(url, { credentials: 'include' });
          return resp.text();
        }, csvBtnInfo.href);
        if (content && content.trim().length > 50) {
          fs.writeFileSync(filePath, content, 'utf-8');
          saved = true;
          console.log('[oneglance-sync] Strategy C succeeded — CSV fetched directly');
        }
      } catch (e: any) {
        console.log('[oneglance-sync] Strategy C failed:', e.message);
      }
    }
  }

  // ── Strategy D: Scrape the visible HTML table directly (ultimate fallback) ──
  if (!saved) {
    console.log('[oneglance-sync] Strategy D: scraping table data from page...');
    progress(opts, 'stock', 'Extracting table data...', 83);
    await debugScreenshot(page, '15-scrape-fallback');

    // Try to show ALL rows by changing DataTables page length
    await page.evaluate(() => {
      // Try multiple selector patterns for the page length dropdown
      const selectors = ['select[name$="_length"]', 'select.form-control', '.dataTables_length select'];
      for (const sel of selectors) {
        const dropdown = document.querySelector(sel) as HTMLSelectElement;
        if (!dropdown) continue;
        const allOpt = Array.from(dropdown.options).find(o => o.value === '-1' || o.textContent?.trim().toLowerCase() === 'all');
        if (allOpt) {
          dropdown.value = allOpt.value;
          dropdown.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
        // Use largest available option
        const nums = Array.from(dropdown.options).filter(o => parseInt(o.value) > 0);
        if (nums.length > 0) {
          const largest = nums.reduce((a, b) => parseInt(a.value) > parseInt(b.value) ? a : b);
          dropdown.value = largest.value;
          dropdown.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
    });
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

    // Scrape table page by page — write each page's rows immediately to avoid OOM
    let totalScraped = 0;
    let headersWritten = false;
    let pageNum = 0;
    const MAX_PAGES = 50;

    while (pageNum < MAX_PAGES) {
      const tableData = await page.evaluate(() => {
        const selectors = ['table.dataTable', 'table.display', 'table.table-bordered', '#DataTables_Table_0', 'table'];
        let table: HTMLTableElement | null = null;
        for (const sel of selectors) {
          const t = document.querySelector(sel) as HTMLTableElement;
          if (t && t.querySelector('tbody tr')) { table = t; break; }
        }
        if (!table) return { headers: [] as string[], csv: '', rowCount: 0, hasNext: false };

        const ths: string[] = [];
        table.querySelectorAll('thead th').forEach(th => ths.push((th as HTMLElement).innerText?.trim() || ''));
        const lines: string[] = [];
        table.querySelectorAll('tbody tr').forEach(tr => {
          const cells: string[] = [];
          tr.querySelectorAll('td').forEach(td => {
            let t = (td as HTMLElement).innerText?.trim() || '';
            if (t.includes(',') || t.includes('"') || t.includes('\n')) t = '"' + t.replace(/"/g, '""') + '"';
            cells.push(t);
          });
          if (cells.length > 0 && cells.some(c => c.length > 0)) lines.push(cells.join(','));
        });
        const nextBtn = document.querySelector(
          '.paginate_button.next:not(.disabled), a.next:not(.disabled), .pagination .next:not(.disabled), [class*="paginate"] .next:not(.disabled)'
        );
        return { headers: ths, csv: lines.join('\n'), rowCount: lines.length, hasNext: !!nextBtn };
      });

      // Write headers once, then append rows
      if (!headersWritten && tableData.headers.length > 0) {
        fs.writeFileSync(filePath, tableData.headers.join(',') + '\n', 'utf-8');
        headersWritten = true;
      }
      if (tableData.csv) {
        fs.appendFileSync(filePath, tableData.csv + '\n', 'utf-8');
        totalScraped += tableData.rowCount;
      }
      pageNum++;

      if (!tableData.hasNext || tableData.rowCount === 0) break;

      await page.locator('.paginate_button.next, a.next, .pagination .next').first().click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    }

    if (totalScraped > 0) {
      saved = true;
      console.log(`[oneglance-sync] Strategy D succeeded — scraped ${totalScraped} rows from ${pageNum} pages`);
    }
  }

  if (!saved) {
    await debugScreenshot(page, '16-FAILED-all-strategies');
    const debugInfo = await getPageDebugInfo(page);
    console.log('[oneglance-sync] All strategies failed. Page debug:\n', debugInfo);
    // Include diagnostic info in error so it shows in the UI
    const diagSummary = `tables=${pageInfo.tableCount} jQuery=${pageInfo.hasJQuery} DT=${pageInfo.hasDataTables} dtTables=${pageInfo.dtTables} btns=[${pageInfo.csvButtons.join(',')}]`;
    throw new Error(`Stock CSV download failed. Page: ${diagSummary}`);
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
      // Wrap stock download in a 90-second timeout to prevent OOM crashes
      const stockTimeout = 90_000;
      const stockResult = await Promise.race([
        downloadStockReport(page, context, opts, downloadDir),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Stock report download timed out after ${stockTimeout / 1000}s`)), stockTimeout)
        ),
      ]);
      result.stockFile = stockResult;
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
