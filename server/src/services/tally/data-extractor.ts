/**
 * Tally Data Extractor — Chunked monthly extraction from Tally into SQLite
 * Ported from TallyVision's data-extractor.js, adapted for Vision's DbHelper (sql.js).
 */

import { TallyConnector } from './tally-connector.js';
import { TEMPLATES } from './xml-templates.js';
import { XMLParser } from 'fast-xml-parser';
import type { DbHelper } from '../../db/connection.js';

export interface ExtractorConfig {
  host?: string;
  port?: number;
  timeout?: number;
  onProgress?: (info: ProgressInfo) => void;
}

export interface ProgressInfo {
  step: string;
  status: string;
  message: string;
  progress?: number;
  results?: any;
}

export interface SyncResults {
  success: boolean;
  errors: string[];
  counts: Record<string, number>;
  forceResync: boolean;
  durationMs?: number;
}

interface MonthChunk {
  from: string;
  to: string;
  label: string;
}

export class DataExtractor {
  private db: DbHelper;
  tally: TallyConnector;
  private xmlParser: XMLParser;
  private onProgress: (info: ProgressInfo) => void;
  private maxRetries = 3;
  private branchId: number | null;

  constructor(db: DbHelper, config: ExtractorConfig = {}, branchId: number | null = null) {
    this.db = db;
    this.branchId = branchId;
    this.tally = new TallyConnector({
      host: config.host || 'localhost',
      port: config.port || 9000,
      timeout: config.timeout || 300000,
    });
    this.xmlParser = new XMLParser({
      parseTagValue: false,
      isArray: (tagName: string) => tagName === 'ROW' || tagName.endsWith('.LIST'),
    });
    this.onProgress = config.onProgress || (() => {});
  }

  // ── Date helpers ────────────────────────────────────────────────────────────

  generateMonthChunks(fromDate: string, toDate: string): MonthChunk[] {
    const chunks: MonthChunk[] = [];
    let current = new Date(fromDate + 'T00:00:00');
    const end = new Date(toDate + 'T00:00:00');
    while (current <= end) {
      const monthStart = new Date(current.getFullYear(), current.getMonth(), 1);
      const monthEnd = new Date(current.getFullYear(), current.getMonth() + 1, 0);
      const from = this.formatDate(monthStart < new Date(fromDate) ? new Date(fromDate) : monthStart);
      const to = this.formatDate(monthEnd > end ? end : monthEnd);
      chunks.push({
        from, to,
        label: `${monthStart.toLocaleString('en', { month: 'short' })} ${monthStart.getFullYear()}`,
      });
      current = new Date(current.getFullYear(), current.getMonth() + 1, 1);
    }
    return chunks;
  }

  generateQuarterChunks(fromDate: string, toDate: string): MonthChunk[] {
    const chunks: MonthChunk[] = [];
    let current = new Date(fromDate + 'T00:00:00');
    const end = new Date(toDate + 'T00:00:00');
    const qEnd = [2, 5, 8, 11];
    while (current <= end) {
      const m = current.getMonth();
      const qEndMonth = qEnd.find(e => e >= m) ?? 2;
      const qEndYear = qEndMonth === 2 && m > 2 ? current.getFullYear() + 1 : current.getFullYear();
      const quarterEnd = new Date(qEndYear, qEndMonth + 1, 0);
      const from = this.formatDate(current);
      const to = this.formatDate(quarterEnd > end ? end : quarterEnd);
      chunks.push({
        from, to,
        label: `${current.toLocaleString('en', { month: 'short' })}-${quarterEnd.toLocaleString('en', { month: 'short' })} ${qEndYear}`,
      });
      current = new Date(qEndYear, qEndMonth + 1, 1);
    }
    return chunks;
  }

  private isHistoricalMonth(yearMonth: string): boolean {
    return yearMonth < new Date().toISOString().substring(0, 7);
  }

  private isHistoricalPeriod(toDate: string): boolean {
    return toDate < new Date().toISOString().substring(0, 8) + '01';
  }

  private formatDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private formatTallyDate(d: string): string {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const date = new Date(d + 'T00:00:00');
    return `${date.getDate()}-${months[date.getMonth()]}-${date.getFullYear()}`;
  }

  private parseNumber(val: any): number {
    if (!val) return 0;
    const s = String(val).trim();
    const isNegative = /^\(.*\)$/.test(s);
    const clean = parseFloat(s.replace(/[\(\),\s]+/g, '')) || 0;
    return isNegative ? -Math.abs(clean) : clean;
  }

  private parseDate(val: any): string | null {
    if (!val) return null;
    const s = String(val);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const months: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const m = s.match(/^(\d{1,2})-(\w{3})-(\d{2,4})$/i);
    if (m) {
      const day = m[1].padStart(2, '0');
      const mon = String(months[m[2].toLowerCase()] || 1).padStart(2, '0');
      const year = m[3].length === 2 ? '20' + m[3] : m[3];
      return `${year}-${mon}-${day}`;
    }
    return null;
  }

  private cleanString(val: any): string {
    if (!val) return '';
    return String(val).replace(/&#\d+;/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  }

  // ── Fetch helpers ───────────────────────────────────────────────────────────

  private async fetchReport(xmlContent: string): Promise<any[]> {
    const response = await this.tally.sendXML(xmlContent);
    if (!response) throw new Error('Empty response from Tally');
    if (response.includes('<EXCEPTION>')) {
      const m = response.match(/<EXCEPTION>(.*?)<\/EXCEPTION>/);
      throw new Error(m ? m[1] : 'Tally exception');
    }
    const parsed = this.xmlParser.parse(response);
    const rows = parsed?.DATA?.ROW;
    if (!rows) return [];
    return Array.isArray(rows) ? rows : [rows];
  }

  private async fetchVoucherCollection(xmlContent: string): Promise<any[]> {
    const response = await this.tally.sendXML(xmlContent);
    if (!response) throw new Error('Empty response from Tally');
    if (response.includes('Unknown Request')) throw new Error('Tally rejected the request');

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseTagValue: false,
      isArray: (tagName: string) => ['VOUCHER', 'ALLLEDGERENTRIES.LIST'].includes(tagName),
    });
    const parsed = parser.parse(response);

    const txt = (v: any) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') return String(v['#text'] || '');
      return String(v);
    };
    const num = (v: any) => {
      const s = txt(v).trim();
      const isNegative = /^\(.*\)$/.test(s);
      const clean = parseFloat(s.replace(/[^\d.\-]/g, '')) || 0;
      return isNegative ? -Math.abs(clean) : clean;
    };

    const collection = parsed?.ENVELOPE?.BODY?.DATA?.COLLECTION;
    if (!collection) return [];

    const vouchers = collection['VOUCHER'] || [];
    const rows: any[] = [];

    for (const v of vouchers) {
      const date = txt(v.DATE);
      const voucherType = txt(v.VOUCHERTYPENAME);
      const voucherNumber = txt(v.VOUCHERNUMBER);
      const partyName = txt(v.PARTYLEDGERNAME);
      const narration = txt(v.NARRATION);
      const voucherAmount = num(v.AMOUNT);

      const entries = v['ALLLEDGERENTRIES.LIST'] || [];
      if (entries.length > 0) {
        for (const entry of entries) {
          rows.push({
            date, voucherType, voucherNumber,
            ledgerName: txt(entry.LEDGERNAME),
            amount: num(entry.AMOUNT),
            partyName, narration,
          });
        }
      } else {
        rows.push({
          date, voucherType, voucherNumber,
          ledgerName: partyName,
          amount: voucherAmount,
          partyName, narration,
        });
      }
    }
    return rows;
  }

  private async withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try { return await fn(); }
      catch (err: any) {
        if (err.message === 'TALLY_NOT_RUNNING' || err.message === 'TALLY_TIMEOUT') throw err;
        if (attempt === this.maxRetries) throw err;
        console.warn(`[RETRY ${attempt}] ${label}: ${err.message}`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
    throw new Error('Unreachable');
  }

  private logSync(companyId: number, reportType: string, from: string | null, to: string | null, status: string, rowCount = 0, error: string | null = null) {
    this.db.run(
      'INSERT INTO vcfo_sync_log (company_id, report_type, period_from, period_to, status, row_count, error_message, completed_at, branch_id) VALUES (?,?,?,?,?,?,?,?,?)',
      companyId, reportType, from, to, status, rowCount, error, new Date().toISOString(), this.branchId
    );
  }

  // ── Extraction methods ──────────────────────────────────────────────────────

  async extractChartOfAccounts(companyId: number, companyName: string): Promise<number> {
    this.onProgress({ step: 'chart-of-accounts', status: 'running', message: 'Chart of Accounts...' });
    const xml = TEMPLATES['chart-of-accounts'](companyName);
    const rows = await this.withRetry(() => this.fetchReport(xml), 'CoA');

    this.db.run('DELETE FROM vcfo_account_groups WHERE company_id = ?', companyId);
    for (const r of rows) {
      this.db.run(
        'INSERT OR REPLACE INTO vcfo_account_groups (company_id, group_name, parent_group, bs_pl, dr_cr, affects_gross_profit, branch_id) VALUES (?,?,?,?,?,?,?)',
        companyId, this.cleanString(r.F01), this.cleanString(r.F02), this.cleanString(r.F03), this.cleanString(r.F04), this.cleanString(r.F05), this.branchId
      );
    }
    this.logSync(companyId, 'chart-of-accounts', null, null, 'success', rows.length);
    return rows.length;
  }

  async extractLedgers(companyId: number, companyName: string): Promise<number> {
    this.onProgress({ step: 'ledgers', status: 'running', message: 'Ledger List...' });
    const xml = TEMPLATES['list-masters']('Ledger', companyName);
    const rows = await this.withRetry(() => this.fetchReport(xml), 'Ledgers');

    this.db.run('DELETE FROM vcfo_ledgers WHERE company_id = ?', companyId);
    for (const r of rows) {
      this.db.run(
        'INSERT OR REPLACE INTO vcfo_ledgers (company_id, name, group_name, branch_id) VALUES (?,?,?,?)',
        companyId, this.cleanString(r.F01), this.cleanString(r.F02), this.branchId
      );
    }
    this.logSync(companyId, 'ledgers', null, null, 'success', rows.length);
    return rows.length;
  }

  async extractTrialBalance(companyId: number, companyName: string, fromDate: string, toDate: string, forceResync = false): Promise<number> {
    const chunks = this.generateMonthChunks(fromDate, toDate);
    let total = 0;

    if (forceResync) {
      this.db.run('DELETE FROM vcfo_trial_balance WHERE company_id = ? AND period_from >= ? AND period_to <= ?', companyId, fromDate, toDate);
    }

    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (!forceResync && this.isHistoricalPeriod(c.to)) {
        const exists = this.db.get('SELECT 1 FROM vcfo_trial_balance WHERE company_id=? AND period_from=? LIMIT 1', companyId, c.from);
        if (exists) {
          this.onProgress({ step: 'trial-balance', status: 'running', message: `Trial Balance: ${c.label} (cached)`, progress: Math.round(((i + 1) / chunks.length) * 100) });
          continue;
        }
      }
      this.onProgress({ step: 'trial-balance', status: 'running', message: `Trial Balance: ${c.label}`, progress: Math.round(((i + 1) / chunks.length) * 100) });
      try {
        const xml = TEMPLATES['trial-balance'](this.formatTallyDate(c.from), this.formatTallyDate(c.to), companyName);
        const rows = await this.withRetry(() => this.fetchReport(xml), `TB ${c.label}`);
        this.db.run('DELETE FROM vcfo_trial_balance WHERE company_id=? AND period_from=? AND period_to=?', companyId, c.from, c.to);
        for (const r of rows) {
          this.db.run(
            'INSERT OR IGNORE INTO vcfo_trial_balance (company_id, period_from, period_to, ledger_name, group_name, opening_balance, net_debit, net_credit, closing_balance, branch_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
            companyId, c.from, c.to, this.cleanString(r.F01), this.cleanString(r.F02), this.parseNumber(r.F03), this.parseNumber(r.F04), this.parseNumber(r.F05), this.parseNumber(r.F06), this.branchId
          );
        }
        total += rows.length;
        this.logSync(companyId, 'trial-balance', c.from, c.to, 'success', rows.length);
      } catch (e: any) {
        this.logSync(companyId, 'trial-balance', c.from, c.to, 'error', 0, e.message);
      }
    }
    return total;
  }

  async extractProfitLoss(companyId: number, companyName: string, fromDate: string, toDate: string, forceResync = false): Promise<number> {
    const chunks = this.generateMonthChunks(fromDate, toDate);
    let total = 0;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (!forceResync && this.isHistoricalMonth(c.from.substring(0, 7))) {
        const exists = this.db.get('SELECT 1 FROM vcfo_profit_loss WHERE company_id=? AND period_from=? LIMIT 1', companyId, c.from);
        if (exists) {
          this.onProgress({ step: 'profit-loss', status: 'running', message: `P&L: ${c.label} (cached)`, progress: Math.round(((i + 1) / chunks.length) * 100) });
          continue;
        }
      }
      this.onProgress({ step: 'profit-loss', status: 'running', message: `P&L: ${c.label}`, progress: Math.round(((i + 1) / chunks.length) * 100) });
      try {
        const xml = TEMPLATES['profit-loss'](this.formatTallyDate(c.from), this.formatTallyDate(c.to), companyName);
        const rows = await this.withRetry(() => this.fetchReport(xml), `PL ${c.label}`);
        this.db.run('DELETE FROM vcfo_profit_loss WHERE company_id=? AND period_from=? AND period_to=?', companyId, c.from, c.to);
        for (const r of rows) {
          this.db.run(
            'INSERT OR IGNORE INTO vcfo_profit_loss (company_id, period_from, period_to, ledger_name, group_name, amount, branch_id) VALUES (?,?,?,?,?,?,?)',
            companyId, c.from, c.to, this.cleanString(r.F01), this.cleanString(r.F02), this.parseNumber(r.F03), this.branchId
          );
        }
        total += rows.length;
        this.logSync(companyId, 'profit-loss', c.from, c.to, 'success', rows.length);
      } catch (e: any) {
        this.logSync(companyId, 'profit-loss', c.from, c.to, 'error', 0, e.message);
      }
    }
    return total;
  }

  async extractBalanceSheet(companyId: number, companyName: string, fromDate: string, toDate: string, forceResync = false): Promise<number> {
    const chunks = this.generateMonthChunks(fromDate, toDate);
    let total = 0;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (!forceResync && this.isHistoricalMonth(c.from.substring(0, 7))) {
        const exists = this.db.get('SELECT 1 FROM vcfo_balance_sheet WHERE company_id=? AND as_on_date=? LIMIT 1', companyId, c.to);
        if (exists) {
          this.onProgress({ step: 'balance-sheet', status: 'running', message: `Balance Sheet: ${c.label} (cached)`, progress: Math.round(((i + 1) / chunks.length) * 100) });
          continue;
        }
      }
      this.onProgress({ step: 'balance-sheet', status: 'running', message: `Balance Sheet: ${c.label}`, progress: Math.round(((i + 1) / chunks.length) * 100) });
      try {
        const xml = TEMPLATES['balance-sheet'](this.formatTallyDate(fromDate), this.formatTallyDate(c.to), companyName);
        const rows = await this.withRetry(() => this.fetchReport(xml), `BS ${c.label}`);
        this.db.run('DELETE FROM vcfo_balance_sheet WHERE company_id=? AND as_on_date=?', companyId, c.to);
        for (const r of rows) {
          this.db.run(
            'INSERT OR IGNORE INTO vcfo_balance_sheet (company_id, as_on_date, ledger_name, group_name, closing_balance, branch_id) VALUES (?,?,?,?,?,?)',
            companyId, c.to, this.cleanString(r.F01), this.cleanString(r.F02), this.parseNumber(r.F03), this.branchId
          );
        }
        total += rows.length;
        this.logSync(companyId, 'balance-sheet', null, c.to, 'success', rows.length);
      } catch (e: any) {
        this.logSync(companyId, 'balance-sheet', null, c.to, 'error', 0, e.message);
      }
    }
    return total;
  }

  async extractVouchers(companyId: number, companyName: string, fromDate: string, toDate: string, forceResync = false): Promise<number> {
    const chunks = this.generateMonthChunks(fromDate, toDate);
    let total = 0;

    const parseTallyDate = (dateStr: string, fallback: string): string => {
      if (!dateStr) return fallback;
      const s = String(dateStr).trim();
      if (/^\d{8}$/.test(s)) return s.substring(0, 4) + '-' + s.substring(4, 6) + '-' + s.substring(6, 8);
      return this.parseDate(s) || fallback;
    };

    // Determine which months need re-fetch
    const activeChunks: (MonthChunk & { syncMonth: string })[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const syncMonth = c.from.substring(0, 7);
      if (!forceResync && this.isHistoricalMonth(syncMonth)) {
        const exists = this.db.get('SELECT 1 FROM vcfo_vouchers WHERE company_id=? AND date >= ? AND date <= ? LIMIT 1', companyId, c.from, c.to);
        if (exists) {
          this.onProgress({ step: 'vouchers', status: 'running', message: `Vouchers: ${c.label} (cached)`, progress: Math.round(((i + 1) / chunks.length) * 100) });
          continue;
        }
      }
      activeChunks.push({ ...c, syncMonth });
    }

    if (activeChunks.length === 0) {
      this.logSync(companyId, 'vouchers', fromDate, toDate, 'success', 0);
      return 0;
    }

    for (let i = 0; i < activeChunks.length; i++) {
      const c = activeChunks[i];
      this.onProgress({ step: 'vouchers', status: 'running', message: `Vouchers: ${c.label} (${i + 1}/${activeChunks.length})`, progress: Math.round(((i + 1) / activeChunks.length) * 100) });

      let rows: any[] = [];
      try {
        const xml = TEMPLATES['daybook'](this.formatTallyDate(c.from), this.formatTallyDate(c.to), companyName);
        rows = await this.withRetry(() => this.fetchVoucherCollection(xml), `V ${c.label}`);
      } catch (e: any) {
        this.logSync(companyId, 'vouchers', c.from, c.to, 'error', 0, e.message);
        continue;
      }

      if (!rows.length) continue;

      const validRows = rows.filter(r => {
        const d = parseTallyDate(r.date, c.from);
        return d >= c.from && d <= c.to;
      });
      if (!validRows.length) continue;

      // DELETE + INSERT
      this.db.run('DELETE FROM vcfo_vouchers WHERE company_id=? AND date >= ? AND date <= ?', companyId, c.from, c.to);
      for (const r of validRows) {
        this.db.run(
          'INSERT OR IGNORE INTO vcfo_vouchers (company_id, date, voucher_type, voucher_number, ledger_name, amount, party_name, narration, sync_month, branch_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
          companyId, parseTallyDate(r.date, c.from), r.voucherType || '', r.voucherNumber || '',
          r.ledgerName || '', r.amount, r.partyName || '', r.narration || '', c.syncMonth, this.branchId
        );
      }
      total += validRows.length;
    }

    this.logSync(companyId, 'vouchers', fromDate, toDate, 'success', total);
    return total;
  }

  async extractStockSummary(companyId: number, companyName: string, fromDate: string, toDate: string, forceResync = false): Promise<number> {
    const chunks = this.generateQuarterChunks(fromDate, toDate);
    let total = 0;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      if (!forceResync && this.isHistoricalPeriod(c.to)) {
        const exists = this.db.get('SELECT 1 FROM vcfo_stock_summary WHERE company_id=? AND period_from=? LIMIT 1', companyId, c.from);
        if (exists) {
          this.onProgress({ step: 'stock-summary', status: 'running', message: `Stock: ${c.label} (cached)`, progress: Math.round(((i + 1) / chunks.length) * 100) });
          continue;
        }
      }
      this.onProgress({ step: 'stock-summary', status: 'running', message: `Stock: ${c.label}`, progress: Math.round(((i + 1) / chunks.length) * 100) });
      try {
        const xml = TEMPLATES['stock-summary'](this.formatTallyDate(c.from), this.formatTallyDate(c.to), companyName);
        const rows = await this.withRetry(() => this.fetchReport(xml), `Stock ${c.label}`);
        this.db.run('DELETE FROM vcfo_stock_summary WHERE company_id=? AND period_from=? AND period_to=?', companyId, c.from, c.to);
        for (const r of rows) {
          this.db.run(
            'INSERT OR IGNORE INTO vcfo_stock_summary (company_id, period_from, period_to, item_name, stock_group, opening_qty, opening_value, inward_qty, inward_value, outward_qty, outward_value, closing_qty, closing_value, branch_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            companyId, c.from, c.to, this.cleanString(r.F01), this.cleanString(r.F02),
            this.parseNumber(r.F03), this.parseNumber(r.F04), this.parseNumber(r.F05), this.parseNumber(r.F06),
            this.parseNumber(r.F07), this.parseNumber(r.F08), this.parseNumber(r.F09), this.parseNumber(r.F10),
            this.branchId
          );
        }
        total += rows.length;
        this.logSync(companyId, 'stock-summary', c.from, c.to, 'success', rows.length);
      } catch (e: any) {
        this.logSync(companyId, 'stock-summary', c.from, c.to, 'error', 0, e.message);
      }
    }
    return total;
  }

  async extractBillsOutstanding(companyId: number, companyName: string, toDate: string): Promise<void> {
    for (const nature of ['receivable', 'payable'] as const) {
      this.onProgress({ step: 'bills', status: 'running', message: `Bills: ${nature}` });
      try {
        const xml = TEMPLATES['bills-outstanding'](this.formatTallyDate(toDate), nature, companyName);
        const rows = await this.withRetry(() => this.fetchReport(xml), `Bills ${nature}`);
        this.db.run('DELETE FROM vcfo_bills_outstanding WHERE company_id=? AND as_on_date=? AND nature=?', companyId, toDate, nature);
        for (const r of rows) {
          this.db.run(
            'INSERT OR IGNORE INTO vcfo_bills_outstanding (company_id, as_on_date, nature, bill_date, reference_number, outstanding_amount, party_name, overdue_days, branch_id) VALUES (?,?,?,?,?,?,?,?,?)',
            companyId, toDate, nature, this.parseDate(r.F01), this.cleanString(r.F02), this.parseNumber(r.F03), this.cleanString(r.F04), this.parseNumber(r.F05), this.branchId
          );
        }
        this.logSync(companyId, `bills-${nature}`, null, toDate, 'success', rows.length);
      } catch (e: any) {
        this.logSync(companyId, `bills-${nature}`, null, toDate, 'error', 0, e.message);
      }
    }
  }

  // ── Full sync orchestrator ──────────────────────────────────────────────────

  async runFullSync(companyId: number, companyName: string, fromDate: string, toDate: string, options: { forceResync?: boolean; syncModules?: Record<string, boolean> } = {}): Promise<SyncResults> {
    const forceResync = options.forceResync || false;
    const start = Date.now();
    const results: SyncResults = { success: true, errors: [], counts: {}, forceResync };

    this.onProgress({ step: 'init', status: 'running', message: `Syncing ${companyName}: ${fromDate} to ${toDate}${forceResync ? ' (force)' : ' (incremental)'}` });

    const steps: [string, () => Promise<any>][] = [
      ['groups', () => this.extractChartOfAccounts(companyId, companyName)],
      ['ledgers', () => this.extractLedgers(companyId, companyName)],
      ['trialBalance', () => this.extractTrialBalance(companyId, companyName, fromDate, toDate, forceResync)],
      ['profitLoss', () => this.extractProfitLoss(companyId, companyName, fromDate, toDate)],
      ['balanceSheet', () => this.extractBalanceSheet(companyId, companyName, fromDate, toDate)],
      ['stockSummary', () => this.extractStockSummary(companyId, companyName, fromDate, toDate, forceResync)],
      ['vouchers', () => this.extractVouchers(companyId, companyName, fromDate, toDate, forceResync)],
      ['bills', () => this.extractBillsOutstanding(companyId, companyName, toDate)],
    ];

    for (const [name, fn] of steps) {
      try { results.counts[name] = await fn(); }
      catch (e: any) { results.errors.push(`${name}: ${e.message}`); }
    }

    results.durationMs = Date.now() - start;
    results.success = results.errors.length === 0;

    this.onProgress({ step: 'complete', status: results.success ? 'done' : 'partial', message: `Done in ${Math.round(results.durationMs / 1000)}s`, results });
    return results;
  }
}
