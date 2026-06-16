import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, exec } from 'node:child_process';
import express from 'express';
import Busboy from 'busboy';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const importsDir = path.join(dataDir, 'imports');
const publicDir = path.join(rootDir, 'public');
const dbPath = path.resolve(process.env.LOOKUP_DB_PATH || path.join(dataDir, 'scpper-ratings.db'));
const port = Number(process.env.PORT || 3000);

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(importsDir, { recursive: true });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));

const jobs = new Map();

function openBrowser(url) {
  const command = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(command, () => {});
}

function getDb() {
  if (!fs.existsSync(dbPath)) return null;
  return new DatabaseSync(dbPath, { readOnly: true });
}

function metadata() {
  const db = getDb();
  if (!db) return { ready: false, dbPath };
  try {
    const rows = db.prepare('SELECT key, value FROM import_metadata ORDER BY key').all();
    const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return { ready: true, dbPath, metadata: meta };
  } finally {
    db.close();
  }
}

function startImport(inputPath) {
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id: jobId,
    status: 'running',
    inputPath,
    outputPath: dbPath,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
    lastEvent: null,
  };
  jobs.set(jobId, job);

  const child = spawn(process.execPath, [
    path.join(__dirname, 'import-worker.js'),
    `--input=${inputPath}`,
    `--output=${dbPath}`,
  ], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stdoutBuffer = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        job.lastEvent = event;
        job.updatedAt = new Date().toISOString();
        job.messages.push(event.message || JSON.stringify(event));
        if (job.messages.length > 50) job.messages.shift();
      } catch {
        job.messages.push(line);
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    job.updatedAt = new Date().toISOString();
    job.messages.push(chunk.trim());
    if (job.messages.length > 50) job.messages.shift();
  });

  child.on('exit', (code) => {
    job.updatedAt = new Date().toISOString();
    job.finishedAt = new Date().toISOString();
    job.exitCode = code;
    if (code === 0) {
      job.status = 'done';
      job.messages.push('Import finished successfully.');
    } else {
      job.status = 'error';
      job.messages.push(`Import failed with exit code ${code}.`);
    }
  });

  return job;
}

app.get('/api/status', (_req, res) => {
  res.json(metadata());
});

app.get('/api/sites', (_req, res) => {
  const db = getDb();
  if (!db) return res.json([]);
  try {
    const rows = db.prepare('SELECT short_name, wikidot_name FROM sites ORDER BY short_name').all();
    res.json(rows);
  } finally {
    db.close();
  }
});

app.get('/api/tags', (req, res) => {
  const db = getDb();
  if (!db) return res.status(400).json({ error: 'No lookup database has been imported yet.' });
  try {
    const site = String(req.query.site || 'en').trim();
    const q = String(req.query.q || '').trim().toLowerCase();
    const limit = parseLimit(req.query.limit, 100, 500);
    if (!/^[a-z0-9_-]{1,10}$/i.test(site)) return res.status(400).json({ error: 'Invalid site code.' });
    const rows = db.prepare(`
      SELECT pt.tag, COUNT(*) AS pages
      FROM page_tags pt
      JOIN pages p ON p.page_id = pt.page_id
      JOIN sites s ON s.site_id = p.site_id
      WHERE s.short_name = ?
        AND (? = '' OR pt.tag LIKE ?)
      GROUP BY pt.tag
      ORDER BY pages DESC, pt.tag ASC
      LIMIT ?
    `).all(site, q, `%${q}%`, limit);
    res.json({ rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    db.close();
  }
});

app.post('/api/import-path', (req, res) => {
  const inputPath = String(req.body?.path || '').trim();
  if (!inputPath) return res.status(400).json({ error: 'Path is required.' });
  if (!fs.existsSync(inputPath)) return res.status(400).json({ error: `File does not exist: ${inputPath}` });
  const job = startImport(inputPath);
  res.json({ jobId: job.id });
});

app.post('/api/import-upload', (req, res) => {
  const bb = Busboy({ headers: req.headers });
  let savedPath = null;
  let filePromise = null;

  bb.on('file', (_name, file, info) => {
    const safeName = path.basename(info.filename || `scpper-${Date.now()}.sql.gz`).replace(/[^a-zA-Z0-9_.-]/g, '_');
    savedPath = path.join(importsDir, `${Date.now()}-${safeName}`);
    const writeStream = fs.createWriteStream(savedPath);
    filePromise = new Promise((resolve, reject) => {
      file.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      file.on('error', reject);
    });
  });

  bb.on('error', (error) => {
    res.status(500).json({ error: error.message });
  });

  bb.on('close', async () => {
    try {
      if (!filePromise || !savedPath) return res.status(400).json({ error: 'No dump file uploaded.' });
      await filePromise;
      const job = startImport(savedPath);
      res.json({ jobId: job.id, savedPath });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  req.pipe(bb);
});

app.get('/api/import/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json(job);
});

function validatePage(value) {
  return typeof value === 'string' && /^[a-z0-9_:\-\/]+$/i.test(value);
}

function normalizeDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Date must be YYYY-MM-DD.');
  return `${date} 23:59:59`;
}

app.get('/api/rating', (req, res) => {
  const db = getDb();
  if (!db) return res.status(400).json({ error: 'No lookup database has been imported yet.' });

  try {
    const site = String(req.query.site || 'en').trim();
    const page = String(req.query.page || '').trim().toLowerCase();
    const date = String(req.query.date || '').trim();

    if (!/^[a-z0-9_-]{1,10}$/i.test(site)) return res.status(400).json({ error: 'Invalid site code.' });
    if (!validatePage(page)) return res.status(400).json({ error: 'Invalid page slug.' });

    let asOf;
    try {
      asOf = normalizeDate(date);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const row = db.prepare(`
      SELECT
        p.page_id AS page_id,
        p.url AS url,
        s.short_name AS site,
        p.name AS name,
        p.title AS title,
        p.deleted AS deleted,
        p.current_rating AS current_rating,
        ? AS as_of,
        COALESCE(SUM(e.rating_delta), 0) AS rating_as_of,
        COALESCE(SUM(e.positive_delta), 0) AS positive_value_as_of,
        COALESCE(SUM(e.negative_delta), 0) AS negative_value_as_of,
        COALESCE(SUM(e.nonzero_vote_delta), 0) AS nonzero_vote_count_as_of
      FROM pages p
      JOIN sites s ON s.site_id = p.site_id
      LEFT JOIN rating_events e
        ON e.page_id = p.page_id
       AND e.event_time <= ?
      WHERE s.short_name = ?
        AND p.name = ?
      GROUP BY
        p.page_id,
        p.url,
        s.short_name,
        p.name,
        p.title,
        p.deleted,
        p.current_rating
    `).get(asOf, asOf, site, page);

    if (!row) return res.status(404).json({ error: 'Page not found.' });
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    db.close();
  }
});

app.get('/api/search-pages', (req, res) => {
  const db = getDb();
  if (!db) return res.status(400).json({ error: 'No lookup database has been imported yet.' });

  try {
    const site = String(req.query.site || 'en').trim();
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json([]);
    const rows = db.prepare(`
      SELECT p.name, p.title, p.url, p.current_rating
      FROM pages p
      JOIN sites s ON s.site_id = p.site_id
      WHERE s.short_name = ?
        AND (p.name LIKE ? OR LOWER(COALESCE(p.title, '')) LIKE ?)
      ORDER BY p.name
      LIMIT 25
    `).all(site, `%${q}%`, `%${q}%`);
    res.json(rows);
  } finally {
    db.close();
  }
});

function parseLimit(value, fallback = 100, max = 1000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function parseTags(value) {
  return String(value || '')
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .filter((tag, index, arr) => arr.indexOf(tag) === index);
}

function normalizeStartDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Date must be YYYY-MM-DD.');
  return `${date} 00:00:00`;
}

function monthRange(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    throw new Error('Invalid date range.');
  }
  const out = [];
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cur <= end) {
    out.push(`${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}-01`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

app.get('/api/reports/threshold', (req, res) => {
  const db = getDb();
  if (!db) return res.status(400).json({ error: 'No lookup database has been imported yet.' });
  try {
    const site = String(req.query.site || 'en').trim();
    const maxRating = Number(req.query.maxRating ?? 0);
    const includeDeleted = String(req.query.includeDeleted || 'false') === 'true';
    const limit = parseLimit(req.query.limit, 100, 1000);
    if (!/^[a-z0-9_-]{1,10}$/i.test(site)) return res.status(400).json({ error: 'Invalid site code.' });
    if (!Number.isFinite(maxRating)) return res.status(400).json({ error: 'maxRating must be a number.' });

    const rows = db.prepare(`
      SELECT
        p.page_id,
        p.url,
        p.name,
        p.title,
        p.current_rating,
        p.deleted,
        p.creation_date,
        p.status_name,
        p.kind_name,
        p.category
      FROM pages p
      JOIN sites s ON s.site_id = p.site_id
      WHERE s.short_name = ?
        AND COALESCE(p.current_rating, 0) <= ?
        AND (? = 1 OR p.deleted = 0)
      ORDER BY COALESCE(p.current_rating, 0) ASC, p.creation_date ASC, p.name ASC
      LIMIT ?
    `).all(site, maxRating, includeDeleted ? 1 : 0, limit);
    res.json({ rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    db.close();
  }
});

app.get('/api/reports/top-pages', (req, res) => {
  const db = getDb();
  if (!db) return res.status(400).json({ error: 'No lookup database has been imported yet.' });
  try {
    const site = String(req.query.site || 'en').trim();
    const direction = String(req.query.direction || 'highest');
    const includeDeleted = String(req.query.includeDeleted || 'false') === 'true';
    const limit = parseLimit(req.query.limit, 100, 1000);
    if (!/^[a-z0-9_-]{1,10}$/i.test(site)) return res.status(400).json({ error: 'Invalid site code.' });
    const order = direction === 'lowest' ? 'ASC' : 'DESC';
    const rows = db.prepare(`
      SELECT
        p.page_id,
        p.url,
        p.name,
        p.title,
        p.current_rating,
        p.deleted,
        p.creation_date,
        p.status_name,
        p.kind_name,
        p.category
      FROM pages p
      JOIN sites s ON s.site_id = p.site_id
      WHERE s.short_name = ?
        AND p.current_rating IS NOT NULL
        AND (? = 1 OR p.deleted = 0)
      ORDER BY p.current_rating ${order}, p.name ASC
      LIMIT ?
    `).all(site, includeDeleted ? 1 : 0, limit);
    res.json({ rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    db.close();
  }
});

app.get('/api/reports/trajectory', (req, res) => {
  const db = getDb();
  if (!db) return res.status(400).json({ error: 'No lookup database has been imported yet.' });
  try {
    const site = String(req.query.site || 'en').trim();
    const page = String(req.query.page || '').trim().toLowerCase();
    const start = String(req.query.start || '').trim();
    const end = String(req.query.end || '').trim();
    if (!/^[a-z0-9_-]{1,10}$/i.test(site)) return res.status(400).json({ error: 'Invalid site code.' });
    if (!validatePage(page)) return res.status(400).json({ error: 'Invalid page slug.' });
    normalizeStartDate(start);
    normalizeStartDate(end);
    const dates = monthRange(start, end);
    if (dates.length > 600) return res.status(400).json({ error: 'Date range is too large.' });

    const pageRow = db.prepare(`
      SELECT p.page_id, p.url, p.name, p.title, p.current_rating
      FROM pages p
      JOIN sites s ON s.site_id = p.site_id
      WHERE s.short_name = ? AND p.name = ?
    `).get(site, page);
    if (!pageRow) return res.status(404).json({ error: 'Page not found.' });

    const stmt = db.prepare(`
      SELECT COALESCE(SUM(rating_delta), 0) AS rating_as_of,
             COALESCE(SUM(positive_delta), 0) AS positive_value_as_of,
             COALESCE(SUM(negative_delta), 0) AS negative_value_as_of,
             COALESCE(SUM(nonzero_vote_delta), 0) AS nonzero_vote_count_as_of
      FROM rating_events
      WHERE page_id = ? AND event_time <= ?
    `);
    const rows = dates.map((d) => {
      const asOf = normalizeDate(d);
      return { date: d, as_of: asOf, ...stmt.get(pageRow.page_id, asOf) };
    });
    res.json({ page: pageRow, rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    db.close();
  }
});

app.get('/api/reports/monthly-creation', (req, res) => {
  const db = getDb();
  if (!db) return res.status(400).json({ error: 'No lookup database has been imported yet.' });
  try {
    const site = String(req.query.site || 'en').trim();
    const start = normalizeStartDate(String(req.query.start || '2008-01-01').trim());
    const end = normalizeStartDate(String(req.query.end || '2026-12-31').trim());
    if (!/^[a-z0-9_-]{1,10}$/i.test(site)) return res.status(400).json({ error: 'Invalid site code.' });
    const rows = db.prepare(`
      SELECT
        substr(p.creation_date, 1, 7) AS creation_month,
        COUNT(*) AS pages_created,
        SUM(CASE WHEN p.deleted = 1 THEN 1 ELSE 0 END) AS deleted_pages,
        ROUND(AVG(p.current_rating), 2) AS avg_current_rating,
        SUM(CASE WHEN p.current_rating < 0 THEN 1 ELSE 0 END) AS pages_below_zero,
        SUM(CASE WHEN p.current_rating >= 100 THEN 1 ELSE 0 END) AS pages_100_plus,
        SUM(CASE WHEN p.current_rating >= 500 THEN 1 ELSE 0 END) AS pages_500_plus
      FROM pages p
      JOIN sites s ON s.site_id = p.site_id
      WHERE s.short_name = ?
        AND p.creation_date IS NOT NULL
        AND p.creation_date >= ?
        AND p.creation_date < ?
      GROUP BY creation_month
      ORDER BY creation_month
    `).all(site, start, end);
    res.json({ rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    db.close();
  }
});

app.get('/api/reports/contest-window', (req, res) => {
  const db = getDb();
  if (!db) return res.status(400).json({ error: 'No lookup database has been imported yet.' });
  try {
    const site = String(req.query.site || 'en').trim();
    const start = normalizeStartDate(String(req.query.start || '').trim());
    const end = normalizeStartDate(String(req.query.end || '').trim());
    const includeDeleted = String(req.query.includeDeleted || 'true') === 'true';
    const limit = parseLimit(req.query.limit, 500, 5000);
    if (!/^[a-z0-9_-]{1,10}$/i.test(site)) return res.status(400).json({ error: 'Invalid site code.' });
    const rows = db.prepare(`
      SELECT
        p.page_id,
        p.url,
        p.name,
        p.title,
        p.creation_date,
        p.current_rating,
        p.deleted,
        p.status_name,
        p.kind_name,
        p.category
      FROM pages p
      JOIN sites s ON s.site_id = p.site_id
      WHERE s.short_name = ?
        AND p.creation_date IS NOT NULL
        AND p.creation_date >= ?
        AND p.creation_date < ?
        AND (? = 1 OR p.deleted = 0)
      ORDER BY p.current_rating DESC, p.creation_date ASC
      LIMIT ?
    `).all(site, start, end, includeDeleted ? 1 : 0, limit);
    res.json({ rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    db.close();
  }
});


app.get('/api/reports/bulk-pages', (req, res) => {
  const db = getDb();
  if (!db) return res.status(400).json({ error: 'No lookup database has been imported yet.' });
  try {
    const site = String(req.query.site || 'en').trim();
    const start = normalizeStartDate(String(req.query.start || '').trim());
    const end = normalizeStartDate(String(req.query.end || '').trim());
    const asOf = normalizeDate(String(req.query.asOf || req.query.end || '').trim());
    const includeDeleted = String(req.query.includeDeleted || 'false') === 'true';
    const limit = parseLimit(req.query.limit, 500, 10000);
    const tags = parseTags(req.query.tags);
    const tagMode = String(req.query.tagMode || 'all') === 'any' ? 'any' : 'all';

    if (!/^[a-z0-9_-]{1,10}$/i.test(site)) return res.status(400).json({ error: 'Invalid site code.' });
    if (tags.length > 25) return res.status(400).json({ error: 'Too many tags. Use 25 or fewer.' });

    const params = [site, start, end, includeDeleted ? 1 : 0];
    let tagClause = '';
    if (tags.length) {
      const placeholders = tags.map(() => '?').join(', ');
      if (tagMode === 'any') {
        tagClause = `
          AND EXISTS (
            SELECT 1 FROM page_tags pt
            WHERE pt.page_id = p.page_id
              AND pt.tag IN (${placeholders})
          )
        `;
        params.push(...tags);
      } else {
        tagClause = `
          AND (
            SELECT COUNT(DISTINCT pt.tag)
            FROM page_tags pt
            WHERE pt.page_id = p.page_id
              AND pt.tag IN (${placeholders})
          ) = ?
        `;
        params.push(...tags, tags.length);
      }
    }
    params.push(asOf, asOf, limit);

    const rows = db.prepare(`
      WITH target_pages AS (
        SELECT
          p.page_id,
          p.url,
          p.name,
          p.title,
          p.creation_date,
          p.current_rating,
          p.deleted,
          p.status_name,
          p.kind_name,
          p.category
        FROM pages p
        JOIN sites s ON s.site_id = p.site_id
        WHERE s.short_name = ?
          AND p.creation_date IS NOT NULL
          AND p.creation_date >= ?
          AND p.creation_date < ?
          AND (? = 1 OR p.deleted = 0)
          ${tagClause}
      ),
      rating_as_of AS (
        SELECT
          e.page_id,
          SUM(e.rating_delta) AS rating_as_of,
          SUM(e.positive_delta) AS positive_value_as_of,
          SUM(e.negative_delta) AS negative_value_as_of,
          SUM(e.nonzero_vote_delta) AS nonzero_vote_count_as_of
        FROM rating_events e
        JOIN target_pages tp ON tp.page_id = e.page_id
        WHERE e.event_time <= ?
        GROUP BY e.page_id
      )
      SELECT
        tp.page_id,
        tp.url,
        tp.name,
        tp.title,
        tp.creation_date,
        ? AS rating_as_of_date,
        COALESCE(rao.rating_as_of, 0) AS rating_as_of,
        COALESCE(rao.positive_value_as_of, 0) AS positive_value_as_of,
        COALESCE(rao.negative_value_as_of, 0) AS negative_value_as_of,
        COALESCE(rao.nonzero_vote_count_as_of, 0) AS nonzero_vote_count_as_of,
        tp.current_rating,
        tp.deleted,
        tp.status_name,
        tp.kind_name,
        tp.category,
        COALESCE((SELECT group_concat(tag, ';') FROM page_tags WHERE page_id = tp.page_id ORDER BY tag), '') AS tags
      FROM target_pages tp
      LEFT JOIN rating_as_of rao ON rao.page_id = tp.page_id
      ORDER BY rating_as_of DESC, tp.creation_date ASC, tp.name ASC
      LIMIT ?
    `).all(...params);
    res.json({ rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    db.close();
  }
});

app.get('/api/reports/site-summary', (req, res) => {
  const db = getDb();
  if (!db) return res.status(400).json({ error: 'No lookup database has been imported yet.' });
  try {
    const rows = db.prepare(`
      SELECT
        s.short_name,
        s.wikidot_name,
        COUNT(p.page_id) AS pages,
        SUM(CASE WHEN p.deleted = 1 THEN 1 ELSE 0 END) AS deleted_pages,
        ROUND(100.0 * SUM(CASE WHEN p.deleted = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(p.page_id), 0), 2) AS deleted_percent,
        ROUND(AVG(p.current_rating), 2) AS avg_current_rating,
        MIN(p.creation_date) AS first_creation_date,
        MAX(p.creation_date) AS latest_creation_date
      FROM sites s
      LEFT JOIN pages p ON p.site_id = s.site_id
      GROUP BY s.short_name, s.wikidot_name
      ORDER BY pages DESC
    `).all();
    res.json({ rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    db.close();
  }
});

app.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`SCPper Rating Lookup running at ${url}`);
  if (process.env.NO_OPEN !== '1') openBrowser(url);
});
