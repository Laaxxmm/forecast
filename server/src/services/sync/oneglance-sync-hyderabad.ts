// Hyderabad-specific OneGlance scraper.
//
// Same conceptual flow as oneglance-sync.ts (login → navigate → set
// filters → click action → download CSV) but targets a different
// OneGlance instance and a different navigation tree:
//
//   emr7  flow: Utility page → expand PHARMACY → Purchase/Sales Report
//   emr25 flow: Reports tab (sidebar icon) → expand STORE → Purchase/
//               Sales Report - Store  (or Transfered Stocks / Stock
//               Report - store, depending on the report)
//
// IMPORTANT: oneglance-sync.ts (emr7) is intentionally left untouched
// so non-Hyderabad branches keep working with their existing flow. The
// runner dispatches between the two scrapers based on branch role +
// city.
//
// Coverage progresses report-by-report:
//   Purchase Report at central Store           ✅
//   Sales Report at satellite                  ✅
//   Stock Transfer Details at satellite        ✅
//   Stock Report at satellite                  ⏳ next
//
// All reports share the same login + Reports-icon / STORE-expand prefix
// — that's `openStoreSubmenu`. They differ in (a) which sub-menu item
// to click and (b) which fields the filter form has and which action
// button renders the report. The download / blob-capture code is
// identical and lives in `captureCsvAndSave`.

import { chromium, type Page, type BrowserContext } from 'playwright';
import path from 'path';
import fs from 'fs';

export interface OneglanceHyderabadSyncOptions {
  username: string;
  password: string;
  fromDate: string;  // YYYY-MM-DD
  toDate: string;    // YYYY-MM-DD
  /** Which reports to download in this run. Subset progressively grows. */
  reports: Array<'purchase' | 'sales' | 'transfer'>;
  /**
   * OneGlance "Center" filter value for satellite Sales / Stock /
   * Transfer runs (e.g. "MAGNACODE - FILM NAGAR" for Jubliee Hills).
   * Required when `reports` includes 'sales' or 'transfer'. Ignored for
   * Purchase at the central Store (which leaves the Center field blank
   * to capture all procurement).
   */
  oneglanceCenter?: string;
  onProgress?: (step: string, message: string, pct: number) => void;
}

export interface OneglanceHyderabadSyncResult {
  purchaseFile?: { filePath: string; filename: string };
  salesFile?: { filePath: string; filename: string };
  transferFile?: { filePath: string; filename: string };
  // Future entries (one per supported report):
  //   stockFile?
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
 * From the post-login Dashboard, click the Reports icon in the left
 * sidebar and expand the STORE category so its sub-items become
 * clickable. Shared by every Hyderabad report flow — Purchase/Sales,
 * Stock, Stock Transfer all live under STORE.
 *
 * Each step verifies the resulting page state before moving on so we
 * fail with a useful error message + screenshot instead of silently
 * trying to interact with a page that didn't load.
 */
async function openStoreSubmenu(page: Page, opts: OneglanceHyderabadSyncOptions): Promise<void> {
  // Step 1: click the Reports icon. The sidebar has a column of icons
  // (Home, Calendar, +Note, Lab, Pill, User, Tools/Reports, Building).
  // The Reports icon sits 7th from top in the user's screenshots, but
  // OneGlance doesn't put text labels on the icons — we have to find
  // the wrench/tools icon by other means.
  progress(opts, 'navigate', 'Opening Reports section...', 16);
  await debugScreenshot(page, '03a-before-reports-click');

  // Diagnostic dump: every clickable element in the leftmost ~100px,
  // sorted by Y position. Logged so we can debug structure mismatches
  // without another round trip to the user.
  const sidebarDump = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('a, button, [role="button"], [onclick]'));
    return all.map((el, idx) => {
      const r = el.getBoundingClientRect();
      return {
        idx,
        tag: el.tagName,
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height),
        text: (el.textContent || '').trim().slice(0, 40),
        title: el.getAttribute('title') || '',
        aria: el.getAttribute('aria-label') || '',
        href: (el as HTMLAnchorElement).href || '',
        onclick: el.getAttribute('onclick') || '',
        cls: (el.className || '').toString().slice(0, 60),
      };
    }).filter(e => e.x < 120 && e.y > 0 && e.w > 10 && e.h > 10).sort((a, b) => a.y - b.y);
  });
  console.log('[oneglance-hyderabad] sidebar candidates (x<120):', JSON.stringify(sidebarDump, null, 2));

  let reportsOpened = false;

  // Strategy 1: any element whose href / onclick / id mentions "report"
  // or "utility" (the route name OneGlance uses for the reports page).
  if (!reportsOpened) {
    const hrefClicked = await page.evaluate(() => {
      const all = document.querySelectorAll('a, button, [role="button"], [onclick]');
      for (const el of all) {
        const href = ((el as HTMLAnchorElement).href || '').toLowerCase();
        const onclick = (el.getAttribute('onclick') || '').toLowerCase();
        const id = (el.id || '').toLowerCase();
        if (href.match(/utility|report/i) || onclick.match(/utility|report/i) || id.match(/report/i)) {
          (el as HTMLElement).click();
          return { href, onclick, id };
        }
      }
      return null;
    });
    if (hrefClicked) {
      console.log('[oneglance-hyderabad] clicked via href/onclick:', JSON.stringify(hrefClicked));
      reportsOpened = true;
    }
  }

  // Strategy 2: aria/title attribute equals "reports" / "report"
  if (!reportsOpened) {
    const ariaClicked = await page.evaluate(() => {
      const candidates = document.querySelectorAll('[title], [aria-label]');
      for (const el of candidates) {
        const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
        if (label === 'reports' || label === 'report') {
          (el as HTMLElement).click();
          return label;
        }
      }
      return null;
    });
    if (ariaClicked) {
      console.log('[oneglance-hyderabad] clicked via aria/title:', ariaClicked);
      reportsOpened = true;
    }
  }

  // Strategy 3: visible "REPORTS" header anywhere on screen (some
  // installs put the section name as a clickable breadcrumb chip).
  if (!reportsOpened) {
    const reportsTextLink = page.locator('a, button').filter({ hasText: /^\s*REPORTS?\s*$/i }).first();
    if (await reportsTextLink.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await reportsTextLink.click({ timeout: 5_000 });
      reportsOpened = true;
    }
  }

  // Strategy 4: positional fallback. The user's screenshots show the
  // sidebar icons in a fixed column on the very left (x ≈ 0–80) with
  // 8 icons stacked vertically. Reports is the 7th. Click it by Y
  // position — using the diagnostic dump above we already have the
  // sorted list.
  if (!reportsOpened && sidebarDump.length >= 7) {
    const target = sidebarDump[6]; // 7th icon (0-indexed)
    console.log('[oneglance-hyderabad] positional fallback — clicking idx 6:', JSON.stringify(target));
    const handle = await page.evaluate((idx: number) => {
      const all = Array.from(document.querySelectorAll('a, button, [role="button"], [onclick]'));
      const filtered = all.map((el, i) => ({ el: el as HTMLElement, i, r: el.getBoundingClientRect() }))
        .filter(e => e.r.x < 120 && e.r.y > 0 && e.r.width > 10 && e.r.height > 10)
        .sort((a, b) => a.r.y - b.r.y);
      const t = filtered[idx];
      if (t) {
        t.el.click();
        return true;
      }
      return false;
    }, 6);
    if (handle) reportsOpened = true;
  }

  if (!reportsOpened) {
    await debugScreenshot(page, '03b-FAILED-reports-icon-not-found');
    throw new Error(
      `Could not click the Reports icon in the left sidebar. Found ${sidebarDump.length} sidebar candidates — see server logs for the dump.`,
    );
  }

  // Confirm the Reports view actually loaded by waiting for one of the
  // category headers (ACCOUNTS / CLINIC / IP / LAB / PHARMACY / STORE).
  await page.waitForTimeout(1500);
  await page.locator('text=/^STORE$/i').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(async () => {
    await debugScreenshot(page, '03c-FAILED-reports-page-not-loaded');
    throw new Error('Clicked the Reports icon but the report category list did not appear.');
  });
  await debugScreenshot(page, '03d-reports-view-loaded');
  progress(opts, 'navigate', 'Reports view loaded', 20);

  // Step 2: click STORE to expand its sub-items. STORE is a category
  // header — clicking it should reveal its full set of report links.
  // We don't verify a specific sub-item here (that's the caller's job)
  // because different report flows want different links. We just give
  // the menu a moment to expand.
  progress(opts, 'navigate', 'Expanding STORE menu...', 22);
  const storeHeader = page.locator('text=/^STORE$/i').first();
  await storeHeader.click({ timeout: 5_000, force: true });
  await page.waitForTimeout(800);
  await debugScreenshot(page, '04-after-store-click');
}

/**
 * After STORE is expanded, click a specific sub-menu item by visible
 * text, then verify the filter-form date inputs appear (proof the
 * report page loaded).
 *
 * @param menuRegex  visible-text pattern of the menu item (e.g.
 *                   /Purchase\s*\/\s*Sales\s+Report\s*-?\s*Store/i).
 *                   Allow flexible spacing/punctuation because OneGlance
 *                   sometimes inserts non-breaking spaces.
 * @param label      human-readable name for error messages and logs.
 */
async function clickStoreReportLink(
  page: Page,
  opts: OneglanceHyderabadSyncOptions,
  menuRegex: RegExp,
  label: string,
): Promise<void> {
  progress(opts, 'navigate', `Opening ${label}...`, 25);

  const reportLink = page.locator('a, div, span, li, button').filter({ hasText: menuRegex }).first();
  let visible = await reportLink.isVisible({ timeout: 3_000 }).catch(() => false);
  if (!visible) {
    // STORE click may have been intercepted (header element vs button).
    // Try clicking it again with a different strategy.
    await page.locator('text=/^STORE$/i').first().click({ timeout: 3_000, force: true }).catch(() => {});
    await page.waitForTimeout(1_500);
    visible = await reportLink.isVisible({ timeout: 3_000 }).catch(() => false);
  }

  if (!visible) {
    // Last-ditch: scroll the STORE sub-menu and search by text content.
    // The menu is scrollable when there are many items (Stock Transfer
    // is near the bottom — past Stock Slow Moving Reports — and only
    // appears after a scroll).
    const found = await page.evaluate((patternSrc: string) => {
      const re = new RegExp(patternSrc, 'i');
      const all = document.querySelectorAll('a, div, span, li, button');
      for (const el of all) {
        const text = (el.textContent || '').trim();
        if (text.length < 80 && re.test(text)) {
          (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'auto' });
          (el as HTMLElement).click();
          return { matched: true, text };
        }
      }
      return { matched: false, text: null };
    }, menuRegex.source);
    if (!found.matched) {
      await debugScreenshot(page, `05-FAILED-menu-not-found-${label.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`);
      throw new Error(`Could not find "${label}" link in the STORE menu.`);
    }
    console.log(`[oneglance-hyderabad] Clicked menu link via DOM scroll fallback: ${found.text}`);
  } else {
    await reportLink.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
    await reportLink.click({ timeout: 8_000, force: true });
  }

  // Confirm the report filter form loaded by waiting for the date inputs.
  await page.waitForTimeout(2_500);
  try { await page.waitForLoadState('networkidle', { timeout: 20_000 }); } catch {
    console.log('[oneglance-hyderabad] networkidle timeout while loading report page; proceeding');
  }
  const dateInput = page.locator('input.dateclass, input[placeholder="DD/MM/YYYY"]').first();
  if (!(await dateInput.isVisible({ timeout: 10_000 }).catch(() => false))) {
    await debugScreenshot(page, `06-FAILED-filter-form-not-loaded-${label.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`);
    throw new Error(`Clicked "${label}" but the filter form (Period date inputs) did not appear.`);
  }
  await debugScreenshot(page, `06-filter-form-loaded-${label.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`);
  progress(opts, 'navigate', 'Report page loaded', 30);
}

async function navigateToStorePurchaseSalesReport(
  page: Page,
  opts: OneglanceHyderabadSyncOptions,
): Promise<void> {
  await openStoreSubmenu(page, opts);
  await clickStoreReportLink(
    page, opts,
    /Purchase\s*\/\s*Sales\s+Report\s*-?\s*Store/i,
    'Purchase/Sales Report - Store',
  );
}

/**
 * Stock Transfer Details lives under STORE → "Transfered Stocks" (note
 * OneGlance's typo: only one 'r'). The menu item sits below several
 * other reports so we may need to scroll to find it.
 */
async function navigateToTransferedStocks(
  page: Page,
  opts: OneglanceHyderabadSyncOptions,
): Promise<void> {
  await openStoreSubmenu(page, opts);
  // Match both "Transfered" (the OneGlance typo we observe today) and
  // the correct "Transferred" spelling, just in case the typo gets
  // fixed upstream. Also accept singular "Stock".
  await clickStoreReportLink(
    page, opts,
    /Trans?ferr?ed\s+Stocks?/i,
    'Transfered Stocks',
  );
}

// ─────────────────────────────────────────────────────────────────────
// Filter-form helpers — shared between Purchase/Sales and Transfer.
// Both pages have Period From / To date inputs and a Center typeahead.
// They differ in whether they have a Type radio (Purchase/Sales: yes,
// Transfer: no) and which action button renders the report.
// ─────────────────────────────────────────────────────────────────────

async function setDateRange(
  page: Page,
  opts: OneglanceHyderabadSyncOptions,
  stepKey: string,
): Promise<void> {
  const fromDateStr = toOneglanceDate(opts.fromDate);
  const toDateStr = toOneglanceDate(opts.toDate);

  const dateInputs = page.locator('input.dateclass, input[placeholder="DD/MM/YYYY"]');
  const dateCount = await dateInputs.count();
  if (dateCount < 2) {
    await debugScreenshot(page, `07-FAILED-no-date-inputs-${stepKey}`);
    throw new Error(`Expected at least 2 date inputs on the filter form, found ${dateCount}.`);
  }
  const fromInput = dateInputs.first();
  const toInput = dateInputs.nth(1);

  // Strip readonly, set value, dispatch change/input. Press Escape to
  // dismiss any datepicker that opens.
  const setOne = async (input: any, dateStr: string) => {
    await input.evaluate((el: HTMLInputElement, val: string) => {
      el.removeAttribute('readonly');
      el.value = val;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, dateStr);
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  };

  await setOne(fromInput, fromDateStr);
  await setOne(toInput, toDateStr);
  progress(opts, stepKey, `Dates: ${fromDateStr} → ${toDateStr}`, 40);
}

/**
 * Fill the Center typeahead. The Center field is a `<textarea>` with
 * class `editctrl rpinput_edit` (NOT a standard `<input>`), and its
 * label is rendered as a sibling cell above the field — there's no
 * `<label for=...>` linkage. We try several detection strategies in
 * order, then type the suffix after "MAGNACODE - " to narrow the
 * dropdown, and click the matching option.
 *
 * Caller is responsible for guarding on `centerName` truthiness — if
 * the report doesn't need a Center filter (e.g. Purchase at the central
 * Store, which leaves Center blank to capture all procurement), don't
 * call this helper at all.
 */
async function setCenterField(
  page: Page,
  opts: OneglanceHyderabadSyncOptions,
  stepKey: string,
  centerName: string,
): Promise<void> {
  progress(opts, stepKey, `Selecting Center: ${centerName}...`, 46);

  // NOTE: Everything inside this evaluate() runs in the browser context.
  // Avoid named function declarations — esbuild/tsx wraps them with
  // `__name(fn, "...")` decorations that don't exist in the browser,
  // throwing `ReferenceError: __name is not defined`. Use only arrow
  // expressions, ternaries, and inline lookups. (The init script in
  // syncOneglanceHyderabad shims `__name` as a no-op for safety.)

  // Strategy 0 — Playwright's native label resolution. This handles
  // <label for=...>, aria-labelledby, and implicit <label><input/></label>
  // containment all at once. Tag whatever it finds with data-mt-center
  // so the rest of the flow can locate it.
  let tagged: any = null;
  try {
    const byLabel = page.getByLabel(/^\s*Center\s*:?\s*$/i, { exact: false }).first();
    if (await byLabel.count() > 0) {
      const ok = await byLabel.evaluate(el => {
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 30 || r.height < 10) return false;
        el.setAttribute('data-mt-center', '1');
        return true;
      }).catch(() => false);
      if (ok) tagged = { method: 'playwright-getByLabel' };
    }
  } catch { /* fall through */ }

  if (!tagged) tagged = await page.evaluate(() => {
    // Clear any prior tag so a re-run doesn't pick up the previous match.
    document.querySelectorAll('[data-mt-center="1"]').forEach(el => el.removeAttribute('data-mt-center'));

    // Strategy A: visual-order label match. Build a sorted list of every
    // visible label-bearing element AND every visible text input on the
    // page, sorted by Y then X. The Center input is the input whose
    // IMMEDIATELY-PRECEDING label (in visual order) has own-text exactly
    // "Center" / "Center:". Beats sibling-walking because it doesn't
    // depend on parent/child structure — only on what the user sees.
    type Item = { kind: 'label' | 'input'; el: Element; text: string; x: number; y: number };
    const items: Item[] = [];

    const labelTags = ['label', 'th', 'td', 'dt', 'span', 'div', 'p'];
    for (const sel of labelTags) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || (el as HTMLElement).offsetParent === null) continue;
        const ownText = Array.from(el.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => (n.textContent || '').trim())
          .join(' ').trim();
        if (ownText && ownText.length < 60) {
          items.push({ kind: 'label', el, text: ownText, x: Math.round(r.x), y: Math.round(r.y) });
        }
      }
    }
    // Include <textarea> too — OneGlance's typeahead fields (Center,
    // Stockist, Product Name, Brand Name) are textareas with class
    // `editctrl rpinput_edit`, not standard <input>s. Single-line
    // inputs (Invoice No, Batch No, dates) are real inputs.
    for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input[type="text"], input[type="search"], input:not([type]), textarea'
    )) {
      const r = el.getBoundingClientRect();
      if (r.width < 50 || r.height < 10 || el.offsetParent === null) continue;
      items.push({ kind: 'input', el, text: '', x: Math.round(r.x), y: Math.round(r.y) });
    }

    items.sort((a, b) => (a.y - b.y) || (a.x - b.x));

    for (let i = 0; i < items.length; i++) {
      if (items[i].kind !== 'input') continue;
      for (let j = i - 1; j >= 0; j--) {
        if (items[j].kind !== 'label') continue;
        const t = items[j].text;
        if (/^Center:?\s*$/i.test(t)) {
          (items[i].el as HTMLInputElement).setAttribute('data-mt-center', '1');
          return { method: 'visual-order-label', label: t, x: items[i].x, y: items[i].y };
        }
        // Stop at the FIRST label preceding this input — if it's
        // not "Center", this input belongs to a different field.
        break;
      }
    }

    // Strategy B: any input/textarea whose attributes literally mention
    // "center" with word boundaries (avoids false positives like
    // "centered" or "center-align" CSS classes).
    for (const inp of document.querySelectorAll<HTMLInputElement>('input, textarea')) {
      const r = inp.getBoundingClientRect();
      if (r.width < 50 || r.height < 10 || inp.offsetParent === null) continue;
      const blob = `${inp.name || ''} ${inp.id || ''} ${inp.placeholder || ''} ${inp.getAttribute('aria-label') || ''} ${inp.getAttribute('data-name') || ''}`.toLowerCase();
      if (/\bcenter\b/.test(blob) || /\bcentre\b/.test(blob)) {
        inp.setAttribute('data-mt-center', '1');
        return { method: 'attr-word-boundary', blob };
      }
    }

    // Strategy C: positional — the first visible text-input-or-textarea
    // below any radio group (Purchase/Sales) OR (when there's no radio
    // group, e.g. on the Transfer page) the first visible textarea on
    // the form. OneGlance's Center typeahead is a <textarea>, not an
    // <input>, on every Hyderabad report we've encountered.
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
      .filter(r => r.offsetParent !== null);
    if (radios.length > 0) {
      const radioBottom = Math.max(...radios.map(r => r.getBoundingClientRect().bottom));
      const textInputs = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[type="text"], input[type="search"], input:not([type]), textarea'
      )).filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 50 && r.height > 10 && el.offsetParent !== null && r.top > radioBottom;
      });
      if (textInputs.length > 0) {
        textInputs.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        textInputs[0].setAttribute('data-mt-center', '1');
        return { method: 'visual-position-below-radios' };
      }
    }
    // No radios? Try the first visible textarea on the page (Transfer).
    const textareas = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea'))
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 50 && r.height > 10 && el.offsetParent !== null;
      });
    if (textareas.length > 0) {
      textareas.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      textareas[0].setAttribute('data-mt-center', '1');
      return { method: 'first-visible-textarea' };
    }

    return null;
  });

  if (!tagged) {
    await debugScreenshot(page, `07b-FAILED-center-input-not-found-${stepKey}`);
    // Dump the form's visible labels + inputs to a JSON file the user
    // can share — far more actionable than just "not found".
    try {
      const dump = await page.evaluate(() => {
        const out: any = { url: location.href, items: [] as any[] };
        for (const sel of ['label', 'th', 'td', 'dt', 'span', 'div', 'p']) {
          for (const el of document.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || (el as HTMLElement).offsetParent === null) continue;
            const ownText = Array.from(el.childNodes)
              .filter(n => n.nodeType === Node.TEXT_NODE)
              .map(n => (n.textContent || '').trim())
              .join(' ').trim();
            if (ownText && ownText.length < 60) {
              out.items.push({ kind: 'label', tag: el.tagName, text: ownText, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
            }
          }
        }
        for (const el of document.querySelectorAll<HTMLInputElement>('input, textarea, select')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0 || (el as HTMLElement).offsetParent === null) continue;
          out.items.push({
            kind: 'input', tag: el.tagName,
            type: (el as HTMLInputElement).type || '',
            name: (el as HTMLInputElement).name || '',
            id: el.id || '',
            placeholder: (el as HTMLInputElement).placeholder || '',
            ariaLabel: el.getAttribute('aria-label') || '',
            cls: (el.className || '').toString().slice(0, 80),
            x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          });
        }
        out.items.sort((a: any, b: any) => (a.y - b.y) || (a.x - b.x));
        return out;
      });
      const dumpPath = path.join(DEBUG_DIR, `07c-form-dump-${stepKey}.json`);
      fs.writeFileSync(dumpPath, JSON.stringify(dump, null, 2));
      console.log(`[oneglance-hyderabad] Center detection failed. Form dump saved to ${dumpPath}`);
      console.log(`[oneglance-hyderabad] Visible items near "Center":`,
        JSON.stringify(dump.items.filter((it: any) => /center/i.test(it.text || '') || /center/i.test(it.id || '') || /center/i.test(it.name || '')), null, 2));
    } catch (e: any) {
      console.warn('[oneglance-hyderabad] Form dump failed:', e?.message);
    }
    throw new Error(
      'Could not locate the Center field on the report filter form. ' +
      'A diagnostic dump of every visible label + input has been saved under data/uploads/debug-hyderabad/ ' +
      `(filename: 07c-form-dump-${stepKey}.json). Download it via /api/debug/hyderabad/file?path=07c-form-dump-${stepKey}.json`,
    );
  }
  console.log(`[oneglance-hyderabad] Center field located via ${tagged.method}:`, JSON.stringify(tagged));
  const centerHandle = page.locator('[data-mt-center="1"]').first();

  // Type the full center name and wait for the typeahead dropdown.
  await centerHandle.click({ timeout: 3_000 });
  await centerHandle.fill('');
  await page.waitForTimeout(200);
  // Type a short prefix that's still discriminating (skip the
  // "MAGNACODE - " part since every option starts with that).
  const typeable = centerName.replace(/^MAGNACODE\s*-\s*/i, '').trim();
  await page.keyboard.type(typeable, { delay: 30 });
  await page.waitForTimeout(700);
  await debugScreenshot(page, `07c-center-typeahead-${stepKey}`);

  // Click the matching dropdown option. The dropdown items show the
  // full center name (e.g. "MAGNACODE - MARREDPALLY"). We try
  // Playwright text locator first, then a DOM search as a fallback.
  const optionLoc = page.locator(`text=${centerName}`).first();
  let optionClicked = await optionLoc.isVisible({ timeout: 2_500 }).catch(() => false);
  if (optionClicked) {
    await optionLoc.click({ timeout: 5_000 });
  } else {
    const found = await page.evaluate((name: string) => {
      const all = document.querySelectorAll('li, div, span, button, a');
      for (const el of all) {
        const txt = (el.textContent || '').trim();
        if (txt === name && (el as HTMLElement).offsetParent !== null) {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, centerName);
    if (!found) {
      // Last resort: press Enter to accept the first dropdown option
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
    }
  }
  await page.waitForTimeout(400);
  await debugScreenshot(page, `07d-center-selected-${stepKey}`);
  progress(opts, stepKey, `Center: ${centerName}`, 47);
}

/**
 * Wait until the OneGlance report renderer has actually painted the
 * data table. networkidle is unreliable here because OneGlance fires a
 * session keep-alive ping every 5 seconds — the network is never truly
 * idle. Instead watch for distinctive markers that only appear AFTER
 * the report data has been rendered:
 *   1. A "Filter by Period" header (matches both "Filter by Period:"
 *      on the Sales/Purchase report and "Filter by Period From:" on
 *      the Stock Transfer Details report).
 *   2. The csv button (#csvbtn) attached to the DOM.
 *   3. At least one data <tr> with multiple <td>s in the rendered
 *      table (rules out the loading-spinner state where the structure
 *      exists but has no rows yet).
 * If none of these appear in 90 seconds we proceed anyway with a
 * warning — the click + blob interceptor downstream will surface a
 * clearer failure than this wait could.
 */
async function waitForRenderedReport(
  page: Page,
  opts: OneglanceHyderabadSyncOptions,
  stepKey: string,
): Promise<void> {
  progress(opts, stepKey, 'Waiting for report to render...', 55);
  try {
    await page.waitForFunction(
      () => {
        const text = document.body?.textContent || '';
        // Relaxed regex: matches "Filter by Period:" AND
        // "Filter by Period From:" — the latter shows up on the
        // Stock Transfer Details rendered report.
        if (!/Filter\s+by\s+Period/i.test(text)) return false;
        const csvBtn = document.querySelector('#csvbtn');
        if (!csvBtn) return false;
        // At least one row with 5+ cells (rules out empty header-only state).
        // Note: Stock Transfer's summary table at the top has 5 cells
        // (Total Products / Total Qty / Net Value / Purchase Value /
        // Purchase Price) which itself proves render — that's fine.
        const rows = document.querySelectorAll('tr');
        for (const tr of rows) {
          const cells = tr.querySelectorAll('td');
          if (cells.length >= 5) {
            const r = (tr as HTMLElement).getBoundingClientRect();
            if (r.height > 0 && (tr as HTMLElement).offsetParent !== null) return true;
          }
        }
        return false;
      },
      null,
      { timeout: 90_000, polling: 500 }
    );
    // Small settle time for any post-render animations / late row injection
    await page.waitForTimeout(1200);
    console.log(`[oneglance-hyderabad] Report rendered (${stepKey}), csv button + data rows detected`);
  } catch (e: any) {
    console.log(`[oneglance-hyderabad] Report-render wait timed out after 90s (${stepKey}): ${e?.message}`);
    console.log(`[oneglance-hyderabad] Proceeding anyway — downstream click + blob interceptor will surface the actual issue.`);
  }
  await debugScreenshot(page, `09-report-loaded-${stepKey}`);
  progress(opts, stepKey, 'Report rendered', 65);
}

/**
 * Click the csv button and capture the resulting download via three
 * concurrent paths (whichever fires first wins):
 *   1. Blob/anchor interceptor (the path OneGlance actually uses).
 *   2. Native Playwright `download` event.
 *   3. New-tab popup containing the CSV inline.
 *
 * Saves the captured CSV to `{downloadDir}/oneglance-hyderabad-{fileTypeLabel}-{ts}.csv`.
 */
async function captureCsvAndSave(
  page: Page,
  opts: OneglanceHyderabadSyncOptions,
  downloadDir: string,
  stepKey: string,
  fileTypeLabel: string,
): Promise<{ filePath: string; filename: string }> {
  progress(opts, stepKey, 'Downloading CSV...', 70);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `oneglance-hyderabad-${fileTypeLabel}-${timestamp}.csv`;
  const filePath = path.join(downloadDir, filename);

  const context = page.context();
  const downloadPromise = page.waitForEvent('download', { timeout: 90_000 }).catch(() => null);
  const popupPromise = context.waitForEvent('page', { timeout: 90_000 }).catch(() => null);

  // Capture every network request that fires while we're trying to
  // download. If the csv button silently does nothing OR makes a
  // background fetch that doesn't trigger download/popup, this log
  // tells us what URL the page actually hit so we can adapt.
  const networkLog: Array<{ method: string; url: string; status?: number; ts: number }> = [];
  const startTs = Date.now();
  const onRequest = (req: any) => {
    const url = req.url();
    if (url.startsWith('data:') || url.includes('chrome-extension')) return;
    networkLog.push({ method: req.method(), url, ts: Date.now() - startTs });
  };
  const onResponse = (resp: any) => {
    const entry = networkLog.find(e => e.url === resp.url() && e.status === undefined);
    if (entry) entry.status = resp.status();
  };
  page.on('request', onRequest);
  page.on('response', onResponse);

  // Click the csv button. Try strategies in order:
  //   1. Playwright's native click with force:true. Produces a real
  //      isTrusted=true mouse event from Chromium input dispatch.
  //   2. JS .click() in page.evaluate, which fires synthetic events.
  // The blob/anchor interceptors installed in addInitScript run in
  // every context and will capture any synthetic <a download> click
  // OneGlance triggers, regardless of which click strategy worked.
  let clickStrategy: string = 'none';
  const csvLocator = page.locator('#csvbtn').first();
  try {
    await csvLocator.click({ timeout: 10_000, force: true, noWaitAfter: true });
    clickStrategy = 'playwright-force-click';
  } catch (e1: any) {
    console.log('[oneglance-hyderabad] Playwright force-click failed, falling back to JS click:', e1?.message);
    const clicked = await page.evaluate(() => {
      const btn = document.querySelector('#csvbtn') as HTMLButtonElement | null;
      if (!btn) return { ok: false, reason: 'csvbtn-not-found' as const };
      try { btn.click(); } catch {}
      try { btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } catch {}
      if ((window as any).jQuery) {
        try { (window as any).jQuery(btn).trigger('click'); } catch {}
      }
      return { ok: true, reason: 'fired' as const };
    });
    if (!clicked.ok) {
      await debugScreenshot(page, `10b-FAILED-csvbtn-not-found-${stepKey}`);
      page.off('request', onRequest);
      page.off('response', onResponse);
      throw new Error(`Could not click the csv button: ${clicked.reason}`);
    }
    clickStrategy = 'js-evaluate-click';
  }
  console.log(`[oneglance-hyderabad] csv button click strategy: ${clickStrategy}`);
  await debugScreenshot(page, `10-after-csv-click-${stepKey}`);

  // Give the click handler a moment to do its thing (build the blob,
  // create the synthetic anchor, click it). 1.5s is empirical — enough
  // for client-side CSV generation on a multi-page report, fast enough
  // that we don't waste time on the happy path.
  await page.waitForTimeout(1500);

  // Check the blob/anchor capture FIRST — that's the path OneGlance
  // actually uses. If a synthetic <a download> was clicked with a blob
  // href, read the matching blob's content and save it ourselves.
  const captured = await page.evaluate(async () => {
    const cap = (window as any).__mtCsvCapture;
    if (!cap) return null;
    const anchor = cap.anchors[cap.anchors.length - 1]; // most recent
    if (!anchor) return { anchorCount: 0, blobCount: cap.blobs.length };
    const blobEntry = cap.blobs.find((b: any) => b.url === anchor.href);
    if (!blobEntry) {
      return { anchorCount: cap.anchors.length, blobCount: cap.blobs.length, anchor, error: 'blob-url-not-matched' };
    }
    const text = await blobEntry.blob.text();
    return {
      anchorCount: cap.anchors.length,
      blobCount: cap.blobs.length,
      anchor,
      type: blobEntry.type,
      size: blobEntry.size,
      content: text,
    };
  }).catch(() => null);

  if (captured?.content && captured.content.length > 50) {
    fs.writeFileSync(filePath, captured.content, 'utf-8');
    console.log(`[oneglance-hyderabad] CSV captured via blob interceptor: ${captured.size} bytes, type=${captured.type}, download=${captured.anchor?.download}`);
    progress(opts, stepKey, 'CSV captured (blob interceptor)', 80);
    page.off('request', onRequest);
    page.off('response', onResponse);
    return { filePath, filename };
  }
  console.log(`[oneglance-hyderabad] Blob interceptor capture state:`, JSON.stringify(captured));

  // Race: whichever fires first wins. If both fail, throw with diagnostics.
  const winner = await Promise.race([
    downloadPromise.then(d => d ? { kind: 'download' as const, d } : null),
    popupPromise.then(p => p ? { kind: 'popup' as const, p } : null),
  ]);

  if (winner?.kind === 'download') {
    await winner.d.saveAs(filePath);
    progress(opts, stepKey, 'CSV downloaded (file)', 80);
  } else if (winner?.kind === 'popup') {
    const popup = winner.p;
    try {
      await popup.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
      const csvText = await popup.evaluate(() => document.body?.innerText || '');
      if (!csvText || csvText.length < 50) {
        await debugScreenshot(popup, `10b-popup-empty-${stepKey}`);
        throw new Error(`CSV popup content was empty (length=${csvText?.length || 0})`);
      }
      fs.writeFileSync(filePath, csvText, 'utf-8');
      progress(opts, stepKey, 'CSV downloaded (popup)', 80);
    } finally {
      await popup.close().catch(() => {});
    }
  } else {
    await debugScreenshot(page, `10c-FAILED-no-download-event-${stepKey}`);
    page.off('request', onRequest);
    page.off('response', onResponse);

    const logPath = path.join(DEBUG_DIR, `10d-network-after-csv-click-${stepKey}.json`);
    try {
      fs.writeFileSync(logPath, JSON.stringify(networkLog, null, 2));
    } catch {}
    console.log(`[oneglance-hyderabad] No download/popup fired. Network log saved to ${logPath}`);
    console.log(`[oneglance-hyderabad] Network log (${networkLog.length} entries):`);
    console.log(JSON.stringify(networkLog.slice(0, 30), null, 2));

    throw new Error(
      `CSV download never fired within 90s. The csv button click was dispatched but produced no download event AND no popup tab. ` +
      `Network log saved to ${logPath} (${networkLog.length} requests captured).`,
    );
  }
  page.off('request', onRequest);
  page.off('response', onResponse);

  return { filePath, filename };
}

/**
 * Click an action button (e.g. "Detailed", "Transfer Report") that
 * generates the report. OneGlance's Center typeahead, after a value is
 * selected, renders the selection as a `<textarea readonly>` grid row
 * that on smaller filter forms (notably Stock Transfer Details, which
 * only has Period + Center) can visually overlap the button area
 * below — Playwright's strict actionability check then refuses the
 * click with `<textarea ...> from <tr>...</tr> subtree intercepts
 * pointer events`.
 *
 * Strategies, in order:
 *   1. scrollIntoViewIfNeeded so the button is at least in viewport
 *      (sometimes it just needs to scroll past the expanded grid)
 *   2. Playwright force-click — bypasses actionability, still produces
 *      a real isTrusted=true DOM event
 *   3. JS .click() in page.evaluate — synthetic event but works when
 *      something is genuinely overlapping
 */
async function clickActionButton(
  page: Page,
  _opts: OneglanceHyderabadSyncOptions,
  stepKey: string,
  buttonText: string,
): Promise<void> {
  const sel = `button:has-text("${buttonText}"), a:has-text("${buttonText}"), input[value="${buttonText}"]`;
  const loc = page.locator(sel).first();
  await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});

  try {
    await loc.click({ timeout: TIMEOUT, force: true, noWaitAfter: true });
    console.log(`[oneglance-hyderabad] Action button "${buttonText}" clicked via force`);
    return;
  } catch (e1: any) {
    console.log(`[oneglance-hyderabad] Force-click on "${buttonText}" failed: ${e1?.message}; falling back to JS click`);
  }

  const clicked = await page.evaluate((text: string) => {
    const wanted = text.trim().toUpperCase();
    const cands = document.querySelectorAll('button, a, input[type="button"], input[type="submit"]');
    for (const b of cands) {
      const v = ((b as HTMLInputElement).value || b.textContent || '').trim().toUpperCase();
      if (v === wanted) {
        try { (b as HTMLElement).click(); return true; } catch {}
      }
    }
    return false;
  }, buttonText);

  if (!clicked) {
    await debugScreenshot(page, `08b-FAILED-action-button-not-clickable-${stepKey}`);
    throw new Error(`Could not click "${buttonText}" — both Playwright force-click and JS .click() failed.`);
  }
  console.log(`[oneglance-hyderabad] Action button "${buttonText}" clicked via JS fallback`);
}

// ─────────────────────────────────────────────────────────────────────
// Per-report download flows. Each composes the helpers above with the
// page-specific bits (Type radio yes/no, action button label).
// ─────────────────────────────────────────────────────────────────────

/**
 * Purchase/Sales Report - Store flow. Used for:
 *   - Purchase at central Store    (type='Purchase', centerName=null)
 *   - Sales at satellite           (type='Sales',    centerName='MAGNACODE - …')
 *
 * Filter form has Period + Stockist + Invoice No + Batch No + Product
 * Name + Brand Name + Type radio (Purchase/Sales) + Center. The action
 * button is "Detailed".
 */
async function downloadStoreReport(
  page: Page,
  opts: OneglanceHyderabadSyncOptions,
  downloadDir: string,
  type: 'Purchase' | 'Sales',
  centerName: string | null,
): Promise<{ filePath: string; filename: string }> {
  const stepKey = type.toLowerCase();
  progress(opts, stepKey, `Setting ${type} Report filters...`, 35);

  await setDateRange(page, opts, stepKey);

  // Ensure Type radio is on the requested value. Click defensively in
  // case the previous session left it on the other option.
  const targetTypeLower = type.toLowerCase();
  const radioClicked = await page.evaluate((wanted: string) => {
    const radios = document.querySelectorAll('input[type="radio"]');
    for (const r of radios) {
      const value = (r as HTMLInputElement).value?.trim().toLowerCase() || '';
      const labelText = (r.parentElement?.textContent || r.nextSibling?.textContent || '').trim().toLowerCase();
      if (value === wanted || labelText.includes(wanted)) {
        (r as HTMLInputElement).click();
        return true;
      }
    }
    return false;
  }, targetTypeLower);
  if (!radioClicked) {
    await page.locator(`label:has-text("${type}")`).first().click({ timeout: 3000 }).catch(() => {});
  }
  await page.waitForTimeout(400);
  progress(opts, stepKey, `Type set to ${type}`, 44);

  if (centerName) {
    await setCenterField(page, opts, stepKey, centerName);
  }

  await debugScreenshot(page, `08-filters-set-${stepKey}`);

  // Click Detailed to render the report.
  progress(opts, stepKey, `Generating ${type.toLowerCase()} report...`, 48);
  await clickActionButton(page, opts, stepKey, 'Detailed');

  await waitForRenderedReport(page, opts, stepKey);
  return await captureCsvAndSave(page, opts, downloadDir, stepKey, type.toLowerCase());
}

/**
 * Stock Transfer Details flow at a satellite. Filter form is simpler:
 * Period + Center only. Three action buttons (Transfer Report / Return
 * Report / Invoice Wise) — we click "Transfer Report" to get the
 * incoming-transfers view.
 */
async function downloadTransferReport(
  page: Page,
  opts: OneglanceHyderabadSyncOptions,
  downloadDir: string,
  centerName: string,
): Promise<{ filePath: string; filename: string }> {
  const stepKey = 'transfer';
  progress(opts, stepKey, 'Setting Stock Transfer filters...', 35);

  await setDateRange(page, opts, stepKey);
  await setCenterField(page, opts, stepKey, centerName);
  await debugScreenshot(page, `08-filters-set-${stepKey}`);

  progress(opts, stepKey, 'Generating Transfer Report...', 48);
  // Action buttons on this page: Transfer Report / Return Report /
  // Invoice Wise. We want "Transfer Report" — the incoming-transfers
  // listing that the parser knows how to consume. The exact-match in
  // clickActionButton ensures we don't accidentally hit "Return Report"
  // or "Invoice Wise".
  await clickActionButton(page, opts, stepKey, 'Transfer Report');

  await waitForRenderedReport(page, opts, stepKey);
  return await captureCsvAndSave(page, opts, downloadDir, stepKey, 'transfer');
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
  // Video recording is opt-in: it requires Playwright's ffmpeg binary
  // (`npx playwright install ffmpeg`) which isn't part of the default
  // `--with-deps chromium` install. If the binary isn't there,
  // newPage() throws. Set ONEGLANCE_HYDERABAD_VIDEO=1 to enable
  // recording in environments where ffmpeg is available.
  const videoDir = path.join(DATA_DIR, 'uploads', 'debug-hyderabad', 'video');
  const wantVideo = process.env.ONEGLANCE_HYDERABAD_VIDEO === '1';
  if (wantVideo && !fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });

  // Tracing is opt-in too, but doesn't need ffmpeg — it's just
  // screenshots + DOM snapshots packaged as a zip. Set
  // ONEGLANCE_HYDERABAD_TRACE=1 to enable. The zip can be replayed
  // locally with `npx playwright show-trace <path-to-trace.zip>`,
  // which opens an interactive timeline + DOM snapshots + network +
  // console.
  const traceDir = path.join(DATA_DIR, 'uploads', 'debug-hyderabad', 'trace');
  const wantTrace = process.env.ONEGLANCE_HYDERABAD_TRACE === '1';
  if (wantTrace && !fs.existsSync(traceDir)) fs.mkdirSync(traceDir, { recursive: true });

  const context: BrowserContext = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
    geolocation: { latitude: 17.385, longitude: 78.4867 }, // Hyderabad
    permissions: ['geolocation'],
    ...(wantVideo
      ? { recordVideo: { dir: videoDir, size: { width: 1400, height: 900 } } }
      : {}),
  });
  const page = await context.newPage();

  // Start tracing immediately after newPage so the trace captures the
  // full run including login. tracing.stop is in the finally block.
  if (wantTrace) {
    try {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      console.log('[oneglance-hyderabad] Tracing started');
    } catch (e: any) {
      console.warn('[oneglance-hyderabad] tracing.start failed:', e?.message);
    }
  }

  // tsx/esbuild emits `__name(fn, "name")` decorations to preserve
  // function names in stack traces. Those references get serialized
  // into Playwright page.evaluate scripts as part of the captured
  // function source, but the browser context doesn't have __name —
  // result is `ReferenceError: __name is not defined`. Inject a
  // no-op into every page context so all evaluate calls just work.
  await page.addInitScript(() => {
    if (typeof (window as any).__name === 'undefined') {
      (window as any).__name = (target: any) => target;
    }
  });

  // Capture synthetic blob downloads. OneGlance generates the CSV
  // entirely client-side: it converts the in-memory report data to a
  // CSV string, wraps it in a Blob, calls URL.createObjectURL, builds
  // a synthetic <a download> element, and clicks it. Playwright's
  // headless mode doesn't always fire a `download` event for those
  // synthetic clicks. We monkey-patch URL.createObjectURL +
  // HTMLAnchorElement.prototype.click so we can later read the blob
  // contents directly and save them ourselves.
  await page.addInitScript(() => {
    const w = window as any;
    if (w.__mtCsvCapture) return; // idempotent — runs on every nav
    w.__mtCsvCapture = { blobs: [], anchors: [] };

    const origCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (obj: any) {
      const url = origCreateObjectURL(obj);
      try {
        if (obj instanceof Blob) {
          w.__mtCsvCapture.blobs.push({ url, blob: obj, type: obj.type, size: obj.size });
        }
      } catch { /* ignore */ }
      return url;
    };

    const origAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      try {
        const dl = this.getAttribute('download');
        if (dl !== null && this.href) {
          w.__mtCsvCapture.anchors.push({ href: this.href, download: dl, ts: Date.now() });
        }
      } catch { /* ignore */ }
      return origAnchorClick.apply(this, arguments as any);
    };
  });

  const result: OneglanceHyderabadSyncResult = {};

  try {
    // Clean old debug screenshots so each run starts fresh
    if (fs.existsSync(DEBUG_DIR)) {
      try { fs.readdirSync(DEBUG_DIR).forEach(f => {
        const p = path.join(DEBUG_DIR, f);
        // keep subdirs (video/, trace/) — only clear files at the top level
        if (fs.statSync(p).isFile()) fs.unlinkSync(p);
      }); } catch {}
    }

    await login(page, opts);

    if (opts.reports.includes('purchase')) {
      await navigateToStorePurchaseSalesReport(page, opts);
      result.purchaseFile = await downloadStoreReport(page, opts, downloadDir, 'Purchase', null);
    }

    if (opts.reports.includes('sales')) {
      if (!opts.oneglanceCenter) {
        throw new Error(
          'Sales sync requires the satellite\'s OneGlance Center Name. Set it on the satellite branch in Admin → Branches.',
        );
      }
      // Re-navigate to the report page so we land on a clean filter
      // form. After a Purchase download we'd be on the rendered report
      // table — clicking Filter would also work, but a fresh nav is
      // simpler and the perf cost is negligible (one page load).
      await navigateToStorePurchaseSalesReport(page, opts);
      result.salesFile = await downloadStoreReport(page, opts, downloadDir, 'Sales', opts.oneglanceCenter);
    }

    if (opts.reports.includes('transfer')) {
      if (!opts.oneglanceCenter) {
        throw new Error(
          'Stock Transfer sync requires the satellite\'s OneGlance Center Name. Set it on the satellite branch in Admin → Branches.',
        );
      }
      // Always fresh-navigate to "Transfered Stocks" so we don't
      // inherit state from a prior Purchase/Sales render.
      await navigateToTransferedStocks(page, opts);
      result.transferFile = await downloadTransferReport(page, opts, downloadDir, opts.oneglanceCenter);
    }

    return result;
  } finally {
    // Stop tracing FIRST — must happen before context.close, otherwise
    // the trace zip is incomplete or never written.
    if (wantTrace) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const tracePath = path.join(traceDir, `trace-${ts}.zip`);
      try {
        await context.tracing.stop({ path: tracePath });
        console.log(`[oneglance-hyderabad] Trace saved: ${tracePath}`);
        console.log(`[oneglance-hyderabad] To view: npx playwright show-trace ${tracePath}`);
      } catch (e: any) {
        console.warn('[oneglance-hyderabad] tracing.stop failed:', e?.message);
      }
    }

    // Video path is only meaningful when ONEGLANCE_HYDERABAD_VIDEO=1
    // enabled recording — page.video() returns undefined otherwise.
    let videoSrc: string | null = null;
    if (wantVideo) {
      try { videoSrc = await page.video()?.path() || null; } catch {}
    }
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    if (videoSrc && fs.existsSync(videoSrc)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const target = path.join(videoDir, `sync-${ts}.webm`);
      try { fs.renameSync(videoSrc, target); console.log(`[oneglance-hyderabad] Video saved: ${target}`); } catch {}
    }
  }
}
