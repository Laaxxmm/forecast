/**
 * Step 4 mechanical rewrite: add `vcfo_` prefix to every table name in SQL
 * contexts across the TallyVision backend.
 *
 * Runs once, in-place. Safe to re-run (already-prefixed tables won't
 * re-match since the regex is word-bounded and the prefixed names contain
 * the old names as suffixes but not at word boundaries... actually we guard
 * against double-prefix explicitly).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const FILES = [
    'Vcfo-app/TallyVision_2.0/src/backend/server.js',
    'Vcfo-app/TallyVision_2.0/src/backend/extractors/data-extractor.js',
].map(p => path.join(REPO_ROOT, p));

const TABLES = [
    // Platform (global) tables
    'app_settings',
    'license',
    'client_users',
    'client_company_access',
    'upload_categories',
    // Per-client tables
    'companies',
    'account_groups',
    'ledgers',
    'trial_balance',
    'profit_loss',
    'balance_sheet',
    'vouchers',
    'stock_summary',
    'stock_item_ledger',
    'bills_outstanding',
    'cost_centres',
    'cost_allocations',
    'gst_entries',
    'payroll_entries',
    'sync_log',
    'excel_uploads',
    'excel_data',
    'budgets',
    'allocation_rules',
    'writeoff_rules',
    'tracker_items',
    'tracker_status',
    'audit_milestones',
    'audit_milestone_status',
    'audit_observations',
];

// SQL keywords that are followed by a table name.
// Order matters: longer patterns first to avoid partial matches.
const KEYWORDS = [
    'DELETE\\s+FROM',
    'INSERT\\s+OR\\s+IGNORE\\s+INTO',
    'INSERT\\s+OR\\s+REPLACE\\s+INTO',
    'INSERT\\s+INTO',
    'REPLACE\\s+INTO',
    'UPDATE',
    'FROM',
    'JOIN',
    'INTO',
];

function rewrite(src) {
    let out = src;
    let totalEdits = 0;

    for (const table of TABLES) {
        // Guard: don't re-prefix an already-prefixed table name.
        // (?<!vcfo_) negative look-behind; ripgrep doesn't support it but
        // plain JS regex does.
        for (const kw of KEYWORDS) {
            const re = new RegExp(
                `\\b(${kw})(\\s+)(?<!vcfo_)(${table})\\b`,
                'gi',
            );
            let count = 0;
            out = out.replace(re, (m, k, ws, t) => {
                count++;
                return `${k}${ws}vcfo_${t}`;
            });
            if (count) totalEdits += count;
        }
    }

    return { out, totalEdits };
}

let grandTotal = 0;
for (const file of FILES) {
    const src = fs.readFileSync(file, 'utf8');
    const { out, totalEdits } = rewrite(src);
    if (totalEdits === 0) {
        console.log(`[skip]   ${path.relative(REPO_ROOT, file)}  (no edits)`);
        continue;
    }
    fs.writeFileSync(file, out, 'utf8');
    console.log(`[edit]   ${path.relative(REPO_ROOT, file)}  (${totalEdits} edits)`);
    grandTotal += totalEdits;
}
console.log(`\nTotal: ${grandTotal} edits across ${FILES.length} files.`);
