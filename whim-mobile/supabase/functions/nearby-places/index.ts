// Edge Function: nearby-places
// Live "Near me" discovery via Google Places API (New) + a Claude enrichment
// pass that makes the results feel curated instead of generic:
//   1. per-vibe Text Search + a broad nearby sweep → characterful candidates
//   2. real review snippets (Place Details) fetched for the top candidates
//   3. ONE batched Claude call grounds an evocative blurb on the editorial note +
//      reviews, assigns the best vibe, adds tags + an insider tip, dedupes
//      near-identical spots, and drops the generic ones
//   4. ranking = model score × distance decay × time-of-day boost, so nearer &
//      time-appropriate spots lead; backfill keeps each vibe populated
//   5. graceful fallback to a deterministic type→vibe map if the LLM or a query
//      fails, so "Near me" never breaks
//
// LEGAL: Google Places content is returned LIVE and only the place_id is
// retained long-term. Blurbs are model-generated (ours). The 1-hour grid cache
// holds display fields for performance only. This never writes to `spots`.
//
// Deploy: supabase functions deploy nearby-places
// Secrets: GOOGLE_PLACES_API_KEY, ANTHROPIC_API_KEY

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { maybePurgeCaches, underDailyCap, underGlobalDailyCap } from '../_shared/guard.ts';

const DAILY_CAP = 200; // per-user Places+LLM searches per UTC day
const GLOBAL_CAP = 6000; // all-users LLM-enrichment ceiling per day (bill brake)
const ONE_HOUR_MS = 60 * 60 * 1000;
const MIN_RATINGS = 5; // low bar — great small local spots have few reviews
const MIN_PER_VIBE = 5; // backfill target so a vibe is never near-empty
const PER_VIBE_CAP = 12; // spots returned per vibe
const DETAIL_TOP = 12; // fetch real reviews (Place Details, billed) for the top-N to ground blurbs
const ENRICH_CHUNK = 12; // places per parallel LLM call
const ENRICH_TIMEOUT_MS = 15_000; // per chunk; a slow chunk falls back instead of stalling the screen

// Supabase Edge Runtime global: keeps the worker alive for post-response work.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

type Vibe = 'classics' | 'matcha' | 'nature' | 'nightlife';
const VIBES: Vibe[] = ['classics', 'matcha', 'nature', 'nightlife'];

// Text-search phrasing per vibe — surfaces interesting places, not chains.
const VIBE_QUERIES: Record<Vibe, string> = {
  classics: 'iconic landmarks, historic sites, temples and museums worth seeing',
  matcha: 'cozy specialty-coffee cafes, artisan bakeries and charming little shops',
  nature: 'parks, gardens, waterfronts and scenic nature spots',
  nightlife: 'characterful cocktail bars, wine bars, pubs and nightlife',
};

// Deterministic fallback: Google primary types → vibe (used if the LLM is
// unavailable). Only Places (New) "Table A" types.
const VIBE_TYPES: Record<Vibe, string[]> = {
  classics: ['tourist_attraction', 'historical_landmark', 'museum', 'art_gallery', 'church', 'hindu_temple', 'mosque', 'synagogue', 'aquarium', 'zoo', 'amusement_park'],
  matcha: ['cafe', 'coffee_shop', 'bakery', 'ice_cream_shop', 'book_store', 'gift_shop'],
  nature: ['park', 'national_park', 'hiking_area', 'campground', 'marina', 'dog_park'],
  nightlife: ['bar', 'night_club', 'pub', 'wine_bar', 'bar_and_grill'],
};
const TYPE_TO_VIBE = new Map<string, Vibe>();
for (const [vibe, types] of Object.entries(VIBE_TYPES)) for (const t of types) TYPE_TO_VIBE.set(t, vibe as Vibe);
const ALL_TYPES = [...TYPE_TO_VIBE.keys()];

function fallbackVibe(place: any, hint: Vibe): Vibe {
  if (place.primaryType && TYPE_TO_VIBE.has(place.primaryType)) return TYPE_TO_VIBE.get(place.primaryType)!;
  for (const t of place.types ?? []) if (TYPE_TO_VIBE.has(t)) return TYPE_TO_VIBE.get(t)!;
  return hint; // the vibe query it was found under
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const FIELD_MASK =
  'places.id,places.displayName,places.primaryType,places.types,places.location,places.rating,places.userRatingCount,places.shortFormattedAddress,places.photos,places.currentOpeningHours.openNow,places.currentOpeningHours.nextCloseTime,places.utcOffsetMinutes,places.priceLevel,places.editorialSummary';

// Google price enum → $ count (1–4); free/unknown → null.
const PRICE: Record<string, number> = {
  PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4,
};
const priceOf = (p: any): number | null => (p.priceLevel ? PRICE[p.priceLevel] ?? null : null);

// One vibe → up to N candidate places via Text Search, biased to the user.
// Returns null (not []) when Google itself fails, so the handler can tell a
// broken key/quota apart from a genuinely empty area.
async function searchVibe(vibe: Vibe, lat: number, lng: number, radius: number, key: string): Promise<any[] | null> {
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK },
      body: JSON.stringify({
        textQuery: VIBE_QUERIES[vibe],
        maxResultCount: 18,
        locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius } },
      }),
    });
    if (!res.ok) {
      console.error(`[nearby] searchText ${vibe} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    const places = (await res.json()).places ?? [];
    return places.map((p: any) => ({ ...p, _hint: vibe }));
  } catch (e) {
    console.error(`[nearby] searchText ${vibe} threw:`, e);
    return null;
  }
}

// Haversine metres — Text Search only biases (can't restrict to a circle), so
// we bound candidates to genuinely near the user.
function distMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad, dLng = (bLng - aLng) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Broad nearby sweep (by type, popularity-ranked) — complements the per-vibe
// text queries so sparse vibes (few landmarks/parks) still fill out.
async function searchNearbyAll(lat: number, lng: number, radius: number, key: string): Promise<any[] | null> {
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK },
      body: JSON.stringify({
        includedTypes: ALL_TYPES,
        maxResultCount: 20,
        rankPreference: 'POPULARITY',
        locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
      }),
    });
    if (!res.ok) {
      console.error(`[nearby] searchNearby failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    const places = (await res.json()).places ?? [];
    return places.map((p: any) => ({ ...p, _hint: fallbackVibe(p, 'classics') }));
  } catch (e) {
    console.error('[nearby] searchNearby threw:', e);
    return null;
  }
}

// Weighted score so a 5.0 with 12 reviews doesn't beat a loved, busy 4.6.
function popularity(p: any): number {
  const r = p.rating ?? 0, n = p.userRatingCount ?? 0;
  return r * Math.log10(n + 10);
}

// Time-of-day: nudge each vibe up/down for the traveler's local hour so mornings
// lean cafes/nature and nights lean bars.
function daypartBoost(vibe: Vibe, hour: number): number {
  const morning = hour >= 5 && hour < 11;
  const midday = hour >= 11 && hour < 17;
  const evening = hour >= 17 && hour < 23;
  switch (vibe) {
    case 'matcha': return morning ? 1.3 : midday ? 1.1 : 0.85;
    case 'nature': return morning || midday ? 1.2 : 0.7;
    case 'classics': return morning || midday ? 1.15 : 0.85;
    case 'nightlife': return evening || !(morning || midday) ? 1.35 : 0.65;
    default: return 1;
  }
}

// Distance decay so a great spot 5 min away outranks an equally-great one far off.
const distanceWeight = (km: number) => 0.5 + 0.5 / (1 + km * 0.5);

// "closes 11pm" from Google's RFC3339 nextCloseTime + the place's UTC offset.
function closesAtLabel(nextCloseTime?: string, utcOffsetMinutes?: number): string | null {
  if (!nextCloseTime || utcOffsetMinutes == null) return null;
  const t = Date.parse(nextCloseTime);
  if (Number.isNaN(t)) return null;
  const local = new Date(t + utcOffsetMinutes * 60000);
  const h = local.getUTCHours(), m = local.getUTCMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

// Real review snippets (Place Details — billed) to ground the top spots' blurbs.
async function fetchReviews(placeId: string, key: string): Promise<string[]> {
  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}?languageCode=en`, {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'reviews' },
    });
    if (!res.ok) return [];
    const revs = (await res.json()).reviews ?? [];
    return revs
      .slice(0, 3)
      .map((r: any) => (r.text?.text ?? r.originalText?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200))
      .filter(Boolean);
  } catch {
    return [];
  }
}

interface Enrichment { blurb: string; tags: string[]; tip: string | null }

function toSpot(p: any, vibe: Vibe, e: Enrichment | null) {
  return {
    id: p.id, // place_id — the only Places field retained long-term
    title: p.displayName?.text ?? 'Unnamed',
    kind: (p.primaryType ?? '').replace(/_/g, ' '),
    area: p.shortFormattedAddress ?? '',
    lat: p.location?.latitude, lng: p.location?.longitude,
    rating: p.rating ?? null,
    ratingCount: p.userRatingCount ?? 0,
    photoName: p.photos?.[0]?.name ?? null,
    openNow: p.currentOpeningHours?.openNow ?? null,
    closesAt: p.currentOpeningHours?.openNow ? closesAtLabel(p.currentOpeningHours?.nextCloseTime, p.utcOffsetMinutes) : null,
    price: priceOf(p),
    blurb: e?.blurb ?? null,
    tags: e?.tags ?? [],
    tip: e?.tip ?? null,
    _vibe: vibe,
  };
}

type EnrichRow = { vibe: Vibe; blurb: string; tags: string[]; tip: string | null; keep: boolean; score: number };

// Claude re-sorts, grounds a blurb on Google's editorial note, adds tags + a
// practical tip, and prunes the generic. Returns null on any failure (→ fallback).
async function enrich(candidates: any[], apiKey: string): Promise<Map<string, EnrichRow> | null> {
  try {
    const dollars = (p: any) => { const n = priceOf(p); return n ? '$'.repeat(n) : '?'; };
    const list = candidates
      .map((p, i) => {
        const note = p.editorialSummary?.text ? ` — note: ${p.editorialSummary.text}` : '';
        const revs = (p._reviews?.length) ? ` — reviews: ${p._reviews.map((r: string) => `"${r}"`).join(' | ')}` : '';
        return `${i}. ${p.displayName?.text ?? 'Unnamed'} — ${(p.primaryType ?? 'place').replace(/_/g, ' ')} — ${p.rating ?? '?'}★ (${p.userRatingCount ?? 0}) — ${dollars(p)}${note}${revs}`;
      })
      .join('\n');
    const prompt =
      `You are a sharp local travel editor. Below are real places near a traveler.\n` +
      `For EACH place, using the "note" (Google's own description) and "reviews" (real visitor quotes) as GROUND TRUTH when present, produce:\n` +
      `- vibe: the single best of classics | matcha | nature | nightlife\n` +
      `- blurb: max 16 words, specific and evocative, grounded in the note, no clichés, no "a must-visit", no emoji, sentence case\n` +
      `- tags: 1–2 short lowercase labels a traveler would filter by (e.g. "hidden gem", "rooftop", "cash only", "great for rainy days", "late night")\n` +
      `- tip: one practical insider tip, max 12 words (best time, what to order, how to get in), or "" if none\n` +
      `- keep: default TRUE. Only set false for clearly generic spots — big chains, fast food, gas stations, parking, ATMs, transit stops, offices. When unsure, keep it.\n` +
      `- score: 1–10 for how special / worth-a-detour it is\n\n` +
      `Vibes:\n` +
      `- classics: iconic must-sees, landmarks, temples/shrines, museums, historic sites\n` +
      `- matcha: cafes, specialty coffee, bakeries, bookshops, calm & photogenic little places\n` +
      `- nature: parks, gardens, waterfronts, viewpoints, outdoor & scenic spots\n` +
      `- nightlife: bars, cocktail/wine bars, pubs, clubs, lively after-dark spots\n\n` +
      `Do NOT invent facts not supported by the name, type, note, or reviews. Prefer specifics from the reviews (what to order, the standout dish, the vibe).\n` +
      `Diversity: if several places are near-identical (e.g. many similar cafes), keep the best and set keep=false on the redundant ones.\n\n` +
      `Places:\n${list}\n\n` +
      `Reply with ONLY a JSON array, one object per place IN ORDER by index:\n` +
      `[{"i":0,"vibe":"matcha","blurb":"...","tags":["hidden gem"],"tip":"...","keep":true,"score":8}]`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 120 * candidates.length + 200, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data.content ?? [])[0]?.text ?? '';
    const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    const out = new Map<string, EnrichRow>();
    for (const item of arr) {
      const p = candidates[item?.i];
      if (!p) continue;
      const vibe: Vibe = VIBES.includes(item?.vibe) ? item.vibe : p._hint;
      const tags = Array.isArray(item?.tags) ? item.tags.slice(0, 2).map((t: any) => String(t).toLowerCase().slice(0, 22)) : [];
      const tip = String(item?.tip ?? '').trim().slice(0, 90) || null;
      out.set(p.id, {
        vibe,
        blurb: String(item?.blurb ?? '').trim().slice(0, 160),
        tags,
        tip,
        keep: item?.keep !== false,
        score: Number(item?.score) || 5,
      });
    }
    return out;
  } catch (e) {
    console.warn('[nearby] enrich failed:', e);
    return null;
  }
}

// One big call made the model write ~60 rows of JSON back-to-back (~40 s cold).
// Instead: group by the vibe each place was found under (so near-duplicates
// still share a chunk and get deduped), split big groups, and enrich the chunks
// in parallel — latency ≈ the slowest chunk. A chunk that fails or times out
// just leaves its places un-enriched (deterministic backfill), not the request.
async function enrichAll(candidates: any[], apiKey: string): Promise<Map<string, EnrichRow> | null> {
  const groups = new Map<string, any[]>();
  for (const p of candidates) groups.set(p._hint, [...(groups.get(p._hint) ?? []), p]);
  const chunks: any[][] = [];
  for (const g of groups.values()) for (let i = 0; i < g.length; i += ENRICH_CHUNK) chunks.push(g.slice(i, i + ENRICH_CHUNK));
  const results = await Promise.all(chunks.map((c) => enrich(c, apiKey)));
  if (results.every((r) => r === null)) return null;
  const out = new Map<string, EnrichRow>();
  for (const r of results) if (r) for (const [id, row] of r) out.set(id, row);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // per-stage timings → Server-Timing header, so slow loads are diagnosable
  const timings: string[] = [];
  let tMark = Date.now();
  const mark = (name: string) => { timings.push(`${name};dur=${Date.now() - tMark}`); tMark = Date.now(); };
  const withTiming = (res: Response) => {
    res.headers.set('Server-Timing', timings.join(', '));
    res.headers.set('Access-Control-Expose-Headers', 'Server-Timing');
    return res;
  };

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'Invalid session' }, 401);
  mark('auth');

  // phase: omitted = one-shot (old builds) · 'fast' = Places now, enrich in the
  // background · 'poll' = cache read only (no Google, no cap) while enriching
  let lat = NaN, lng = NaN, radius = 2000, reqHour: unknown, phase: 'full' | 'fast' | 'poll' = 'full';
  try {
    const b = await req.json();
    lat = Number(b.lat); lng = Number(b.lng);
    if (b.radius) radius = Math.min(Math.max(Number(b.radius), 200), 8000);
    reqHour = b.hour;
    if (b.phase === 'fast' || b.phase === 'poll') phase = b.phase;
  } catch { return json({ error: 'Invalid JSON body' }, 400); }
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return json({ error: 'lat/lng required (valid coordinates)' }, 400);

  // traveler's local hour for time-of-day biasing (client sends it; else derive
  // roughly from longitude so the feature still adapts without a timezone lookup).
  const h = Number(reqHour);
  const localHour = Number.isFinite(h) && h >= 0 && h <= 23
    ? Math.floor(h)
    : Math.floor(((new Date().getUTCHours() + lng / 15) % 24 + 24) % 24);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  await maybePurgeCaches(admin);
  mark('purge');

  // cache hit → serve without a Google/LLM call. ~1 km grid, fresh for an hour.
  const cacheKey = `nb:${lat.toFixed(2)}:${lng.toFixed(2)}:${radius}`;
  const { data: cached } = await admin.from('nearby_cache').select('result, fetched_at').eq('key', cacheKey).maybeSingle();
  mark('cache');
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < ONE_HOUR_MS) {
    return withTiming(json({ source: 'cache', center: [lat, lng], vibes: (cached.result as any).vibes }));
  }
  if (phase === 'poll') return json({ pending: true });

  if (!(await underDailyCap(admin, user.id, 'nearby-places', DAILY_CAP)))
    return json({ error: 'Daily nearby limit reached — try again tomorrow.', vibes: {} }, 429);
  mark('cap');

  const key = Deno.env.get('GOOGLE_PLACES_API_KEY');
  if (!key) return json({ error: 'Server missing GOOGLE_PLACES_API_KEY' }, 500);

  // 1. gather candidates: per-vibe Text Search (characterful) + a broad nearby
  // sweep (coverage), all in parallel.
  const [textBatches, nearbyResults] = await Promise.all([
    Promise.all(VIBES.map((v) => searchVibe(v, lat, lng, radius, key))),
    searchNearbyAll(lat, lng, radius, key),
  ]);
  mark('places');
  // every Google call failed → a key/billing/quota problem, not an empty area.
  // Surface it as an error (the app shows Retry) instead of "nothing nearby".
  if (nearbyResults === null && textBatches.every((b) => b === null))
    return json({ error: 'Places lookup failed' }, 502);
  const found = [...textBatches.flatMap((b) => b ?? []), ...(nearbyResults ?? [])];
  const seen = new Set<string>();
  const candidates: any[] = [];
  for (const p of found) {
    if (!p.id || seen.has(p.id)) continue;
    if ((p.userRatingCount ?? 0) < MIN_RATINGS) continue;
    // keep it genuinely near — Text Search bias can pull in far-but-famous spots
    const km = p.location ? distMeters(lat, lng, p.location.latitude, p.location.longitude) / 1000 : 999;
    if (km > (radius * 1.6) / 1000) continue;
    p._km = km;
    seen.add(p.id);
    candidates.push(p);
  }
  if (candidates.length === 0) return json({ source: 'places', center: [lat, lng], vibes: emptyVibes() });

  // 3. assemble vibes. Keep the model's picks first; hold its rejects as backfill
  // so a vibe is never near-empty when real candidates exist.
  // final rank = model score (or popularity) × distance decay × time-of-day boost
  const rank = (base: number, vibe: Vibe, km: number) => base * distanceWeight(km) * daypartBoost(vibe, localHour);
  const assemble = (enriched: Map<string, EnrichRow> | null) => {
    const kept = emptyVibes();
    const spare = emptyVibes();
    for (const p of candidates) {
      const km = p._km ?? 0;
      if (enriched) {
        const e = enriched.get(p.id);
        if (e) {
          const spot = { ...toSpot(p, e.vibe, e), _score: rank(e.score, e.vibe, km) };
          (e.keep ? kept : spare)[e.vibe].push(spot);
        } else {
          // model omitted it → usable as last-resort backfill, deterministic vibe
          const v = fallbackVibe(p, p._hint);
          spare[v].push({ ...toSpot(p, v, null), _score: rank(popularity(p), v, km) });
        }
      } else {
        const v = fallbackVibe(p, p._hint);
        kept[v].push({ ...toSpot(p, v, null), _score: rank(popularity(p), v, km) });
      }
    }
    // rank, backfill toward MIN_PER_VIBE, cap, strip internal fields
    const clean = emptyVibes();
    for (const v of VIBES) {
      const byScore = (a: any, b: any) => (b._score ?? 0) - (a._score ?? 0);
      const list = kept[v].sort(byScore);
      if (list.length < MIN_PER_VIBE) list.push(...spare[v].sort(byScore).slice(0, MIN_PER_VIBE - list.length));
      clean[v] = list.slice(0, PER_VIBE_CAP).map(({ _score, _vibe, ...s }: any) => s);
    }
    return clean;
  };
  const saveCache = (vibes: Record<Vibe, any[]>) =>
    admin.from('nearby_cache').upsert({ key: cacheKey, result: { vibes }, fetched_at: new Date().toISOString() });

  // 2. LLM enrichment (skipped past the global bill brake → deterministic path).
  // Ground the most prominent candidates on real review snippets first.
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  const allowLLM = anthropicKey && (await underGlobalDailyCap(admin, 'nearby-llm', GLOBAL_CAP));
  const toEnrich = candidates.slice(0, 60);
  const enrichNow = async () => {
    const top = [...toEnrich].sort((a, b) => popularity(b) - popularity(a)).slice(0, DETAIL_TOP);
    await Promise.all(top.map(async (p) => { p._reviews = await fetchReviews(p.id, key); }));
    mark('reviews');
    const enriched = await enrichAll(toEnrich, anthropicKey!);
    mark('llm');
    return enriched;
  };

  if (!allowLLM) {
    const vibes = assemble(null);
    saveCache(vibes).then(() => {});
    return withTiming(json({ source: 'places', center: [lat, lng], vibes }));
  }

  // two-phase: answer with Google's results now (deterministic vibes), finish the
  // reviews + LLM pass after the response and cache it — the app polls for it.
  // The un-enriched list is never cached, so later loads always get the full one.
  if (phase === 'fast' && typeof EdgeRuntime !== 'undefined') {
    EdgeRuntime.waitUntil(
      enrichNow()
        .then((enriched) => saveCache(assemble(enriched)))
        .catch((e) => console.error('[nearby] background enrich failed:', e)),
    );
    return withTiming(json({ source: 'places', enriching: true, center: [lat, lng], vibes: assemble(null) }));
  }

  const vibes = assemble(await enrichNow());
  saveCache(vibes).then(() => {});
  return withTiming(json({ source: 'places', center: [lat, lng], vibes }));
});

function emptyVibes(): Record<Vibe, any[]> {
  return { classics: [], matcha: [], nature: [], nightlife: [] };
}
