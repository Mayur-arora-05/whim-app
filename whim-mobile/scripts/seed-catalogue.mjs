/* eslint-env node */
// Whim · catalogue balancer
// Evens out the city catalogue so every picker city has comparable decks and
// sub-places. Two passes, both idempotent and additive:
//
//   --decks    any city×vibe with fewer than MIN places gets topped up to TARGET
//              via seed-city's top-up mode (adds new places only; existing rows
//              are never touched).
//   --nearby   every place with no sub-places gets 3–5 via seed-nearby
//              (hand-curated sub-places are kept).
//   --backfill hand-curated sub-places get a Google place_id (photo in the app);
//              nothing else about them changes.
//
// USAGE: node --env-file=.env.seed scripts/seed-catalogue.mjs --decks|--nearby|--backfill [--dry] [--city=Oslo]
// Back up first: node --env-file=.env.seed scripts/backup-spots.mjs

import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing env. Need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const ONLY = args.find((a) => a.startsWith('--city='))?.slice(7);
// second pass for small cities: widen the search and relax the review bar
const RADIUS = Number(args.find((a) => a.startsWith('--radius='))?.slice(9)) || undefined;
const MIN_RATINGS = Number(args.find((a) => a.startsWith('--min-ratings='))?.slice(14)) || undefined;
const VIBES = ['classics', 'matcha', 'nature', 'nightlife'];
const MIN = 10;
const TARGET = 12;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// picker cities (name + centre) straight from the app's list
const CITIES = [...fs.readFileSync(new URL('../data/cities.ts', import.meta.url), 'utf8')
  .matchAll(/name: '([^']+)'[^}]*?lat: (-?[\d.]+), lng: (-?[\d.]+)/g)]
  .map(([, name, lat, lng]) => ({ name, lat: Number(lat), lng: Number(lng) }))
  .filter((c) => !ONLY || c.name === ONLY);

async function allSpots() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('spots').select('id, city, vibes, nearby, lat').range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

async function call(fn, body) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-seed-secret': SERVICE_KEY },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, ...JSON.parse(text) }; } catch { return { status: res.status, raw: text.slice(0, 200) }; }
}

async function decks() {
  const rows = await allSpots();
  for (const c of CITIES) {
    const deck = rows.filter((r) => r.city === c.name);
    for (const v of VIBES) {
      const have = deck.filter((r) => (r.vibes ?? []).includes(v)).length;
      if (have >= MIN) continue;
      const need = TARGET - have;
      // small cities rarely have 60+ reviews on every café — relax the bar there
      const minRatings = MIN_RATINGS ?? (deck.length < 35 ? 25 : 60);
      if (DRY) { console.log(`plan  ${c.name.padEnd(14)} ${v.padEnd(9)} ${have} → +${need}`); continue; }
      const r = await call('seed-city', { city: c.name, lat: c.lat, lng: c.lng, vibes: [v], onlyNew: true, perVibe: need, minRatings, ...(RADIUS ? { radius: RADIUS } : {}) });
      console.log(`${c.name.padEnd(14)} ${v.padEnd(9)} ${have} → +${r.inserted ?? 0}`, r.error ?? r.note ?? r.raw ?? '', r.enrichErr?.length ? r.enrichErr : '');
    }
  }
}

async function nearby() {
  const rows = await allSpots();
  const names = new Set(CITIES.map((c) => c.name));
  const todo = rows.filter((r) => names.has(r.city) && r.lat != null && !(r.nearby ?? []).length);
  console.log(`${todo.length} places without sub-places${DRY ? ' (dry run)' : ''}`);
  if (DRY) {
    const by = {};
    for (const r of todo) by[r.city] = (by[r.city] ?? 0) + 1;
    console.log(by);
    return;
  }
  let updated = 0, empty = 0;
  for (let i = 0; i < todo.length; i += 40) {
    const r = await call('seed-nearby', { ids: todo.slice(i, i + 40).map((x) => x.id), limit: 40 });
    updated += r.updated ?? 0; empty += r.empty ?? 0;
    console.log(`batch ${i / 40 + 1}/${Math.ceil(todo.length / 40)}: +${r.updated ?? 0} (empty ${r.empty ?? 0})`, r.errors?.length ? r.errors : '', r.error ?? r.raw ?? '');
  }
  console.log(`done: ${updated} places got sub-places, ${empty} had too little nearby`);
}

async function backfill() {
  const rows = await allSpots();
  const names = new Set(CITIES.map((c) => c.name));
  const todo = rows.filter((r) => names.has(r.city) && (r.nearby ?? []).some((n) => !n.placeId));
  const items = todo.reduce((t, r) => t + r.nearby.filter((n) => !n.placeId).length, 0);
  console.log(`${todo.length} places with ${items} sub-places lacking a place_id${DRY ? ' (dry run)' : ''}`);
  if (DRY) return;
  let matched = 0, missed = 0;
  for (let i = 0; i < todo.length; i += 40) {
    const r = await call('seed-nearby', { ids: todo.slice(i, i + 40).map((x) => x.id), limit: 40, backfill: true });
    matched += r.matched ?? 0; missed += r.missed ?? 0;
    console.log(`batch ${i / 40 + 1}/${Math.ceil(todo.length / 40)}: matched ${r.matched ?? 0}, missed ${r.missed ?? 0}`, r.errors?.length ? r.errors : '', r.error ?? r.raw ?? '');
  }
  console.log(`done: ${matched} matched, ${missed} not found`);
}

if (args.includes('--decks')) await decks();
else if (args.includes('--nearby')) await nearby();
else if (args.includes('--backfill')) await backfill();
else console.log('pass --decks, --nearby or --backfill (optionally --dry, --city=Name)');
