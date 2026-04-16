import { Router, type Request, type Response } from 'express';

const router = Router();
const isProd = process.env.NODE_ENV === 'production';

/**
 * GET /api/db/tables
 * List all tables and views with row counts
 */
router.get('/tables', async (_req: Request, res: Response) => {
  const db = _req.tenantDb!;
  const tables = db.all(`
    SELECT name, type FROM sqlite_master
    WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `);

  const result = tables.map((t: any) => {
    let count = 0;
    try {
      const row = db.get(`SELECT COUNT(*) as cnt FROM "${t.name}"`);
      count = row?.cnt || 0;
    } catch { /* view might fail */ }
    return { name: t.name, type: t.type, rowCount: count };
  });

  res.json(result);
});

/**
 * GET /api/db/table/:name
 * View contents of a specific table (with optional limit/offset)
 */
router.get('/table/:name', async (req: Request, res: Response) => {
  const db = req.tenantDb!;
  const tableName = req.params.name as string;

  // Validate table name to prevent SQL injection
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }

  const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
  const offset = parseInt(req.query.offset as string) || 0;

  // Verify table exists
  const exists = db.get(
    `SELECT name FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')`,
    tableName
  );
  if (!exists) {
    return res.status(404).json({ error: `Table "${tableName}" not found` });
  }

  // Get columns
  let columns: string[] = [];
  try {
    const cols = db.all(`PRAGMA table_info("${tableName}")`);
    columns = cols.map((c: any) => c.name);
  } catch {
    // For views, get columns from first row
  }

  // Get total count
  let total = 0;
  try {
    const cnt = db.get(`SELECT COUNT(*) as cnt FROM "${tableName}"`);
    total = cnt?.cnt || 0;
  } catch {}

  // Get rows
  const rows = db.all(`SELECT * FROM "${tableName}" LIMIT ? OFFSET ?`, [limit, offset]);

  // If columns empty (view), infer from first row
  if (columns.length === 0 && rows.length > 0) {
    columns = Object.keys(rows[0]);
  }

  res.json({ table: tableName, columns, total, limit, offset, rows });
});

/**
 * GET /api/db/query?sql=...
 * Run a read-only SQL query (SELECT only)
 */
router.get('/query', async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'SQL query endpoint disabled in production' });
  }

  const db = req.tenantDb!;
  const sql = (req.query.sql as string || '').trim();

  if (!sql) {
    return res.status(400).json({ error: 'Missing ?sql= parameter' });
  }

  // Reject queries containing semicolons (prevent multi-statement injection)
  if (sql.includes(';')) {
    return res.status(400).json({ error: 'Semicolons are not allowed in queries' });
  }

  // Only allow SELECT and PRAGMA queries
  const upper = sql.toUpperCase();
  if (!upper.startsWith('SELECT') && !upper.startsWith('PRAGMA') && !upper.startsWith('WITH')) {
    return res.status(403).json({ error: 'Only SELECT/PRAGMA queries allowed' });
  }

  // Reject dangerous keywords that could appear in subqueries
  const dangerous = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|REPLACE)\b/i;
  if (dangerous.test(sql)) {
    return res.status(403).json({ error: 'Query contains disallowed keywords' });
  }

  try {
    const rows = db.all(sql);
    res.json({ sql, rowCount: rows.length, rows });
  } catch (err: any) {
    res.status(400).json({ error: isProd ? 'Query execution failed' : err.message, sql });
  }
});

/**
 * GET /api/db/
 * Serve a simple HTML page to browse the database
 */
router.get('/', async (_req: Request, res: Response) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Magna Tracker - DB Viewer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f1f5f9; color: #1e293b; padding: 20px; }
    h1 { color: #0d9488; margin-bottom: 20px; }
    h2 { color: #334155; margin: 20px 0 10px; }
    .card { background: white; border-radius: 8px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .tables-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .table-card { background: white; border-radius: 8px; padding: 12px 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); cursor: pointer; transition: all 0.2s; border-left: 4px solid #0d9488; }
    .table-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.15); transform: translateY(-1px); }
    .table-card .name { font-weight: 600; font-size: 14px; }
    .table-card .info { color: #64748b; font-size: 12px; margin-top: 4px; }
    .table-card.view { border-left-color: #8b5cf6; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { background: #f8fafc; text-align: left; padding: 8px 12px; border-bottom: 2px solid #e2e8f0; font-weight: 600; color: #475569; position: sticky; top: 0; }
    td { padding: 6px 12px; border-bottom: 1px solid #f1f5f9; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    tr:hover td { background: #f0fdfa; }
    .table-wrapper { max-height: 500px; overflow: auto; border-radius: 8px; border: 1px solid #e2e8f0; }
    .query-box { width: 100%; padding: 10px; font-family: monospace; font-size: 14px; border: 2px solid #e2e8f0; border-radius: 8px; margin-bottom: 10px; min-height: 60px; }
    .query-box:focus { outline: none; border-color: #0d9488; }
    button { background: #0d9488; color: white; border: none; padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 14px; }
    button:hover { background: #0f766e; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
    .badge-table { background: #d1fae5; color: #065f46; }
    .badge-view { background: #ede9fe; color: #5b21b6; }
    .pagination { display: flex; gap: 8px; align-items: center; margin-top: 10px; font-size: 13px; color: #64748b; }
    .pagination button { padding: 4px 12px; font-size: 12px; }
    #status { color: #64748b; font-size: 13px; margin: 8px 0; }
    .screenshots { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
    .screenshots img { width: 100%; border-radius: 8px; border: 1px solid #e2e8f0; cursor: pointer; }
    .screenshots img:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
    .tab-bar { display: flex; gap: 4px; margin-bottom: 16px; }
    .tab { padding: 8px 16px; border-radius: 6px 6px 0 0; cursor: pointer; font-weight: 500; background: #e2e8f0; }
    .tab.active { background: #0d9488; color: white; }
  </style>
</head>
<body>
  <h1>Magna Tracker - Database Viewer</h1>

  <div class="tab-bar">
    <div class="tab active" onclick="showTab('tables')">Tables</div>
    <div class="tab" onclick="showTab('query')">SQL Query</div>
    <div class="tab" onclick="showTab('debug')">Debug Screenshots</div>
  </div>

  <div id="tab-tables">
    <div id="tables-list" class="tables-grid">Loading...</div>
    <div id="table-content" class="card" style="display:none">
      <h2 id="table-title"></h2>
      <div id="status"></div>
      <div class="table-wrapper"><table id="data-table"><thead></thead><tbody></tbody></table></div>
      <div class="pagination" id="pagination"></div>
    </div>
  </div>

  <div id="tab-query" style="display:none">
    <div class="card">
      <h2>Run SQL Query</h2>
      <textarea class="query-box" id="sql-input" placeholder="SELECT * FROM clinic_actuals LIMIT 50">SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY type, name</textarea>
      <button onclick="runQuery()">Run Query</button>
      <div id="query-status" style="margin-top: 8px; font-size: 13px; color: #64748b;"></div>
      <div class="table-wrapper" style="margin-top: 12px;"><table id="query-table"><thead></thead><tbody></tbody></table></div>
    </div>
  </div>

  <div id="tab-debug" style="display:none">
    <div class="card">
      <h2>Sync Debug Screenshots</h2>
      <p style="color: #64748b; margin-bottom: 12px;">Screenshots captured during the last Oneglance/Healthplix sync attempt</p>
      <div id="screenshots" class="screenshots">Loading...</div>
    </div>
  </div>

  <script>
    const BASE = window.location.origin;
    const TOKEN = localStorage.getItem('auth_token') || prompt('Enter auth token (login first at the app, or enter admin token):');

    const headers = { 'Authorization': 'Bearer ' + TOKEN };

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = String(s ?? '');
      return d.innerHTML;
    }

    function showTab(name) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('[id^="tab-"]').forEach(t => t.style.display = 'none');
      event.target.classList.add('active');
      document.getElementById('tab-' + name).style.display = 'block';
      if (name === 'debug') loadScreenshots();
    }

    async function loadTables() {
      const res = await fetch(BASE + '/api/db/tables', { headers });
      const data = await res.json();
      const grid = document.getElementById('tables-list');
      grid.innerHTML = data.map(t =>
        '<div class="table-card ' + esc(t.type) + '" onclick="loadTable(\\'' + esc(t.name) + '\\')">' +
        '<div class="name">' + esc(t.name) + ' <span class="badge badge-' + esc(t.type) + '">' + esc(t.type) + '</span></div>' +
        '<div class="info">' + esc(t.rowCount) + ' rows</div></div>'
      ).join('');
    }

    let currentTable = '', currentOffset = 0;
    async function loadTable(name, offset) {
      currentTable = name;
      currentOffset = offset || 0;
      document.getElementById('table-content').style.display = 'block';
      document.getElementById('table-title').textContent = name;
      document.getElementById('status').textContent = 'Loading...';

      const res = await fetch(BASE + '/api/db/table/' + name + '?limit=100&offset=' + currentOffset, { headers });
      const data = await res.json();

      document.getElementById('status').textContent = 'Showing ' + (currentOffset + 1) + '-' + (currentOffset + data.rows.length) + ' of ' + data.total + ' rows';

      const thead = document.querySelector('#data-table thead');
      const tbody = document.querySelector('#data-table tbody');
      thead.innerHTML = '<tr>' + data.columns.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr>';
      tbody.innerHTML = data.rows.map(r => '<tr>' + data.columns.map(c => '<td title="' + esc(r[c]) + '">' + (r[c] != null ? esc(r[c]) : '<em style=color:#94a3b8>null</em>') + '</td>').join('') + '</tr>').join('');

      const pag = document.getElementById('pagination');
      let pagHtml = '';
      if (currentOffset > 0) pagHtml += '<button onclick="loadTable(\\'' + name + '\\',' + (currentOffset - 100) + ')">Previous</button>';
      if (currentOffset + 100 < data.total) pagHtml += '<button onclick="loadTable(\\'' + name + '\\',' + (currentOffset + 100) + ')">Next</button>';
      pagHtml += '<span>' + data.total + ' total rows</span>';
      pag.innerHTML = pagHtml;

      document.getElementById('table-content').scrollIntoView({ behavior: 'smooth' });
    }

    async function runQuery() {
      const sql = document.getElementById('sql-input').value.trim();
      if (!sql) return;
      document.getElementById('query-status').textContent = 'Running...';

      try {
        const res = await fetch(BASE + '/api/db/query?sql=' + encodeURIComponent(sql), { headers });
        const data = await res.json();
        if (data.error) {
          document.getElementById('query-status').textContent = 'Error: ' + data.error;
          return;
        }
        document.getElementById('query-status').textContent = data.rowCount + ' rows returned';
        const cols = data.rows.length > 0 ? Object.keys(data.rows[0]) : [];
        const thead = document.querySelector('#query-table thead');
        const tbody = document.querySelector('#query-table tbody');
        thead.innerHTML = '<tr>' + cols.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr>';
        tbody.innerHTML = data.rows.map(r => '<tr>' + cols.map(c => '<td>' + (r[c] != null ? esc(r[c]) : '') + '</td>').join('') + '</tr>').join('');
      } catch (e) {
        document.getElementById('query-status').textContent = 'Error: ' + e.message;
      }
    }

    async function loadScreenshots() {
      try {
        const res = await fetch(BASE + '/api/sync/debug/screenshots', { headers });
        const data = await res.json();
        const div = document.getElementById('screenshots');
        if (!data.screenshots || data.screenshots.length === 0) {
          div.innerHTML = '<p>No debug screenshots yet. Run a sync to capture them.</p>';
          return;
        }
        div.innerHTML = data.screenshots.map(s =>
          '<div><img src="' + BASE + s.url + '" alt="' + s.name + '" onclick="window.open(this.src)"><div style="font-size:12px;color:#64748b;margin-top:4px;">' + s.name + '</div></div>'
        ).join('');
      } catch (e) {
        document.getElementById('screenshots').innerHTML = '<p>Error loading screenshots: ' + e.message + '</p>';
      }
    }

    document.getElementById('sql-input').addEventListener('keydown', e => {
      if (e.ctrlKey && e.key === 'Enter') runQuery();
    });

    loadTables();
  </script>
</body>
</html>`;
  res.type('html').send(html);
});

export default router;
