// READ-ONLY: list open user reports so we keep the in-app promise
// ("we review reports within 24 hours") — App Store Guideline 1.2.
//
// USAGE: node --env-file=.env.seed scripts/review-reports.mjs [days=7]
//
// Prints guide, community-spot and room-member reports from the last N days
// with the reported content, so you can decide what to remove. It never
// writes. To act on a report, see HANDOFF.md → "Moderation runbook".

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing env. Need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const days = Number(process.argv[2] ?? 7);
const since = new Date(Date.now() - days * 864e5).toISOString();

async function reports(table, idCol) {
  const { data, error } = await db.from(table).select(`*`).gte('created_at', since).order('created_at', { ascending: false });
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data ?? []).map((r) => ({ ...r, target: r[idCol] }));
}

async function byIds(table, cols, ids) {
  if (!ids.length) return new Map();
  const { data, error } = await db.from(table).select(cols).in('id', [...new Set(ids)]);
  if (error) throw new Error(`${table}: ${error.message}`);
  return new Map((data ?? []).map((r) => [r.id, r]));
}

const guides = await reports('itinerary_reports', 'itinerary_id');
const spots = await reports('community_reports', 'spot_id');
const members = await reports('room_reports', 'reported_user_id');

const guideRows = await byIds('published_itineraries', 'id, title, note, author, author_name, status', guides.map((r) => r.target));
const spotRows = await byIds('community_spots', 'id, title, blurb, submitted_by, status', spots.map((r) => r.target));
const people = await byIds('profiles', 'id, display_name, username', members.map((r) => r.target));

console.log(`Reports in the last ${days} day(s): ${guides.length} guide, ${spots.length} spot, ${members.length} room member\n`);
for (const r of guides) {
  const g = guideRows.get(r.target);
  console.log(`[guide] ${r.created_at}  ${r.reason}\n  id=${r.target}  status=${g?.status ?? 'deleted'}  by ${g?.author_name ?? '?'} (${g?.author ?? '?'})\n  "${g?.title ?? ''}"  ${g?.note ? `— ${g.note}` : ''}\n`);
}
for (const r of spots) {
  const s = spotRows.get(r.target);
  console.log(`[spot] ${r.created_at}  ${r.reason}\n  id=${r.target}  status=${s?.status ?? 'deleted'}  by ${s?.submitted_by ?? '?'}\n  "${s?.title ?? ''}" — ${s?.blurb ?? ''}\n`);
}
for (const r of members) {
  const p = people.get(r.target);
  console.log(`[room member] ${r.created_at}  ${r.reason}\n  user=${r.target}  name="${p?.display_name ?? ''}" @${p?.username ?? ''}  room=${r.room_id}\n`);
}
