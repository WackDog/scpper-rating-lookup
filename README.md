# SCPper Rating Lookup

Local Node.js tool for importing an SCPper `.sql` / `.sql.gz` dump and looking up an article's rating on a specific historical date. 

This app runs on your own computer and opens a local browser UI at:

```text
http://127.0.0.1:3000
```

## What this tool does

Given:

- site code, for example `en`
- page slug, for example `scp-173`
- date, for example `2019-02-01`

it returns the article's reconstructed rating as of the end of that date. The tool imports an SCPper dump and builds a local SQLite lookup database. The generated database is stored locally under `data/`.

## Requirements

Install:

- Node.js 24+
- npm, included with Node.js

Check your versions:

```bash
node -v
npm -v
```

You should see Node `v24.x.x` or newer.

Docker and MySQL are not required for this version.

---

# Normal setup: Download ZIP

Use this if you just want to run the tool and do not care about git.

1. Open the GitHub repository in your browser.
2. Click **Code**.
3. Click **Download ZIP**.
4. Extract the ZIP somewhere normal, for example:

```text
C:\Users\YOUR_NAME\Desktop\scpper-rating-lookup
```

5. Open the extracted folder.
6. Open a terminal in that folder.

On Windows, you can do this by clicking the address bar in File Explorer, typing:

```text
cmd
```

and pressing Enter.

7. Install dependencies:

```bash
npm install
```

8. Start the app:

```bash
npm start
```

9. Open this in your browser if it does not open automatically:

```text
http://127.0.0.1:3000
```

To stop the app, press `Ctrl+C` in the terminal.

---

# Developer setup: git clone

Use this only if you know git and want to update the tool using `git pull`.

```bash
git clone https://github.com/OWNER/scpper-rating-lookup.git
cd scpper-rating-lookup
npm install
npm start
```

Replace `OWNER/scpper-rating-lookup` with the actual private repo path.

---

# Importing an SCPper dump

You need an SCPper `.sql` or `.sql.gz` dump file.

In the app, go to:

```text
Import a new SCPper dump
```

There are two import options.

## Option A: Import from path — recommended for large dumps

Use this if the dump is already on your computer.

Example Windows path:

```text
C:\Users\YOUR_NAME\Downloads\scpper_2026-06-07.sql.gz
```

Paste the path into the **Dump path** box and click:

```text
Import from path
```

This is usually faster and more reliable for large dumps.

## Option B: Upload through browser

Use this if you want to select the dump file with a file picker.

Click:

```text
Upload dump file
```

Choose the `.sql` or `.sql.gz` file, then click:

```text
Upload and import
```

For very large dumps, path import is preferred.

## During import

Leave the terminal open while import is running.

The app will parse the dump and build a local SQLite lookup database.

Depending on the size of the dump, this may take a while.

If import fails, copy the error message from the terminal or browser and send it to the maintainer.

---

# Looking up a rating

After import, use the lookup section.

Example:

```text
Site: en
Page: scp-173
Date: 2019-02-01
```

Notes:

- For the English SCP Wiki, use site code `en`.
- Use the page slug, not the page title.
- Example: use `scp-173`, not `SCP-173`.
- The result is calculated as of the end of the selected date, `23:59:59`.


---

# Reports

After importing a dump, open the **Reports** section. Reports return page-level aggregate data only; they do not expose individual votes or users.

Available reports:

## Current threshold report

Find pages at or below a chosen current rating.

Useful for deletion-threshold or risk-review work.

Inputs:

```text
Site: en
Max rating: 0
Limit: 100
Include deleted pages: optional
```

## Top / bottom current pages

List the highest-rated or lowest-rated current pages for a site.

Inputs:

```text
Site: en
Direction: Highest rating first / Lowest rating first
Limit: 100
Include deleted pages: optional
```

## Article rating trajectory

Calculate one article's rating at monthly intervals between two dates.

Inputs:

```text
Site: en
Page slug: scp-173
Start date: 2019-01-01
End date: 2020-01-01
```

## Monthly page creation

Summarize how many pages were created per month, including current rating and deletion outcomes.

This uses the first revision timestamp as the estimated creation date.

Inputs:

```text
Site: en
Start date: 2019-01-01
End date: 2020-01-01
```

## Contest / date-window pages

List pages created during a chosen date window, sorted by current rating.

Useful for contest analysis.

Inputs:

```text
Site: en
Start date: 2019-01-01
End date: 2019-02-01
Limit: 500
Include deleted pages: optional
```

## Site / branch summary

Compare page counts, deletion counts, current average ratings, and creation-date ranges across SCP branches.

No inputs are required.

## Downloading report data

After running a report, click **Download CSV** to save the result table.

---

# Generated local files

When you import a dump, the app creates local data files under:

```text
data/
```

These files are generated locally and are ignored by git.

Do not commit:

- SCPper `.sql` files
- SCPper `.sql.gz` files
- generated `.db` / `.sqlite` files
- raw vote exports
- `node_modules`

---

# GitHub safety

This repository should contain only the tool source code.

The SCPper dump should be shared separately through approved staff channels, not committed to GitHub.

Before committing, check:

```bash
git status
```

Also check for accidental dump/database files:

```bash
find . -type f \( -name "*.sql" -o -name "*.sql.gz" -o -name "*.db" -o -name "*.sqlite" -o -name "*.sqlite3" \)
```

That command should print nothing before you push.

If you accidentally imported a dump before committing, remove generated data:

```bash
rm -rf data
```

Then check again with the `find` command above.

---

# How the rating is calculated

From inspection of the SCPper database:

- `votes` contains one current/latest vote row per page/user.
- `vote_history` contains timestamped previous vote states.
- `votes.PageId` joins to `pages.WikidotId`.
- current page rating is exactly `SUM(votes.Value)`.

The importer creates a page-level event stream by ordering each page/user vote timeline and storing only the change in page rating at each timestamp.

For example:

```text
0 → +1   rating_delta = +1
+1 → -1  rating_delta = -2
-1 → 0   rating_delta = +1
```

The lookup query returns:

```sql
SUM(rating_delta) WHERE event_time <= selected_date
```

---

# Troubleshooting

## `npm install` fails

Try:

```bash
rm -rf node_modules package-lock.json
npm cache clean --force
npm install
```

## App starts but browser does not open

Open this manually:

```text
http://127.0.0.1:3000
```

## Import is slow

Use **Import from path** instead of browser upload.

## I closed the terminal during import

Start the app again and re-import the dump. The previous generated database may be incomplete.

## The app says no DB is imported

Import a dump first, or check that `data/scpper-ratings.db` exists.
