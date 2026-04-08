import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'path';
import fs from 'fs';

const TIMEOUT = 120_000; // 2 minutes

export interface TuriaSyncOptions {
  phoneNumber: string;
  financialYear: string; // e.g. "2025-26"
  onProgress?: (step: string, message: string, pct: number) => void;
  onOtpRequired?: () => void;
  getOtp?: () => Promise<string>;
}

export interface TuriaSyncResult {
  filePath: string;
  filename: string;
}

function progress(opts: TuriaSyncOptions, step: string, message: string, pct: number) {
  opts.onProgress?.(step, message, pct);
}

/**
 * Sync invoices from Turia Practice Management:
 * 1. Navigate to login page
 * 2. Enter phone number → Get OTP
 * 3. Wait for user to provide OTP
 * 4. Enter OTP → Verify
 * 5. Navigate to invoice list
 * 6. Select financial year
 * 7. Export invoice data
 */
export async function syncTuria(opts: TuriaSyncOptions): Promise<TuriaSyncResult> {
  const isProd = process.env.NODE_ENV === 'production';
  const dataDir = process.env.DATA_DIR || (isProd ? '/data' : '.');
  const downloadDir = path.join(dataDir, 'uploads');
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

  const debugDir = path.join(dataDir, 'uploads', 'debug');
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });

  const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (isProd ? '/usr/bin/chromium' : undefined);
  let browser;
  try {
    browser = await chromium.launch({
      ...(chromiumPath ? { executablePath: chromiumPath } : { channel: 'chrome' }),
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      ],
    });
  } catch (launchErr: any) {
    console.error('Turia: Browser launch failed:', launchErr.message);
    throw new Error(`Browser launch failed: ${launchErr.message}`);
  }

  const context: BrowserContext = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();

  async function screenshot(name: string) {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      await page.screenshot({ path: path.join(debugDir, `turia-${name}-${ts}.png`) });
    } catch {}
  }

  try {
    // ── Step 1: Navigate to login page ──
    progress(opts, 'login', 'Opening Turia login page...', 5);
    await page.goto('https://practice.turia.in/login', { waitUntil: 'networkidle', timeout: TIMEOUT });
    await page.waitForTimeout(2000);
    await screenshot('login-page');

    // ── Step 2: Enter phone number ──
    progress(opts, 'login', 'Entering phone number...', 10);
    const phoneInput = page.locator('input[type="tel"], input[placeholder*="mobile" i], input[placeholder*="number" i], input[placeholder*="phone" i]').first();
    await phoneInput.waitFor({ timeout: 10000 });
    await phoneInput.fill(opts.phoneNumber);
    await page.waitForTimeout(500);

    // Click "Get OTP" button
    progress(opts, 'login', 'Requesting OTP...', 15);
    const getOtpBtn = page.locator('button:has-text("Get OTP"), button:has-text("get otp"), button:has-text("Send OTP"), button:has-text("send otp")').first();
    await getOtpBtn.click();
    await page.waitForTimeout(3000);
    await screenshot('otp-requested');

    // ── Step 3: Wait for OTP from user ──
    progress(opts, 'waiting_otp', 'Waiting for OTP... Please enter the code sent to your phone.', 20);
    opts.onOtpRequired?.();

    if (!opts.getOtp) {
      throw new Error('OTP handler not provided');
    }
    const otp = await opts.getOtp();
    if (!otp || otp.length < 4) {
      throw new Error('Invalid OTP provided');
    }

    // ── Step 4: Enter OTP ──
    progress(opts, 'login', 'Entering OTP...', 30);

    // Try individual OTP input boxes first (common pattern: 4 separate inputs)
    const otpInputs = page.locator('input[maxlength="1"], input[type="tel"][maxlength="1"]');
    const otpInputCount = await otpInputs.count();

    if (otpInputCount >= 4) {
      // Fill individual digit inputs — use keyboard type to trigger React state updates
      for (let i = 0; i < otp.length && i < otpInputCount; i++) {
        await otpInputs.nth(i).click();
        await otpInputs.nth(i).fill('');
        await otpInputs.nth(i).pressSequentially(otp[i], { delay: 50 });
        await page.waitForTimeout(200);
      }
    } else {
      // Try a single OTP input field
      const singleOtpInput = page.locator('input[type="tel"], input[placeholder*="otp" i], input[placeholder*="code" i], input[placeholder*="verification" i]').first();
      await singleOtpInput.fill(otp);
    }

    await page.waitForTimeout(1500);
    await screenshot('otp-entered');

    // Click Verify OTP button
    progress(opts, 'login', 'Verifying OTP...', 35);
    const verifyBtn = page.locator('button:has-text("Verify OTP"), button:has-text("Verify"), button:has-text("verify"), button:has-text("Submit"), button:has-text("submit"), button:has-text("Login"), button:has-text("login")').first();
    // Wait for button to be enabled (it enables after OTP is fully entered)
    await verifyBtn.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(500);
    await verifyBtn.click({ force: true });
    await page.waitForTimeout(5000);
    await screenshot('post-verify');

    // Check if login was successful
    const postLoginUrl = page.url();
    if (postLoginUrl.includes('/login')) {
      await screenshot('login-failed');
      throw new Error('OTP verification failed. Please check the code and try again.');
    }

    progress(opts, 'login', 'Logged in successfully', 40);

    // ── Step 5: Navigate to invoice list ──
    progress(opts, 'navigate', 'Navigating to invoice list...', 45);
    await page.goto('https://practice.turia.in/sales/invoice/list', { waitUntil: 'networkidle', timeout: TIMEOUT });
    await page.waitForTimeout(3000);
    await screenshot('invoice-list');

    // ── Step 6: Select financial year ──
    progress(opts, 'navigate', `Selecting financial year ${opts.financialYear}...`, 55);

    // Look for the FY dropdown/select
    const fyDropdown = page.locator('select, button:has-text("Financial Year"), button:has-text("All Financial Year"), [class*="select"], [role="combobox"]').first();
    try {
      await fyDropdown.waitFor({ timeout: 5000 });
      // Try select element first
      const tagName = await fyDropdown.evaluate(el => el.tagName.toLowerCase());
      if (tagName === 'select') {
        await fyDropdown.selectOption({ label: opts.financialYear });
      } else {
        // Click dropdown then select option
        await fyDropdown.click();
        await page.waitForTimeout(1000);
        const option = page.locator(`text="${opts.financialYear}"`).first();
        await option.click();
      }
      await page.waitForTimeout(2000);
    } catch {
      // If no FY selector found, continue with default
      progress(opts, 'navigate', 'Using default financial year', 58);
    }
    await screenshot('fy-selected');

    // ── Step 7: Export data ──
    progress(opts, 'download', 'Looking for export option...', 65);

    // Click the 3-dots menu button (next to Add button)
    const menuBtn = page.locator('button:has(svg), [class*="dots"], [class*="menu"], [class*="more"]').filter({ hasText: /^$/ });
    // Try various selectors for the 3-dot/kebab menu
    let exportClicked = false;

    // Strategy 1: Look for a kebab/more menu near the Add button
    const kebabSelectors = [
      'button[aria-label*="more" i]',
      'button[aria-label*="menu" i]',
      'button[title*="more" i]',
      '[class*="kebab"]',
      '[class*="dots"]',
      '[class*="more-vert"]',
    ];

    for (const sel of kebabSelectors) {
      try {
        const btn = page.locator(sel).last();
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click();
          await page.waitForTimeout(1000);
          await screenshot('menu-opened');

          // Look for export option in the dropdown
          const exportOption = page.locator('text=/export/i, a:has-text("Export"), button:has-text("Export"), [role="menuitem"]:has-text("Export")').first();
          if (await exportOption.isVisible({ timeout: 2000 })) {
            // Wait for download
            progress(opts, 'download', 'Downloading invoice data...', 75);
            const [download] = await Promise.all([
              page.waitForEvent('download', { timeout: TIMEOUT }),
              exportOption.click(),
            ]);

            const filename = `turia-invoices-${new Date().toISOString().slice(0, 10)}.xlsx`;
            const savePath = path.join(downloadDir, filename);
            await download.saveAs(savePath);
            exportClicked = true;

            progress(opts, 'download', 'Invoice data downloaded', 90);
            return { filePath: savePath, filename };
          }
          // Close menu if export not found
          await page.keyboard.press('Escape');
        }
      } catch { /* try next selector */ }
    }

    // Strategy 2: Try clicking any element with 3 vertical dots icon (⋮)
    if (!exportClicked) {
      try {
        // Look for SVG icons that might be the 3-dot menu
        const allButtons = page.locator('button, [role="button"]');
        const buttonCount = await allButtons.count();

        for (let i = buttonCount - 1; i >= Math.max(0, buttonCount - 10); i--) {
          const btn = allButtons.nth(i);
          const text = await btn.textContent().catch(() => '');
          const ariaLabel = await btn.getAttribute('aria-label').catch(() => '');

          // Skip if it's the Add button
          if (text?.includes('Add')) continue;

          // Try buttons near the top-right area (likely menu buttons)
          const box = await btn.boundingBox().catch(() => null);
          if (box && box.x > 800) { // Right side of page
            await btn.click();
            await page.waitForTimeout(1000);
            await screenshot(`button-${i}-clicked`);

            const exportLink = page.locator('text=/export/i').first();
            if (await exportLink.isVisible({ timeout: 2000 })) {
              progress(opts, 'download', 'Downloading invoice data...', 75);
              const [download] = await Promise.all([
                page.waitForEvent('download', { timeout: TIMEOUT }),
                exportLink.click(),
              ]);

              const filename = `turia-invoices-${new Date().toISOString().slice(0, 10)}.xlsx`;
              const savePath = path.join(downloadDir, filename);
              await download.saveAs(savePath);
              exportClicked = true;

              progress(opts, 'download', 'Invoice data downloaded', 90);
              return { filePath: savePath, filename };
            }
            await page.keyboard.press('Escape');
          }
        }
      } catch {}
    }

    if (!exportClicked) {
      await screenshot('export-not-found');
      throw new Error('Could not find the export option. Please try manual upload instead.');
    }

    throw new Error('Export failed unexpectedly');
  } catch (err: any) {
    await screenshot('error');
    throw err;
  } finally {
    await browser.close();
  }
}
