// Edge Function: seed-nearby (admin/seed tool)
// Fills a spot's `nearby` sub-places — the small detours offered in the
// Micro-Discovery sheet after a right-swipe ("Explore the area"). For each
// anchor it asks Google for the most popular cafés, parks, bars, museums etc.
// within a short walk, keeps a varied handful, and stores title/kind/walking
// minutes/coords plus the place_id (the app shows the live Google photo; the
// photo itself is never stored).
//
// Gated by the service-role key in `x-seed-secret` (deploy with --no-verify-jwt).
// POST { city?: string, ids?: string[], limit?: number, perSpot?: number,
//        radius?: number, overwrite?: boolean }
// Only spots with an empty `nearby` are touched unless overwrite is true, so
// hand-curated sub-places (Japan, NYC, SF…) are kept. Re-runnable.
//
// { backfill: true } instead attaches a place_id to existing sub-places that
// lack one (hand-curated ones), so the app can show their photo. It only adds
// that field. Uses Text Search with an IDs-only field mask (no-cost SKU),
// restricted to a small box around the sub-place, so a same-named place in
// another city can't match.
//
// Secret: GOOGLE_PLACES_API_KEY

import { createClient } from 'jsr:@supabase/supabase-js@2';

// Things worth a short detour. Long-standing Table A types first; the newer
// ones are retried without if Google rejects the request.
const TYPES_CORE = ['cafe', 'bakery', 'park', 'tourist_attraction', 'museum', 'art_gallery', 'book_store', 'bar', 'night_club'];
const TYPES_NEW = ['coffee_shop', 'ice_cream_shop', 'wine_bar', 'pub', 'market', 'historical_landmark', 'plaza'];

// Variety: at most two from any one bucket.
const BUCKET: Record<string, string> = {
  cafe: 'coffee', coffee_shop: 'coffee', bakery: 'sweet', ice_cream_shop: 'sweet',
  park: 'green', plaza: 'green', tourist_attraction: 'sights', historical_landmark: 'sights',
  museum: 'culture', art_gallery: 'culture', book_store: 'culture', market: 'shops',
  bar: 'drinks', wine_bar: 'drinks', pub: 'drinks', night_club: 'drinks',
};

// Google matches includedTypes on secondary types too, so a petrol station
// with a café counter can come back. Drop errand-type primaries outright.
const NOT_A_DETOUR = /gas_station|charging|^car_|parking|_station$|transit|airport|lodging|hotel|motel|hostel|supermarket|grocery|convenience|pharmacy|drugstore|bank|atm|hospital|doctor|dentist|clinic|school|police|post_office|storage|laundry|fast_food|meal_takeaway|shopping_mall|department_store|cell_phone|electronics|hardware|furniture|gym|fitness|apartment|housing|residential|office|corporate|coworking|car_wash|funeral|cemetery_service/;

// Same pastel placeholders the curated sub-places use.
const TONES = ['#E9D7CE', '#D7DEE4', '#DCE3D8', '#DED7E0', '#E7DCCB', '#DDE2D6', '#E4DACF', '#D9DFE6'];
const FIELD_MASK = 'places.id,places.displayName,places.primaryType,places.primaryTypeDisplayName,places.location,places.businessStatus';

// Google answers 429 when we outrun its per-minute quota: back off and retry.
async function placesFetch(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt === 4) return res;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

function distMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad, dLng = (bLng - aLng) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function searchNearby(lat: number, lng: number, radius: number, key: string): Promise<any[]> {
  const call = (types: string[]) =>
    placesFetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK },
      body: JSON.stringify({
        includedTypes: types,
        maxResultCount: 20,
        rankPreference: 'POPULARITY',
        languageCode: 'en',
        locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
      }),
    });
  let res = await call([...TYPES_CORE, ...TYPES_NEW]);
  if (res.status === 400) res = await call(TYPES_CORE);
  if (!res.ok) throw new Error(`places ${res.status}`);
  return (await res.json()).places ?? [];
}

async function findPlaceId(title: string, lat: number, lng: number, halfKm: number, key: string): Promise<string | null> {
  const dLat = halfKm / 111, dLng = halfKm / (111 * Math.cos((lat * Math.PI) / 180));
  const res = await placesFetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id' },
    body: JSON.stringify({
      textQuery: title,
      maxResultCount: 1,
      locationRestriction: { rectangle: { low: { latitude: lat - dLat, longitude: lng - dLng }, high: { latitude: lat + dLat, longitude: lng + dLng } } },
    }),
  });
  if (!res.ok) throw new Error(`places ${res.status}`);
  return (await res.json()).places?.[0]?.id ?? null;
}

type Anchor = { id: string; place_id: string | null; title: string; lat: number; lng: number };

function pick(anchor: Anchor, places: any[], perSpot: number, radius: number) {
  const out: any[] = [];
  const perBucket: Record<string, number> = {};
  const titles = new Set([anchor.title.toLowerCase()]);
  for (const p of places) {
    if (out.length >= perSpot) break;
    if (!p.id || p.id === anchor.place_id) continue;
    if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') continue;
    if (p.primaryType && NOT_A_DETOUR.test(p.primaryType)) continue;
    const title = p.displayName?.text?.trim();
    const lat = p.location?.latitude, lng = p.location?.longitude;
    if (!title || !Number.isFinite(lat) || !Number.isFinite(lng) || titles.has(title.toLowerCase())) continue;
    const d = distMeters(anchor.lat, anchor.lng, lat, lng);
    if (d < 25 || d > radius * 1.1) continue; // same building / outside the walk
    const bucket = BUCKET[p.primaryType] ?? 'other';
    if ((perBucket[bucket] ?? 0) >= 2) continue;
    perBucket[bucket] = (perBucket[bucket] ?? 0) + 1;
    titles.add(title.toLowerCase());
    out.push({
      id: p.id,
      placeId: p.id,
      title,
      kind: p.primaryTypeDisplayName?.text ?? String(p.primaryType ?? 'Place').replace(/_/g, ' '),
      mins: Math.max(1, Math.round((d * 1.3) / 80)), // street detour factor, ~80 m/min
      tone: TONES[out.length % TONES.length],
      photo: '',
      lat,
      lng,
    });
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  if (req.headers.get('x-seed-secret') !== Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
    return new Response('forbidden', { status: 403 });

  const { city, ids, limit = 40, perSpot = 4, radius = 650, overwrite = false, backfill = false } = await req.json();
  if (!city && !(Array.isArray(ids) && ids.length)) return new Response('city or ids required', { status: 400 });

  const key = Deno.env.get('GOOGLE_PLACES_API_KEY')!;
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  if (backfill) {
    let bq = admin.from('spots').select('id, lat, lng, nearby');
    bq = ids?.length ? bq.in('id', ids) : bq.eq('city', city);
    const { data: rows, error: bErr } = await bq.order('id').limit(Math.min(limit, 80));
    if (bErr) return new Response(JSON.stringify({ error: bErr.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    let rowsUpdated = 0, matched = 0, missed = 0;
    const errs: string[] = [];
    const queue = [...(rows ?? [])];
    await Promise.all(Array.from({ length: 3 }, async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        const items = (r.nearby ?? []) as any[];
        let changed = false;
        for (const n of items) {
          if (n.placeId) continue;
          const lat = n.lat ?? r.lat, lng = n.lng ?? r.lng;
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) { missed++; continue; }
          try {
            const id = await findPlaceId(n.title, lat, lng, n.lat != null ? 0.4 : 1.2, key);
            if (id) { n.placeId = id; matched++; changed = true; } else missed++;
          } catch (e) { errs.push(`${r.id}/${n.id}: ${String(e).slice(0, 60)}`); }
        }
        if (!changed) continue;
        const { error: upErr } = await admin.from('spots').update({ nearby: items }).eq('id', r.id);
        if (upErr) errs.push(`${r.id}: ${upErr.message}`); else rowsUpdated++;
      }
    }));
    return new Response(JSON.stringify({ backfill: true, processed: rows?.length ?? 0, rowsUpdated, matched, missed, errors: errs.slice(0, 5) }), { headers: { 'Content-Type': 'application/json' } });
  }

  let q = admin.from('spots').select('id, place_id, title, lat, lng').not('lat', 'is', null).not('lng', 'is', null);
  q = ids?.length ? q.in('id', ids) : q.eq('city', city);
  if (!overwrite) q = q.or('nearby.is.null,nearby.eq.[]');
  const { data: anchors, error } = await q.order('id').limit(Math.min(limit, 80));
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  let updated = 0, empty = 0;
  const errors: string[] = [];
  const work = [...(anchors ?? [])] as Anchor[];
  // small pool: stays under Google's per-minute quota, finishes inside the function timeout
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let a = work.shift(); a; a = work.shift()) {
      try {
        const nearby = pick(a, await searchNearby(a.lat, a.lng, radius, key), perSpot, radius);
        if (nearby.length < 2) { empty++; continue; } // leave it for a wider re-run
        const { error: upErr } = await admin.from('spots').update({ nearby }).eq('id', a.id);
        if (upErr) errors.push(`${a.id}: ${upErr.message}`); else updated++;
      } catch (e) {
        errors.push(`${a.id}: ${String(e).slice(0, 80)}`);
      }
    }
  }));

  return new Response(
    JSON.stringify({ city: city ?? null, processed: anchors?.length ?? 0, updated, empty, errors: errors.slice(0, 5) }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});
