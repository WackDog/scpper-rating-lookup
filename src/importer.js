import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const REQUIRED_TABLES = new Set([
  'sites',
  'categories',
  'dict_page_kind',
  'dict_status',
  'pages',
  'page_summary',
  'page_status',
  'revisions',
  'tags',
  'votes',
  'vote_history',
]);

const INSERT_RE = /^INSERT\s+INTO\s+`?([A-Za-z0-9_]+)`?\s*(?:\(([^)]*)\))?\s+VALUES\s+/i;
const CREATE_RE = /^CREATE\s+TABLE\s+`?([A-Za-z0-9_]+)`?/i;

function openPossiblyGzippedReadStream(filePath) {
  const source = fs.createReadStream(filePath);
  if (filePath.toLowerCase().endsWith('.gz')) return source.pipe(zlib.createGunzip());
  return source;
}

function emitProgress(progress, event) {
  if (typeof progress === 'function') progress(event);
}

function unescapeSqlString(value) {
  return value
    .replace(/\\0/g, '\0')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\b/g, '\b')
    .replace(/\\Z/g, '\x1a')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function parseScalar(raw) {
  if (raw === undefined) return null;
  const value = raw.trim();
  if (value.length === 0) return '';
  if (/^NULL$/i.test(value)) return null;
  if (value[0] === "'" && value[value.length - 1] === "'") return unescapeSqlString(value.slice(1, -1));
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}

function* parseValueTuples(valuesSql) {
  let i = 0;
  const n = valuesSql.length;

  while (i < n) {
    while (i < n && /[\s,;]/.test(valuesSql[i])) i++;
    if (i >= n) break;
    if (valuesSql[i] !== '(') {
      i++;
      continue;
    }

    i++;
    const row = [];
    let token = '';
    let inString = false;
    let escape = false;

    while (i < n) {
      const ch = valuesSql[i];

      if (inString) {
        token += ch;
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === "'") inString = false;
        i++;
        continue;
      }

      if (ch === "'") {
        inString = true;
        token += ch;
        i++;
        continue;
      }

      if (ch === ',') {
        row.push(parseScalar(token));
        token = '';
        i++;
        continue;
      }

      if (ch === ')') {
        row.push(parseScalar(token));
        i++;
        break;
      }

      token += ch;
      i++;
    }

    yield row;
  }
}

function parseCreateColumns(statement) {
  const match = statement.match(CREATE_RE);
  if (!match) return null;
  const table = match[1];
  const columns = [];
  const lines = statement.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    const colMatch = trimmed.match(/^`([^`]+)`\s+/);
    if (colMatch) columns.push(colMatch[1]);
  }
  return { table, columns };
}

function parseInsertHeader(statement) {
  const match = statement.match(INSERT_RE);
  if (!match) return null;
  const table = match[1];
  const rawColumns = match[2];
  const valuesStart = match[0].length;
  let columns = null;
  if (rawColumns) columns = rawColumns.split(',').map((c) => c.trim().replace(/^`|`$/g, ''));
  return { table, columns, valuesSql: statement.slice(valuesStart) };
}

function rowObject(columns, row) {
  const out = Object.create(null);
  for (let i = 0; i < columns.length; i++) out[columns[i]] = row[i];
  return out;
}

function normalizeDateTime(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).slice(0, 19);
}

function initLookupDb(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA foreign_keys = OFF;

    DROP TABLE IF EXISTS sites;
    DROP TABLE IF EXISTS categories;
    DROP TABLE IF EXISTS dict_status;
    DROP TABLE IF EXISTS dict_page_kind;
    DROP TABLE IF EXISTS pages;
    DROP TABLE IF EXISTS rating_events;
    DROP TABLE IF EXISTS page_tags;
    DROP TABLE IF EXISTS import_metadata;
    DROP TABLE IF EXISTS temp_vote_events;
    DROP TABLE IF EXISTS temp_revision_events;
    DROP TABLE IF EXISTS temp_page_summary;
    DROP TABLE IF EXISTS temp_page_status;

    CREATE TABLE sites (
      site_id INTEGER PRIMARY KEY,
      short_name TEXT NOT NULL,
      wikidot_name TEXT NOT NULL
    );

    CREATE TABLE categories (
      site_id INTEGER NOT NULL,
      category_id INTEGER NOT NULL,
      name TEXT,
      ignored INTEGER DEFAULT 0,
      PRIMARY KEY (site_id, category_id)
    );

    CREATE TABLE dict_status (
      status_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE dict_page_kind (
      kind_id INTEGER PRIMARY KEY,
      name TEXT
    );

    CREATE TABLE pages (
      page_id INTEGER PRIMARY KEY,
      site_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      title TEXT,
      category_id INTEGER,
      category TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      current_rating INTEGER,
      current_clean_rating INTEGER,
      current_month_rating INTEGER,
      current_revision_count INTEGER,
      contributor_rating INTEGER,
      adjusted_rating INTEGER,
      wilson_score REAL,
      status_id INTEGER,
      status_name TEXT,
      kind_id INTEGER,
      kind_name TEXT,
      original_id INTEGER,
      fixed INTEGER,
      creation_date TEXT,
      last_revision_date TEXT,
      revision_count INTEGER DEFAULT 0,
      url TEXT
    );

    CREATE TABLE rating_events (
      page_id INTEGER NOT NULL,
      event_time TEXT NOT NULL,
      rating_delta INTEGER NOT NULL,
      positive_delta INTEGER NOT NULL,
      negative_delta INTEGER NOT NULL,
      nonzero_vote_delta INTEGER NOT NULL
    );

    CREATE TABLE page_tags (
      page_id INTEGER NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (page_id, tag)
    );

    CREATE TABLE import_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE temp_vote_events (
      page_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      value INTEGER NOT NULL,
      event_time TEXT NOT NULL,
      source_rank INTEGER NOT NULL,
      source_id INTEGER NOT NULL
    );

    CREATE TABLE temp_revision_events (
      page_id INTEGER NOT NULL,
      revision_time TEXT NOT NULL
    );

    CREATE TABLE temp_page_summary (
      page_id INTEGER PRIMARY KEY,
      rating INTEGER,
      clean_rating INTEGER,
      month_rating INTEGER,
      revision_count INTEGER,
      contributor_rating INTEGER,
      adjusted_rating INTEGER,
      wilson_score REAL
    );

    CREATE TABLE temp_page_status (
      page_id INTEGER PRIMARY KEY,
      status_id INTEGER,
      original_id INTEGER,
      fixed INTEGER,
      kind_id INTEGER
    );
  `);
}

function prepareStatements(db) {
  return {
    site: db.prepare(`INSERT OR REPLACE INTO sites (site_id, short_name, wikidot_name) VALUES (?, ?, ?)`),
    category: db.prepare(`INSERT OR REPLACE INTO categories (site_id, category_id, name, ignored) VALUES (?, ?, ?, ?)`),
    dictStatus: db.prepare(`INSERT OR REPLACE INTO dict_status (status_id, name) VALUES (?, ?)`),
    dictKind: db.prepare(`INSERT OR REPLACE INTO dict_page_kind (kind_id, name) VALUES (?, ?)`),
    page: db.prepare(`
      INSERT OR REPLACE INTO pages (
        page_id, site_id, name, title, category_id, deleted, current_rating, url
      ) VALUES (
        ?, ?, ?, ?, ?, ?, COALESCE((SELECT current_rating FROM pages WHERE page_id = ?), NULL), ?
      )
    `),
    pageSummary: db.prepare(`
      INSERT OR REPLACE INTO temp_page_summary (
        page_id, rating, clean_rating, month_rating, revision_count,
        contributor_rating, adjusted_rating, wilson_score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    pageStatus: db.prepare(`
      INSERT OR REPLACE INTO temp_page_status (
        page_id, status_id, original_id, fixed, kind_id
      ) VALUES (?, ?, ?, ?, ?)
    `),
    tempVote: db.prepare(`
      INSERT INTO temp_vote_events (page_id, user_id, value, event_time, source_rank, source_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    tempRevision: db.prepare(`INSERT INTO temp_revision_events (page_id, revision_time) VALUES (?, ?)`),
    pageTag: db.prepare(`INSERT OR IGNORE INTO page_tags (page_id, tag) VALUES (?, ?)`),
    meta: db.prepare(`INSERT OR REPLACE INTO import_metadata (key, value) VALUES (?, ?)`),
  };
}

function makeUrl(wikidotName, pageName) {
  if (!wikidotName || !pageName) return null;
  return `http://${wikidotName}.wikidot.com/${pageName}`;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function handleRow(table, obj, statements, counters) {
  counters.rowsSeen++;

  if (table === 'sites') {
    const siteId = Number(obj.WikidotId);
    if (!Number.isFinite(siteId)) return;
    statements.site.run(siteId, String(obj.ShortName ?? ''), String(obj.WikidotName ?? ''));
    counters.sites++;
    return;
  }

  if (table === 'categories') {
    const categoryId = Number(obj.WikidotId);
    const siteId = Number(obj.SiteId);
    if (!Number.isFinite(categoryId) || !Number.isFinite(siteId)) return;
    statements.category.run(siteId, categoryId, obj.Name == null ? null : String(obj.Name), Number(obj.Ignored ?? 0) || 0);
    counters.categories++;
    return;
  }

  if (table === 'dict_status') {
    const statusId = Number(obj.StatusId);
    if (!Number.isFinite(statusId)) return;
    statements.dictStatus.run(statusId, String(obj.Name ?? ''));
    counters.dictStatus++;
    return;
  }

  if (table === 'dict_page_kind') {
    const kindId = Number(obj.KindId);
    if (!Number.isFinite(kindId)) return;
    statements.dictKind.run(kindId, obj.Description == null ? null : String(obj.Description));
    counters.dictKind++;
    return;
  }

  if (table === 'pages') {
    const pageId = Number(obj.WikidotId);
    const siteId = Number(obj.SiteId);
    if (!Number.isFinite(pageId) || !Number.isFinite(siteId)) return;
    const name = String(obj.Name ?? '');
    const title = obj.Title == null ? null : String(obj.Title);
    const categoryId = numberOrNull(obj.CategoryId);
    const deleted = Number(obj.Deleted ?? 0) || 0;
    statements.page.run(pageId, siteId, name, title, categoryId, deleted, pageId, null);
    counters.pages++;
    return;
  }

  if (table === 'page_summary') {
    const pageId = Number(obj.PageId);
    if (!Number.isFinite(pageId)) return;
    statements.pageSummary.run(
      pageId,
      numberOrNull(obj.Rating),
      numberOrNull(obj.CleanRating),
      numberOrNull(obj.MonthRating),
      numberOrNull(obj.Revisions),
      numberOrNull(obj.ContributorRating),
      numberOrNull(obj.AdjustedRating),
      numberOrNull(obj.WilsonScore),
    );
    counters.pageSummary++;
    return;
  }

  if (table === 'page_status') {
    const pageId = Number(obj.PageId);
    if (!Number.isFinite(pageId)) return;
    statements.pageStatus.run(
      pageId,
      numberOrNull(obj.StatusId),
      numberOrNull(obj.OriginalId),
      numberOrNull(obj.Fixed),
      numberOrNull(obj.KindId),
    );
    counters.pageStatus++;
    return;
  }

  if (table === 'revisions') {
    const pageId = Number(obj.PageId);
    const revisionTime = normalizeDateTime(obj.DateTime);
    if (!Number.isFinite(pageId) || !revisionTime) return;
    statements.tempRevision.run(pageId, revisionTime);
    counters.revisions++;
    return;
  }


  if (table === 'tags') {
    const pageId = Number(obj.PageId);
    const rawTag = obj.Tag ?? obj.Name ?? obj.TagName ?? obj.Value ?? obj.Title;
    if (!Number.isFinite(pageId) || rawTag === null || rawTag === undefined) return;
    const tag = String(rawTag).trim().toLowerCase();
    if (!tag) return;
    statements.pageTag.run(pageId, tag);
    counters.tags = (counters.tags || 0) + 1;
    return;
  }

  if (table === 'votes' || table === 'vote_history') {
    const pageId = Number(obj.PageId);
    const userId = Number(obj.UserId);
    const value = Number(obj.Value ?? 0);
    const eventTime = normalizeDateTime(obj.DateTime);
    const sourceId = Number(obj.__Id ?? 0);
    if (!Number.isFinite(pageId) || !Number.isFinite(userId) || !eventTime) return;
    const sourceRank = table === 'vote_history' ? 0 : 1;
    statements.tempVote.run(
      pageId,
      userId,
      Number.isFinite(value) ? value : 0,
      eventTime,
      sourceRank,
      Number.isFinite(sourceId) ? sourceId : 0,
    );
    if (table === 'votes') counters.votes++;
    else counters.voteHistory++;
  }
}

function finalizeLookupDb(db, statements, inputPath, counters, progress) {
  emitProgress(progress, { phase: 'finalize', message: 'Applying page summary and status tables...' });
  db.exec(`
    UPDATE pages
    SET current_rating = (SELECT rating FROM temp_page_summary WHERE temp_page_summary.page_id = pages.page_id),
        current_clean_rating = (SELECT clean_rating FROM temp_page_summary WHERE temp_page_summary.page_id = pages.page_id),
        current_month_rating = (SELECT month_rating FROM temp_page_summary WHERE temp_page_summary.page_id = pages.page_id),
        current_revision_count = (SELECT revision_count FROM temp_page_summary WHERE temp_page_summary.page_id = pages.page_id),
        contributor_rating = (SELECT contributor_rating FROM temp_page_summary WHERE temp_page_summary.page_id = pages.page_id),
        adjusted_rating = (SELECT adjusted_rating FROM temp_page_summary WHERE temp_page_summary.page_id = pages.page_id),
        wilson_score = (SELECT wilson_score FROM temp_page_summary WHERE temp_page_summary.page_id = pages.page_id)
    WHERE EXISTS (SELECT 1 FROM temp_page_summary WHERE temp_page_summary.page_id = pages.page_id);

    UPDATE pages
    SET status_id = (SELECT status_id FROM temp_page_status WHERE temp_page_status.page_id = pages.page_id),
        original_id = (SELECT original_id FROM temp_page_status WHERE temp_page_status.page_id = pages.page_id),
        fixed = (SELECT fixed FROM temp_page_status WHERE temp_page_status.page_id = pages.page_id),
        kind_id = (SELECT kind_id FROM temp_page_status WHERE temp_page_status.page_id = pages.page_id)
    WHERE EXISTS (SELECT 1 FROM temp_page_status WHERE temp_page_status.page_id = pages.page_id);
  `);

  emitProgress(progress, { phase: 'finalize', message: 'Indexing imported revision events...' });
  db.exec(`
    CREATE INDEX idx_temp_revision_events_page_time
    ON temp_revision_events (page_id, revision_time);

    CREATE TEMP TABLE temp_revision_summary AS
    SELECT
      page_id,
      MIN(revision_time) AS creation_date,
      MAX(revision_time) AS last_revision_date,
      COUNT(*) AS revision_count
    FROM temp_revision_events
    GROUP BY page_id;

    CREATE INDEX idx_temp_revision_summary_page
    ON temp_revision_summary (page_id);

    UPDATE pages
    SET creation_date = (
          SELECT creation_date FROM temp_revision_summary WHERE temp_revision_summary.page_id = pages.page_id
        ),
        last_revision_date = (
          SELECT last_revision_date FROM temp_revision_summary WHERE temp_revision_summary.page_id = pages.page_id
        ),
        revision_count = COALESCE((
          SELECT revision_count FROM temp_revision_summary WHERE temp_revision_summary.page_id = pages.page_id
        ), 0);

    DROP TABLE IF EXISTS temp_revision_summary;
  `);

  emitProgress(progress, { phase: 'finalize', message: 'Indexing imported vote events...' });
  db.exec(`
    CREATE INDEX idx_temp_vote_events_page_user_time
    ON temp_vote_events (page_id, user_id, event_time, source_rank, source_id);
  `);

  emitProgress(progress, { phase: 'finalize', message: 'Building sanitized page-level rating events...' });
  db.exec(`
    INSERT INTO rating_events (
      page_id,
      event_time,
      rating_delta,
      positive_delta,
      negative_delta,
      nonzero_vote_delta
    )
    SELECT
      page_id,
      event_time,
      SUM(value - prev_value) AS rating_delta,
      SUM(CASE WHEN value > 0 THEN value ELSE 0 END - CASE WHEN prev_value > 0 THEN prev_value ELSE 0 END) AS positive_delta,
      SUM(CASE WHEN value < 0 THEN -value ELSE 0 END - CASE WHEN prev_value < 0 THEN -prev_value ELSE 0 END) AS negative_delta,
      SUM(CASE WHEN value <> 0 THEN 1 ELSE 0 END - CASE WHEN prev_value <> 0 THEN 1 ELSE 0 END) AS nonzero_vote_delta
    FROM (
      SELECT
        page_id,
        user_id,
        value,
        event_time,
        COALESCE(
          LAG(value) OVER (
            PARTITION BY page_id, user_id
            ORDER BY event_time, source_rank, source_id
          ),
          0
        ) AS prev_value
      FROM temp_vote_events
    ) ordered_events
    WHERE value <> prev_value
    GROUP BY page_id, event_time;

    CREATE INDEX idx_rating_events_page_time
    ON rating_events (page_id, event_time);

    CREATE INDEX idx_pages_site_name
    ON pages (site_id, name);

    CREATE INDEX idx_pages_site_rating
    ON pages (site_id, current_rating);

    CREATE INDEX idx_pages_site_creation
    ON pages (site_id, creation_date);

    CREATE INDEX idx_page_tags_tag_page
    ON page_tags (tag, page_id);

    CREATE INDEX idx_page_tags_page_tag
    ON page_tags (page_id, tag);
  `);

  emitProgress(progress, { phase: 'finalize', message: 'Filling page URLs, categories, and status labels...' });
  db.exec(`
    UPDATE pages
    SET url = (
      SELECT 'http://' || sites.wikidot_name || '.wikidot.com/' || pages.name
      FROM sites
      WHERE sites.site_id = pages.site_id
    );

    UPDATE pages
    SET category = (
      SELECT categories.name
      FROM categories
      WHERE categories.site_id = pages.site_id
        AND categories.category_id = pages.category_id
    );

    UPDATE pages
    SET status_name = (
      SELECT dict_status.name
      FROM dict_status
      WHERE dict_status.status_id = pages.status_id
    );

    UPDATE pages
    SET kind_name = (
      SELECT dict_page_kind.name
      FROM dict_page_kind
      WHERE dict_page_kind.kind_id = pages.kind_id
    );
  `);

  const pageCount = db.prepare('SELECT COUNT(*) AS count FROM pages').get().count;
  const siteCount = db.prepare('SELECT COUNT(*) AS count FROM sites').get().count;
  const eventCount = db.prepare('SELECT COUNT(*) AS count FROM rating_events').get().count;
  const revisionPageCount = db.prepare('SELECT COUNT(*) AS count FROM pages WHERE creation_date IS NOT NULL').get().count;
  const tagCount = db.prepare('SELECT COUNT(*) AS count FROM page_tags').get().count;

  statements.meta.run('source_dump', path.basename(inputPath));
  statements.meta.run('imported_at', new Date().toISOString());
  statements.meta.run('page_count', String(pageCount));
  statements.meta.run('site_count', String(siteCount));
  statements.meta.run('rating_event_count', String(eventCount));
  statements.meta.run('page_tag_count', String(tagCount));
  statements.meta.run('pages_with_creation_date', String(revisionPageCount));
  statements.meta.run('votes_rows_imported', String(counters.votes));
  statements.meta.run('vote_history_rows_imported', String(counters.voteHistory));
  statements.meta.run('revision_rows_imported', String(counters.revisions));

  emitProgress(progress, { phase: 'finalize', message: 'Dropping temporary raw vote/revision tables...' });
  db.exec(`
    DROP TABLE IF EXISTS temp_vote_events;
    DROP TABLE IF EXISTS temp_revision_events;
    DROP TABLE IF EXISTS temp_page_summary;
    DROP TABLE IF EXISTS temp_page_status;
  `);

  emitProgress(progress, { phase: 'finalize', message: 'Vacuuming sanitized database...' });
  db.exec(`VACUUM;`);

  return { pageCount, siteCount, eventCount, revisionPageCount };
}

export async function buildLookupDatabase({ inputPath, outputPath, progress }) {
  if (!inputPath) throw new Error('inputPath is required');
  if (!outputPath) throw new Error('outputPath is required');
  if (!fs.existsSync(inputPath)) throw new Error(`Dump file not found: ${inputPath}`);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tempOutputPath = `${outputPath}.building`;
  fs.rmSync(tempOutputPath, { force: true });

  emitProgress(progress, { phase: 'start', message: 'Creating SQLite lookup database...' });
  const db = new DatabaseSync(tempOutputPath);
  initLookupDb(db);
  const statements = prepareStatements(db);

  const counters = {
    statements: 0,
    rowsSeen: 0,
    sites: 0,
    categories: 0,
    dictStatus: 0,
    dictKind: 0,
    pages: 0,
    pageSummary: 0,
    pageStatus: 0,
    revisions: 0,
    tags: 0,
    votes: 0,
    voteHistory: 0,
  };

  const tableColumns = new Map();
  const stream = openPossiblyGzippedReadStream(inputPath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let statement = '';
  let lastProgress = Date.now();

  function parseSqlStatement(sqlStatement) {
    const trimmed = sqlStatement.trim();
    if (!trimmed) return;

    const createInfo = parseCreateColumns(trimmed);
    if (createInfo && REQUIRED_TABLES.has(createInfo.table)) {
      tableColumns.set(createInfo.table, createInfo.columns);
      return;
    }

    const insertInfo = parseInsertHeader(trimmed);
    if (!insertInfo || !REQUIRED_TABLES.has(insertInfo.table)) return;

    const columns = insertInfo.columns ?? tableColumns.get(insertInfo.table);
    if (!columns || columns.length === 0) {
      throw new Error(`Column order for ${insertInfo.table} is unknown. Cannot parse INSERT safely.`);
    }

    for (const row of parseValueTuples(insertInfo.valuesSql)) {
      const obj = rowObject(columns, row);
      handleRow(insertInfo.table, obj, statements, counters);
    }
  }

  try {
    db.exec('BEGIN IMMEDIATE;');
    for await (const line of rl) {
      if (!statement && (line.startsWith('--') || line.startsWith('/*') || line.trim() === '')) continue;

      statement += line;
      statement += '\n';

      if (/;\s*$/.test(line)) {
        counters.statements++;
        parseSqlStatement(statement);
        statement = '';

        if (counters.statements % 100 === 0) db.exec('COMMIT; BEGIN IMMEDIATE;');

        const now = Date.now();
        if (now - lastProgress > 1000) {
          lastProgress = now;
          emitProgress(progress, {
            phase: 'parse',
            message: `Parsed ${counters.statements.toLocaleString()} SQL statements; imported ${counters.pages.toLocaleString()} pages, ${counters.revisions.toLocaleString()} revisions, ${counters.votes.toLocaleString()} votes...`,
            counters,
          });
        }
      }
    }

    if (statement.trim()) parseSqlStatement(statement);
    db.exec('COMMIT;');

    emitProgress(progress, { phase: 'parse', message: 'Finished reading dump.', counters });
    const summary = finalizeLookupDb(db, statements, inputPath, counters, progress);
    db.close();

    fs.rmSync(outputPath, { force: true });
    fs.renameSync(tempOutputPath, outputPath);

    emitProgress(progress, { phase: 'done', message: 'Import complete.', counters, summary });
    return { counters, summary, outputPath };
  } catch (error) {
    try { db.exec('ROLLBACK;'); } catch {}
    try { db.close(); } catch {}
    fs.rmSync(tempOutputPath, { force: true });
    throw error;
  }
}
