import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildLookupDatabase } from './importer.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scpper-rating-test-'));
const dumpPath = path.join(dir, 'sample.sql');
const dbPath = path.join(dir, 'sample.db');

fs.writeFileSync(dumpPath, `
CREATE TABLE \`sites\` (
  \`__Id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`WikidotId\` int NOT NULL,
  \`WikidotName\` varchar(45) NOT NULL,
  \`ShortName\` varchar(10) NOT NULL,
  \`LastUpdate\` datetime DEFAULT NULL,
  \`HideVotes\` tinyint(1) DEFAULT NULL
);
INSERT INTO \`sites\` VALUES (1,66711,'scp-wiki','en','2026-03-24 16:00:08',0);

CREATE TABLE \`categories\` (
  \`__Id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`WikidotId\` int NOT NULL,
  \`Name\` varchar(100) NOT NULL,
  \`SiteId\` int NOT NULL,
  \`Ignored\` tinyint(1) DEFAULT '0'
);
INSERT INTO \`categories\` VALUES (1,123,'scp',66711,0);

CREATE TABLE \`dict_status\` (
  \`__Id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`StatusId\` int NOT NULL,
  \`Name\` varchar(45) NOT NULL
);
INSERT INTO \`dict_status\` VALUES (1,1,'ok');

CREATE TABLE \`dict_page_kind\` (
  \`__Id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`KindId\` int NOT NULL,
  \`Description\` varchar(100) DEFAULT NULL
);
INSERT INTO \`dict_page_kind\` VALUES (1,1,'article');

CREATE TABLE \`pages\` (
  \`__Id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`SiteId\` int NOT NULL,
  \`WikidotId\` int NOT NULL,
  \`Title\` varchar(500) DEFAULT NULL,
  \`Name\` varchar(256) NOT NULL,
  \`CategoryId\` int DEFAULT NULL,
  \`Source\` mediumtext,
  \`AltTitle\` varchar(500) DEFAULT NULL,
  \`Deleted\` tinyint(1) NOT NULL DEFAULT '0',
  \`LastUpdate\` datetime DEFAULT NULL,
  \`HideSource\` tinyint(1) NOT NULL DEFAULT '0'
);
INSERT INTO \`pages\` VALUES (1,66711,1956234,'SCP-173','scp-173',123,NULL,NULL,0,'2026-03-24 16:00:08',0);

CREATE TABLE \`page_status\` (
  \`__Id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`PageId\` int NOT NULL,
  \`StatusId\` int DEFAULT '1',
  \`OriginalId\` int DEFAULT NULL,
  \`Fixed\` tinyint(1) DEFAULT NULL,
  \`KindId\` int DEFAULT NULL
);
INSERT INTO \`page_status\` VALUES (1,1956234,1,NULL,NULL,1);

CREATE TABLE \`page_summary\` (
  \`__Id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`PageId\` int NOT NULL,
  \`Rating\` int DEFAULT NULL,
  \`CleanRating\` int DEFAULT NULL,
  \`Revisions\` int DEFAULT NULL,
  \`ContributorRating\` int DEFAULT NULL,
  \`AdjustedRating\` int DEFAULT NULL,
  \`WilsonScore\` double DEFAULT NULL,
  \`MonthRating\` int DEFAULT NULL
);
INSERT INTO \`page_summary\` VALUES (1,1956234,1,1,2,1,1,1.0,1);

CREATE TABLE \`revisions\` (
  \`__Id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`WikidotId\` int NOT NULL,
  \`PageId\` int NOT NULL,
  \`RevisionIndex\` int unsigned NOT NULL,
  \`UserId\` int NOT NULL,
  \`DateTime\` datetime NOT NULL,
  \`Comments\` varchar(512) DEFAULT NULL
);
INSERT INTO \`revisions\` VALUES (1,1,1956234,1,100,'2018-12-31 11:00:00','created'),(2,2,1956234,2,101,'2019-01-15 11:00:00','edit');

CREATE TABLE \`votes\` (
  \`__Id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`PageId\` int NOT NULL,
  \`UserId\` int NOT NULL,
  \`Value\` tinyint(1) DEFAULT NULL,
  \`DateTime\` datetime DEFAULT NULL,
  \`DeltaFromPrev\` tinyint(1) DEFAULT NULL
);
INSERT INTO \`votes\` VALUES (10,1956234,100,1,'2019-01-01 10:00:00',1),(11,1956234,101,-1,'2019-01-10 10:00:00',-1),(12,1956234,102,1,'2019-03-01 10:00:00',1);

CREATE TABLE \`vote_history\` (
  \`__Id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`PageId\` int NOT NULL,
  \`UserId\` int NOT NULL,
  \`Value\` tinyint(1) DEFAULT NULL,
  \`DateTime\` datetime DEFAULT NULL,
  \`DeltaFromPrev\` tinyint(1) DEFAULT NULL
);
INSERT INTO \`vote_history\` VALUES (1,1956234,101,1,'2019-01-02 10:00:00',1);
`);

await buildLookupDatabase({ inputPath: dumpPath, outputPath: dbPath, progress: () => {} });
const db = new DatabaseSync(dbPath);

const before = db.prepare(`
  SELECT COALESCE(SUM(rating_delta), 0) AS rating
  FROM rating_events
  WHERE page_id = 1956234 AND event_time <= '2019-01-05 23:59:59'
`).get().rating;
const after = db.prepare(`
  SELECT COALESCE(SUM(rating_delta), 0) AS rating
  FROM rating_events
  WHERE page_id = 1956234 AND event_time <= '2019-02-01 23:59:59'
`).get().rating;
const later = db.prepare(`
  SELECT COALESCE(SUM(rating_delta), 0) AS rating
  FROM rating_events
  WHERE page_id = 1956234 AND event_time <= '2019-04-01 23:59:59'
`).get().rating;
const page = db.prepare(`
  SELECT creation_date, last_revision_date, revision_count, category, status_name, kind_name
  FROM pages
  WHERE page_id = 1956234
`).get();

db.close();

if (before !== 2 || after !== 0 || later !== 1) {
  throw new Error(`Self-test failed. Expected 2,0,1; got ${before},${after},${later}`);
}
if (page.creation_date !== '2018-12-31 11:00:00' || page.last_revision_date !== '2019-01-15 11:00:00' || page.revision_count !== 2) {
  throw new Error(`Self-test failed for revision fields: ${JSON.stringify(page)}`);
}
if (page.category !== 'scp' || page.status_name !== 'ok' || page.kind_name !== 'article') {
  throw new Error(`Self-test failed for labels: ${JSON.stringify(page)}`);
}

console.log('Self-test passed.');
console.log(`Temporary files: ${dir}`);
