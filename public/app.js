const statusEl = document.getElementById('status');
const importLog = document.getElementById('import-log');
const resultEl = document.getElementById('result');
const siteSelect = document.getElementById('site');
const reportSiteSelect = document.getElementById('report-site');
const reportResultEl = document.getElementById('report-result');

let lastReportRows = [];

async function getJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderTable(rows) {
  lastReportRows = rows || [];
  if (!lastReportRows.length) {
    reportResultEl.innerHTML = '<p class="muted">No rows returned.</p>';
    return;
  }

  const columns = Object.keys(lastReportRows[0]);
  reportResultEl.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr>${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
        <tbody>
          ${lastReportRows.map((row) => `
            <tr>${columns.map((c) => `<td>${escapeHtml(row[c])}</td>`).join('')}</tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function rowsToCsv(rows) {
  if (!rows.length) return '';
  const columns = Object.keys(rows[0]);
  const escape = (value) => {
    const s = String(value ?? '');
    if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
    return s;
  };
  return [columns.join(','), ...rows.map((row) => columns.map((c) => escape(row[c])).join(','))].join('\n');
}

function downloadCsv(filename, rows) {
  const csv = rowsToCsv(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function refreshStatus() {
  try {
    const status = await getJson('/api/status');
    if (!status.ready) {
      statusEl.textContent = `No lookup database imported yet. Expected path: ${status.dbPath}`;
      return;
    }

    statusEl.innerHTML = `
      <strong>Ready.</strong><br>
      DB: <code>${escapeHtml(status.dbPath)}</code><br>
      Source dump: <code>${escapeHtml(status.metadata.source_dump || 'unknown')}</code><br>
      Imported at: <code>${escapeHtml(status.metadata.imported_at || 'unknown')}</code><br>
      Pages: <code>${escapeHtml(status.metadata.page_count || '?')}</code><br>
      Sites: <code>${escapeHtml(status.metadata.site_count || '?')}</code><br>
      Rating events: <code>${escapeHtml(status.metadata.rating_event_count || '?')}</code><br>
      Pages with creation dates: <code>${escapeHtml(status.metadata.pages_with_creation_date || '?')}</code>
    `;
    await refreshSites();
  } catch (error) {
    statusEl.textContent = error.message;
  }
}

async function refreshSites() {
  const sites = await getJson('/api/sites');
  if (!sites.length) return;
  for (const select of [siteSelect, reportSiteSelect]) {
    select.innerHTML = '';
    for (const site of sites) {
      const option = document.createElement('option');
      option.value = site.short_name;
      option.textContent = `${site.short_name} — ${site.wikidot_name}`;
      select.appendChild(option);
    }
    if ([...select.options].some((o) => o.value === 'en')) select.value = 'en';
  }
}

async function pollJob(jobId) {
  while (true) {
    const job = await getJson(`/api/import/${encodeURIComponent(jobId)}`);
    importLog.textContent = [
      `Status: ${job.status}`,
      `Started: ${job.startedAt}`,
      `Updated: ${job.updatedAt}`,
      '',
      ...job.messages.slice(-20),
    ].join('\n');

    if (job.status === 'done') {
      await refreshStatus();
      return;
    }
    if (job.status === 'error') return;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

document.getElementById('refresh-status').addEventListener('click', refreshStatus);

document.getElementById('import-path').addEventListener('click', async () => {
  try {
    const dumpPath = document.getElementById('dump-path').value.trim();
    importLog.textContent = 'Starting import...';
    const { jobId } = await getJson('/api/import-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dumpPath }),
    });
    await pollJob(jobId);
  } catch (error) {
    importLog.textContent = error.message;
  }
});

document.getElementById('import-upload').addEventListener('click', async () => {
  try {
    const file = document.getElementById('dump-file').files[0];
    if (!file) throw new Error('Choose a dump file first.');
    const form = new FormData();
    form.append('dump', file);
    importLog.textContent = 'Uploading dump. This may take a while for large files...';
    const { jobId } = await getJson('/api/import-upload', { method: 'POST', body: form });
    await pollJob(jobId);
  } catch (error) {
    importLog.textContent = error.message;
  }
});

document.getElementById('lookup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    resultEl.textContent = 'Looking up...';
    const params = new URLSearchParams({
      site: siteSelect.value,
      page: document.getElementById('page').value.trim(),
      date: document.getElementById('date').value,
    });
    const row = await getJson(`/api/rating?${params}`);
    resultEl.textContent = [
      `Title: ${row.title || '(untitled)'}`,
      `URL: ${row.url}`,
      `Page ID: ${row.page_id}`,
      `Site: ${row.site}`,
      `As of: ${row.as_of}`,
      '',
      `Rating as of date: ${row.rating_as_of}`,
      `Positive value as of date: ${row.positive_value_as_of}`,
      `Negative value as of date: ${row.negative_value_as_of}`,
      `Non-zero vote count as of date: ${row.nonzero_vote_count_as_of}`,
      '',
      `Current rating in imported dump: ${row.current_rating}`,
      `Deleted in imported dump: ${row.deleted ? 'yes' : 'no'}`,
    ].join('\n');
  } catch (error) {
    resultEl.textContent = error.message;
  }
});

document.getElementById('search-pages').addEventListener('click', async () => {
  const container = document.getElementById('search-results');
  try {
    container.textContent = 'Searching...';
    const params = new URLSearchParams({
      site: siteSelect.value,
      q: document.getElementById('search-query').value.trim(),
    });
    const rows = await getJson(`/api/search-pages?${params}`);
    if (!rows.length) {
      container.textContent = 'No matches.';
      return;
    }
    container.innerHTML = '';
    for (const row of rows) {
      const div = document.createElement('div');
      div.className = 'search-result';
      div.innerHTML = `
        <strong>${escapeHtml(row.name)}</strong> — ${escapeHtml(row.title || '(untitled)')}<br>
        <span class="muted">Current rating: ${escapeHtml(row.current_rating ?? 'unknown')} | ${escapeHtml(row.url)}</span><br>
        <button type="button">Use this slug</button>
      `;
      div.querySelector('button').addEventListener('click', () => {
        document.getElementById('page').value = row.name;
        document.getElementById('report-page').value = row.name;
      });
      container.appendChild(div);
    }
  } catch (error) {
    container.textContent = error.message;
  }
});

document.getElementById('report-type').addEventListener('change', () => {
  const type = document.getElementById('report-type').value;
  for (const el of document.querySelectorAll('[data-report-field]')) {
    const reports = el.dataset.reportField.split(',');
    el.hidden = !reports.includes(type);
  }
  reportResultEl.innerHTML = '<p class="muted">No report run yet.</p>';
  lastReportRows = [];
});

document.getElementById('run-report').addEventListener('click', async () => {
  try {
    reportResultEl.textContent = 'Running report...';
    const type = document.getElementById('report-type').value;
    const site = reportSiteSelect.value;
    const includeDeleted = document.getElementById('report-include-deleted').checked;
    const limit = document.getElementById('report-limit').value || '100';
    let endpoint;
    let params = new URLSearchParams({ site, includeDeleted: String(includeDeleted), limit });

    if (type === 'threshold') {
      endpoint = '/api/reports/threshold';
      params.set('maxRating', document.getElementById('report-max-rating').value || '0');
    } else if (type === 'top-pages') {
      endpoint = '/api/reports/top-pages';
      params.set('direction', document.getElementById('report-direction').value);
    } else if (type === 'trajectory') {
      endpoint = '/api/reports/trajectory';
      params = new URLSearchParams({
        site,
        page: document.getElementById('report-page').value.trim(),
        start: document.getElementById('report-start').value,
        end: document.getElementById('report-end').value,
      });
    } else if (type === 'monthly-creation') {
      endpoint = '/api/reports/monthly-creation';
      params = new URLSearchParams({ site, start: document.getElementById('report-start').value, end: document.getElementById('report-end').value });
    } else if (type === 'contest-window') {
      endpoint = '/api/reports/contest-window';
      params = new URLSearchParams({ site, start: document.getElementById('report-start').value, end: document.getElementById('report-end').value, includeDeleted: String(includeDeleted), limit });
    } else if (type === 'site-summary') {
      endpoint = '/api/reports/site-summary';
      params = new URLSearchParams();
    } else {
      throw new Error('Unknown report type.');
    }

    const data = await getJson(`${endpoint}?${params}`);
    renderTable(data.rows || []);
  } catch (error) {
    reportResultEl.textContent = error.message;
  }
});

document.getElementById('download-report').addEventListener('click', () => {
  if (!lastReportRows.length) return;
  const type = document.getElementById('report-type').value;
  downloadCsv(`${type}-report.csv`, lastReportRows);
});

document.getElementById('report-type').dispatchEvent(new Event('change'));
refreshStatus();
