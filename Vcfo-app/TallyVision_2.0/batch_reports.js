const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3456';
const OUTPUT_DIR = path.join(__dirname, 'CFO_Reports');

// Months: April 2025 to February 2026
const months = [
    { from: '2025-04-01', to: '2025-04-30', label: 'April 2025' },
    { from: '2025-05-01', to: '2025-05-31', label: 'May 2025' },
    { from: '2025-06-01', to: '2025-06-30', label: 'June 2025' },
    { from: '2025-07-01', to: '2025-07-31', label: 'July 2025' },
    { from: '2025-08-01', to: '2025-08-31', label: 'August 2025' },
    { from: '2025-09-01', to: '2025-09-30', label: 'September 2025' },
    { from: '2025-10-01', to: '2025-10-31', label: 'October 2025' },
    { from: '2025-11-01', to: '2025-11-30', label: 'November 2025' },
    { from: '2025-12-01', to: '2025-12-31', label: 'December 2025' },
    { from: '2026-01-01', to: '2026-01-31', label: 'January 2026' },
    { from: '2026-02-01', to: '2026-02-28', label: 'February 2026' },
    { from: '2025-04-01', to: '2026-02-28', label: 'YTD (Apr 25 - Feb 26)' },
];

// Folders: All consolidated + individual cities
const folders = [
    { folder: 'All (Consolidated)', queryParams: 'type=All' },
    { folder: 'Bangalore', queryParams: 'city=Bangalore&type=All' },
    { folder: 'Chennai', queryParams: 'city=Chennai&type=All' },
    { folder: 'Hyderabad', queryParams: 'city=Hyderabad&type=All' },
    { folder: 'Mysore', queryParams: 'city=Mysore&type=All' },
    { folder: 'Noida', queryParams: 'city=Noida&type=All' },
];

function downloadReport(url, filePath) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            if (res.statusCode !== 200) {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`)));
                return;
            }
            const ws = fs.createWriteStream(filePath);
            res.pipe(ws);
            ws.on('finish', () => { ws.close(); resolve(); });
            ws.on('error', reject);
        }).on('error', reject);
    });
}

async function main() {
    // Clean and create output dir
    if (fs.existsSync(OUTPUT_DIR)) {
        fs.rmSync(OUTPUT_DIR, { recursive: true });
    }

    let total = folders.length * months.length;
    let done = 0;
    let failed = 0;
    const failures = [];

    for (const f of folders) {
        const folderPath = path.join(OUTPUT_DIR, f.folder);
        fs.mkdirSync(folderPath, { recursive: true });

        for (const m of months) {
            const fileName = `CFO_Insights_${m.label}.docx`;
            const filePath = path.join(folderPath, fileName);
            const url = `${BASE}/api/reports/download?format=docx&${f.queryParams}&fromDate=${m.from}&toDate=${m.to}`;

            try {
                await downloadReport(url, filePath);
                done++;
                const size = fs.statSync(filePath).size;
                console.log(`[${done}/${total}] ✓ ${f.folder}/${fileName} (${(size / 1024).toFixed(0)} KB)`);
            } catch (err) {
                failed++;
                done++;
                failures.push(`${f.folder}/${fileName}: ${err.message}`);
                console.log(`[${done}/${total}] ✗ ${f.folder}/${fileName} - ${err.message}`);
            }
        }
    }

    console.log(`\n========================================`);
    console.log(`Done: ${done - failed} succeeded, ${failed} failed out of ${total}`);
    if (failures.length > 0) {
        console.log(`\nFailures:`);
        failures.forEach(f => console.log(`  - ${f}`));
    }
    console.log(`\nOutput: ${OUTPUT_DIR}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
