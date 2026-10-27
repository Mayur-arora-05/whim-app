// Whim · spots backup (READ-ONLY)
// The free Supabase tier has no backups, and the curated `spots` catalogue
// (anchors + their `nearby` micro-activities, coords, place_ids) is expensive
// to regenerate. This exports every row to a dated JSON file and verifies it.
// Run it before every seed batch / migration, and before launch.
//
// Output goes OUTSIDE the repo (the repo is public — the catalogue is our moat):
//   default ~/whim-backups/spots-<timestamp>.json  (override with BACKUP_DIR)
// plus a .sha256 checksum next to it.
//
// Only SELECTs. Never writes to the database.
// USAGE: node --env-file=.env.seed scripts/backup-spots.mjs

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing env. Need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const PAGE = 1000; // PostgREST caps responses; page through in stable id order
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const { count: liveCount, error: countErr } = await supabase.from('spots').select('id', { count: 'exact', head: true });
if (countErr) throw countErr;

const rows = [];
for (let from = 0; ; from += PAGE) {
  const { data, error } = await supabase.from('spots').select('*').order('id').range(from, from + PAGE - 1);
  if (error) throw error;
  rows.push(...data);
  if (data.length < PAGE) break;
}

const perCity = {};
for (const r of rows) perCity[r.city] = (perCity[r.city] ?? 0) + 1;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = process.env.BACKUP_DIR ?? join(homedir(), 'whim-backups');
mkdirSync(dir, { recursive: true });
const file = join(dir, `spots-${stamp}.json`);
const body = JSON.stringify(
  { table: 'spots', project: new URL(SUPABASE_URL).host, exported_at: new Date().toISOString(), row_count: rows.length, per_city: perCity, rows },
  null,
  1,
);
writeFileSync(file, body);
const sha = createHash('sha256').update(body).digest('hex');
writeFileSync(`${file}.sha256`, `${sha}  spots-${stamp}.json\n`);

// verify: re-read from disk, compare with the live table
const back = JSON.parse(readFileSync(file, 'utf8'));
const ids = new Set(back.rows.map((r) => r.id));
const problems = [];
if (back.rows.length !== liveCount) problems.push(`rows ${back.rows.length} ≠ live ${liveCount}`);
if (ids.size !== back.rows.length) problems.push(`duplicate ids (${back.rows.length - ids.size})`);
if (back.rows.some((r) => r.lat == null || r.lng == null)) problems.push(`${back.rows.filter((r) => r.lat == null).length} rows without coords (informational)`);

console.log(`Backed up ${back.rows.length} spots across ${Object.keys(perCity).length} cities`);
console.log(`→ ${file} (${(body.length / 1e6).toFixed(1)} MB)`);
console.log(`sha256 ${sha}`);
console.log(problems.length ? `CHECK: ${problems.join('; ')}` : 'Verified: row count matches live table, ids unique.');
if (back.rows.length !== liveCount || ids.size !== back.rows.length) process.exit(2);
