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
    // Turia uses MUI FilledInput with type="text" and placeholder="Mobile Number"
    const phoneInput = page.locator('input[placeholder*="Mobile" i], input[placeholder*="mobile" i], input[placeholder*="phone" i], input[placeholder*="number" i], input[type="tel"]').first();
    await phoneInput.waitFor({ timeout: 10000 });
    await phoneInput.click();
    await phoneInput.fill(opts.phoneNumber);
    await page.waitForTimeout(500);
    await screenshot('phone-entered');

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

    // Turia uses MUI OTP inputs — find all visible text/tel/number inputs in the OTP area
    // Try multiple selector strategies
    const otpSelectors = [
      'input[maxlength="1"]',                    // Standard OTP pattern
      'input[type="tel"][maxlength="1"]',         // Tel type with maxlength
      'input[type="number"][maxlength="1"]',      // Number type
      'input[inputmode="numeric"]',               // Numeric inputmode (MUI pattern)
    ];

    let otpFilled = false;
    for (const sel of otpSelectors) {
      const otpInputs = page.locator(sel);
      const count = await otpInputs.count();
      if (count >= 4) {
        console.log(`Turia: Found ${count} OTP inputs with selector: ${sel}`);
        for (let i = 0; i < otp.length && i < count; i++) {
          await otpInputs.nth(i).click();
          await page.waitForTimeout(100);
          await page.keyboard.press('Backspace');
          await page.keyboard.type(otp[i], { delay: 50 });
          await page.waitForTimeout(300);
        }
        otpFilled = true;
        break;
      }
    }

    if (!otpFilled) {
      // Fallback: look for ANY visible inputs that appeared after OTP was requested
      // (exclude the phone input which we already filled)
      console.log('Turia: No individual OTP inputs found, trying fallback strategies');
      const allInputs = page.locator('input:visible');
      const inputCount = await allInputs.count();
      console.log(`Turia: Found ${inputCount} visible inputs total`);

      // Log all input attributes for debugging
      for (let i = 0; i < inputCount; i++) {
        const attrs = await allInputs.nth(i).evaluate(el => {
          const inp = el as HTMLInputElement;
          return {
            type: inp.type, maxlength: inp.maxLength, placeholder: inp.placeholder,
            inputmode: inp.inputMode, className: inp.className.slice(0, 80),
            value: inp.value, id: inp.id
          };
        });
        console.log(`Turia: Input ${i}:`, JSON.stringify(attrs));
      }

      // Try to find inputs that look like OTP (small, empty, after the phone input)
      if (inputCount > 1) {
        // Skip the first input (phone), try remaining
        const otpArea = inputCount >= 5 ? inputCount - 4 : 1; // Last 4 inputs
        for (let i = otpArea; i < inputCount && (i - otpArea) < otp.length; i++) {
          await allInputs.nth(i).click();
          await page.waitForTimeout(100);
          await page.keyboard.type(otp[i - otpArea], { delay: 50 });
          await page.waitForTimeout(200);
        }
        otpFilled = true;
      }

      if (!otpFilled) {
        await screenshot('otp-inputs-not-found');
        throw new Error('Could not find OTP input fields on the page');
      }
    }

    await page.waitForTimeout(2000);
    await screenshot('otp-entered');

    // Turia auto-submits OTP via useEffect when all 4 digits are entered.
    // Wait for either: (a) navigation away from /login, or (b) Verify button to appear.
    progress(opts, 'login', 'Verifying OTP...', 35);

    // First, wait a moment for auto-submit to fire
    await page.waitForTimeout(3000);

    // Check if auto-submit already navigated away from login
    let loginComplete = !page.url().includes('/login');
    console.log(`Turia: After OTP entry, URL=${page.url()}, loginComplete=${loginComplete}`);

    if (!loginComplete) {
      // Auto-submit may not have worked — try clicking Verify OTP button manually
      console.log('Turia: Auto-submit did not navigate. Trying manual verify button click...');

      const verifySelectors = [
        'button:has-text("Verify OTP")',
        'button:has-text("Verify")',
        'button:has-text("Submit")',
        'button:has-text("Login")',
        '[role="button"]:has-text("Verify")',
        'a:has-text("Verify")',
      ];

      let verifyClicked = false;
      for (const sel of verifySelectors) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 2000 })) {
            const isDisabled = await btn.isDisabled();
            console.log(`Turia: Found verify button with "${sel}", disabled=${isDisabled}`);
            if (!isDisabled) {
              await btn.click({ timeout: 5000 });
              verifyClicked = true;
              break;
            } else {
              // Button disabled = auto-submit may be in progress, just wait
              console.log('Turia: Button is disabled (auto-submit in progress), waiting...');
              break;
            }
          }
        } catch { /* try next selector */ }
      }

      if (!verifyClicked) {
        // Last resort: click any visible button that isn't "Resend OTP" or "Get OTP"
        const allBtns = page.locator('button:visible');
        const btnCount = await allBtns.count();
        console.log(`Turia: No verify button found. ${btnCount} visible buttons:`);
        for (let i = 0; i < btnCount; i++) {
          const text = await allBtns.nth(i).textContent();
          console.log(`  Button ${i}: "${text}"`);
          if (text && /verify|submit|login|continue/i.test(text) && !/resend|get otp/i.test(text)) {
            await allBtns.nth(i).click({ force: true });
            verifyClicked = true;
            break;
          }
        }
      }

      // Even if no button was clicked, wait for possible auto-submit navigation
      // (the useEffect auto-submit may just need more time)
      if (!verifyClicked) {
        console.log('Turia: No verify button found. Waiting for auto-submit navigation...');
      }

      // Wait for navigation away from login page (auto-submit or button click)
      try {
        await page.waitForURL((url) => !url.toString().includes('/login'), { timeout: 15000 });
        loginComplete = true;
        console.log('Turia: Navigation detected, login successful');
      } catch {
        await screenshot('verify-timeout');
        loginComplete = !page.url().includes('/login');
      }
    }

    await screenshot('post-verify');

    if (!loginComplete) {
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

    // Look for the FY dropdown — Turia shows it as a MUI Select with "2026-2027" text
    // From screenshot: it's a dropdown with year range text and a chevron, near Search and + Add
    try {
      // Try multiple approaches to find the FY dropdown
      const fySelectors = [
        'select',                                    // Native select
        '[role="combobox"]',                          // MUI Select role
        `text="${opts.financialYear}"`,               // Direct text match
        'button:has-text("202")',                     // Button with year text
        'div:has-text("202") >> nth=-1',              // Div containing year text
      ];

      let fyFound = false;
      for (const sel of fySelectors) {
        try {
          const dropdown = page.locator(sel).first();
          if (await dropdown.isVisible({ timeout: 2000 })) {
            const tagName = await dropdown.evaluate(el => el.tagName.toLowerCase());
            if (tagName === 'select') {
              // Native select — try both label and value matching
              await dropdown.selectOption({ label: opts.financialYear }).catch(() =>
                dropdown.selectOption({ value: opts.financialYear })
              );
            } else {
              // MUI Select or custom dropdown — click to open, then select
              await dropdown.click();
              await page.waitForTimeout(1000);
              const option = page.locator(`[role="option"]:has-text("${opts.financialYear}"), li:has-text("${opts.financialYear}"), text="${opts.financialYear}"`).first();
              if (await option.isVisible({ timeout: 3000 })) {
                await option.click();
              } else {
                await page.keyboard.press('Escape');
              }
            }
            fyFound = true;
            await page.waitForTimeout(2000);
            break;
          }
        } catch { /* try next */ }
      }
      if (!fyFound) {
        progress(opts, 'navigate', 'Using default financial year', 58);
      }
    } catch {
      progress(opts, 'navigate', 'Using default financial year', 58);
    }
    await screenshot('fy-selected');

    // ── Step 7: Select all invoices and export ──
    progress(opts, 'download', 'Selecting all invoices...', 60);

    // First, select all invoices using the header checkbox
    try {
      const headerCheckbox = page.locator('thead input[type="checkbox"], th input[type="checkbox"], .MuiCheckbox-root').first();
      if (await headerCheckbox.isVisible({ timeout: 3000 })) {
        await headerCheckbox.click();
        await page.waitForTimeout(1000);
        console.log('Turia: Selected all invoices via header checkbox');
      }
    } catch {
      console.log('Turia: Could not find header checkbox, continuing without selection');
    }
    await screenshot('invoices-selected');

    // Now find and click the kebab menu (⋮) button
    // Turia uses MUI — the kebab is an IconButton with MoreVert SVG, right next to "+ Add" button
    progress(opts, 'download', 'Looking for export option...', 65);

    let exportClicked = false;

    // Strategy 1: Find the kebab button by locating it relative to the Add button
    // The ⋮ button is the icon-only button immediately after the "+ Add" button
    try {
      // Find all icon-only buttons (buttons that contain SVG but minimal/no text)
      const iconButtons = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        const results: { index: number; text: string; hasIcon: boolean; x: number; y: number; width: number }[] = [];
        buttons.forEach((btn, i) => {
          const rect = btn.getBoundingClientRect();
          const text = (btn.textContent || '').trim();
          const hasSvg = btn.querySelector('svg') !== null;
          if (rect.width > 0 && rect.height > 0) {
            results.push({ index: i, text: text.slice(0, 30), hasIcon: hasSvg, x: rect.x, y: rect.y, width: rect.width });
          }
        });
        return results;
      });

      console.log('Turia: Found buttons:', JSON.stringify(iconButtons.filter(b => b.x > 800).slice(-8)));

      // Find the ⋮ button: it's an icon-only button (has SVG, very short/no text)
      // positioned to the right of the Add button, near the top of the page
      const addBtnInfo = iconButtons.find(b => b.text.includes('Add'));
      const kebabCandidates = iconButtons.filter(b => {
        const isIconOnly = b.hasIcon && b.text.length <= 2; // Icon button with no/minimal text
        const isRightSide = b.x > 800; // Right side of page
        const isSmall = b.width < 60; // Kebab buttons are small
        const isNearTop = b.y < 500; // Near the top toolbar area
        // If we found the Add button, the kebab should be near it (within 100px)
        const isNearAdd = addBtnInfo ? Math.abs(b.x - addBtnInfo.x) < 150 && Math.abs(b.y - addBtnInfo.y) < 50 : true;
        return isIconOnly && isRightSide && isSmall && isNearTop && isNearAdd;
      });

      console.log(`Turia: Kebab candidates: ${kebabCandidates.length}`, JSON.stringify(kebabCandidates));

      // Try each candidate — click it and look for Export in the dropdown
      const allButtons = page.locator('button, [role="button"]');
      for (const candidate of kebabCandidates) {
        try {
          const btn = allButtons.nth(candidate.index);
          await btn.click();
          await page.waitForTimeout(1000);
          await screenshot('kebab-clicked');

          // Look for "Export" in any popover/menu/dropdown that appeared
          const exportOption = page.locator(
            '[role="menuitem"]:has-text("Export"), ' +
            '[role="menu"] >> text=Export, ' +
            '.MuiMenuItem-root:has-text("Export"), ' +
            '.MuiMenu-list >> text=Export, ' +
            'li:has-text("Export"), ' +
            'div[role="presentation"] >> text=Export, ' +
            'text=Export'
          ).first();

          if (await exportOption.isVisible({ timeout: 3000 })) {
            console.log('Turia: Found Export option!');
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
          // Close the menu and try next candidate
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);
        } catch {
          await page.keyboard.press('Escape').catch(() => {});
        }
      }
    } catch (err) {
      console.log('Turia: Strategy 1 (relative positioning) failed:', (err as Error).message);
    }

    // Strategy 2: Brute force — click every icon-only button on the right side
    if (!exportClicked) {
      console.log('Turia: Trying brute force button scan...');
      const allButtons = page.locator('button, [role="button"]');
      const count = await allButtons.count();

      for (let i = count - 1; i >= Math.max(0, count - 15); i--) {
        try {
          const btn = allButtons.nth(i);
          const box = await btn.boundingBox();
          if (!box || box.x < 800 || box.y > 500) continue; // Skip non-toolbar buttons

          const text = (await btn.textContent().catch(() => '')) || '';
          if (text.includes('Add') || text.includes('Search') || text.length > 15) continue;

          await btn.click();
          await page.waitForTimeout(1000);

          // Check if Export appeared
          const exportOpt = page.locator('text=Export').first();
          if (await exportOpt.isVisible({ timeout: 2000 })) {
            console.log(`Turia: Found Export via button ${i}`);
            progress(opts, 'download', 'Downloading invoice data...', 75);

            const [download] = await Promise.all([
              page.waitForEvent('download', { timeout: TIMEOUT }),
              exportOpt.click(),
            ]);

            const filename = `turia-invoices-${new Date().toISOString().slice(0, 10)}.xlsx`;
            const savePath = path.join(downloadDir, filename);
            await download.saveAs(savePath);
            exportClicked = true;

            progress(opts, 'download', 'Invoice data downloaded', 90);
            return { filePath: savePath, filename };
          }
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
        } catch {
          await page.keyboard.press('Escape').catch(() => {});
        }
      }
    }

    // Strategy 3: Try direct text click on "Export" if it's already visible
    if (!exportClicked) {
      try {
        const directExport = page.locator('text=Export').first();
        if (await directExport.isVisible({ timeout: 2000 })) {
          progress(opts, 'download', 'Downloading invoice data...', 75);
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: TIMEOUT }),
            directExport.click(),
          ]);
          const filename = `turia-invoices-${new Date().toISOString().slice(0, 10)}.xlsx`;
          const savePath = path.join(downloadDir, filename);
          await download.saveAs(savePath);
          return { filePath: savePath, filename };
        }
      } catch {}
    }

    await screenshot('export-not-found');
    throw new Error('Could not find the export option. Please try manual upload instead.');
  } catch (err: any) {
    await screenshot('error');
    throw err;
  } finally {
    await browser.close();
  }
}
