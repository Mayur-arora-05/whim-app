// Edge Function: seed-city (admin/seed tool)
// Curates a city's decks into the `spots` catalogue, reusing the Near-me engine:
// per-vibe Google Text Search → real review snippets → one Claude pass that
// writes an editorial blurb, assigns the vibe, and adds kind/area/tags. Stores
// place_id so the app renders the real Google photo live (via the photo proxy).
//
// Gated by the service-role key in `x-seed-secret` (deploy with --no-verify-jwt).
// Invoke per city; idempotent (upsert by place_id).
//
// Top-up mode ({ onlyNew: true, vibes: [...] }): adds places that aren't in the
// catalogue yet (by place_id, any city) for just those vibes, and never touches
// existing rows — a plain re-seed would overwrite them and reset their `nearby`.
//
// Secrets: GOOGLE_PLACES_API_KEY, ANTHROPIC_API_KEY

import { createClient } from 'jsr:@supabase/supabase-js@2';

type Vibe = 'classics' | 'matcha' | 'nature' | 'nightlife';
const VIBES: Vibe[] = ['classics', 'matcha', 'nature', 'nightlife'];

const VIBE_QUERIES: Record<Vibe, string> = {
  classics: 'famous landmarks, iconic architecture, historic sites and top museums',
  matcha: 'beloved specialty-coffee shops, patisseries, cozy bookshops and design boutiques',
  nature: 'best parks, gardens, viewpoints, waterfronts and scenic outdoor spots',
  nightlife: 'top cocktail bars, wine bars, historic pubs and iconic nightlife',
};

// Second phrasing per vibe, used in top-up mode to widen the candidate pool
// once the obvious top-20 are already in the deck.
const VIBE_QUERIES_ALT: Record<Vibe, string> = {
  classics: 'historic old town squares, churches, palaces and notable museums',
  matcha: 'independent cafes, tea rooms, bakeries, concept stores and bookshops',
  nature: 'parks, botanical gardens, lakes, rivers, hills and scenic lookouts',
  nightlife: 'craft beer bars, speakeasies, live music bars and wine bars',
};

const PALETTE = ['#2740E0', '#0E7C86', '#B5521E', '#1F5C3D', '#B23A6B', '#4A335E', '#B07A17', '#2B3A67'];
const PRICE: Record<string, number> = { PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 };

const FIELD_MASK =
  'places.id,places.displayName,places.primaryType,places.types,places.location,places.rating,places.userRatingCount,places.shortFormattedAddress,places.editorialSummary,places.priceLevel';

function distMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad, dLng = (bLng - aLng) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const popularity = (p: any) => (p.rating ?? 0) * Math.log10((p.userRatingCount ?? 0) + 10);

async function searchVibe(vibe: Vibe, lat: number, lng: number, radius: number, key: string, query = VIBE_QUERIES[vibe]): Promise<any[]> {
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK },
      body: JSON.stringify({ textQuery: query, maxResultCount: 20, locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius } } }),
    });
    if (!res.ok) return [];
    return ((await res.json()).places ?? []).map((p: any) => ({ ...p, _hint: vibe }));
  } catch { return []; }
}

async function fetchReviews(placeId: string, key: string): Promise<string[]> {
  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}?languageCode=en`, {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'reviews' },
    });
    if (!res.ok) return [];
    return ((await res.json()).reviews ?? []).slice(0, 3).map((r: any) => (r.text?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean);
  } catch { return []; }
}

type Row = { vibe: Vibe; blurb: string; kind: string; area: string; when: string; tags: string[]; keep: boolean; score: number };

async function enrichChunk(cands: any[], apiKey: string, out: Map<string, Row>): Promise<string | null> {
  const dollars = (p: any) => { const n = p.priceLevel ? PRICE[p.priceLevel] : 0; return n ? '$'.repeat(n) : ''; };
  const list = cands.map((p, i) => {
    const note = p.editorialSummary?.text ? ` — note: ${p.editorialSummary.text}` : '';
    const revs = p._reviews?.length ? ` — reviews: ${p._reviews.map((r: string) => `"${r}"`).join(' | ')}` : '';
    return `${i}. ${p.displayName?.text ?? '?'} — ${(p.primaryType ?? 'place').replace(/_/g, ' ')} — ${p.rating ?? '?'}★(${p.userRatingCount ?? 0}) ${dollars(p)} — ${p.shortFormattedAddress ?? ''}${note}${revs}`;
  }).join('\n');
  const prompt =
    `You are the editor of a premium city travel guide. Below are real places. For EACH, using the note and reviews as ground truth, produce a guide entry.\n` +
    `Return per place: vibe (classics|matcha|nature|nightlife), blurb (a vivid, specific editorial sentence, max 22 words, no clichés, no "must-visit", sentence case), kind (2-3 word category e.g. "Rooftop bar", "Art museum", "Specialty coffee"), area (the neighborhood/district only), when (a SHORT visiting hint, max 4 words, e.g. "Best at sunset", "Opens 10am", "Evenings", "Anytime"), tags (2-3 short labels), keep (false for generic chains, fast food, malls, transit, hotels, forgettable spots; true only for genuinely notable places a guide would feature), score (1-10 iconic/worth-it).\n` +
    `Vibes: classics=landmarks/museums/historic; matcha=cafes/bakeries/bookshops/design; nature=parks/gardens/viewpoints/water; nightlife=bars/clubs/pubs.\n` +
    `Do not invent facts. Prefer specifics from the note/reviews.\n\nPlaces:\n${list}\n\n` +
    `Reply ONLY a JSON array in index order: [{"i":0,"vibe":"classics","blurb":"...","kind":"...","area":"...","when":"...","tags":["..."],"keep":true,"score":9}]`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) return `anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`;
  const text = ((await res.json()).content ?? [])[0]?.text ?? '';
  try {
    const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    for (const it of arr) {
      const p = cands[it?.i]; if (!p) continue;
      const vibe: Vibe = VIBES.includes(it?.vibe) ? it.vibe : p._hint;
      out.set(p.id, {
        vibe,
        blurb: String(it?.blurb ?? '').trim().slice(0, 200),
        kind: String(it?.kind ?? (p.primaryType ?? '').replace(/_/g, ' ')).trim().slice(0, 40),
        area: String(it?.area ?? '').trim().slice(0, 50),
        when: String(it?.when ?? 'Anytime').trim().slice(0, 40),
        tags: Array.isArray(it?.tags) ? it.tags.slice(0, 3).map((t: any) => String(t).slice(0, 24)) : [],
        keep: it?.keep !== false,
        score: Number(it?.score) || 5,
      });
    }
    return null;
  } catch (e) { return `parse failed (${String(e).slice(0, 80)}); head: ${text.slice(0, 120)}`; }
}

// Chunk so no single LLM response overflows / truncates. Partial chunks still count.
async function enrich(cands: any[], apiKey: string): Promise<{ map: Map<string, Row>; errors: string[] }> {
  const map = new Map<string, Row>();
  const errors: string[] = [];
  for (let i = 0; i < cands.length; i += 20) {
    const err = await enrichChunk(cands.slice(i, i + 20), apiKey, map);
    if (err) errors.push(err);
  }
  return { map, errors };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  if (req.headers.get('x-seed-secret') !== Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
    return new Response('forbidden', { status: 403 });

  const { city, lat, lng, perVibe = 12, radius = 11000, minRatings = 60, noLLM = false, onlyNew = false, vibes: only } = await req.json();
  if (!city || !Number.isFinite(lat) || !Number.isFinite(lng)) return new Response('city, lat, lng required', { status: 400 });
  const wanted: Vibe[] = Array.isArray(only) && only.length ? VIBES.filter((v) => only.includes(v)) : VIBES;

  const key = Deno.env.get('GOOGLE_PLACES_API_KEY')!;
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')!;
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // 1. candidates
  const searches = wanted.map((v) => searchVibe(v, lat, lng, radius, key));
  if (onlyNew) searches.push(...wanted.map((v) => searchVibe(v, lat, lng, radius, key, VIBE_QUERIES_ALT[v])));
  const found = (await Promise.all(searches)).flat();
  // top-up: skip anything already in the catalogue (by place_id or same title in this city)
  const known = new Set<string>();
  const knownTitles = new Set<string>();
  if (onlyNew) {
    const ids = [...new Set(found.map((p) => p.id).filter(Boolean))];
    for (let i = 0; i < ids.length; i += 60) {
      const { data: hits } = await admin.from('spots').select('place_id').in('place_id', ids.slice(i, i + 60));
      for (const h of hits ?? []) known.add(h.place_id);
    }
    const { data: same } = await admin.from('spots').select('title').eq('city', city);
    for (const t of same ?? []) knownTitles.add(String(t.title).toLowerCase().trim());
  }
  const seen = new Set<string>();
  const cands: any[] = [];
  for (const p of found) {
    if (!p.id || seen.has(p.id) || known.has(p.id)) continue;
    if (knownTitles.has(String(p.displayName?.text ?? '').toLowerCase().trim())) continue;
    if ((p.userRatingCount ?? 0) < minRatings) continue;
    if (p.location && distMeters(lat, lng, p.location.latitude, p.location.longitude) > radius * 1.4) continue;
    seen.add(p.id); cands.push(p);
  }
  if (!cands.length) return new Response(JSON.stringify({ city, inserted: 0, note: 'no candidates' }), { headers: { 'Content-Type': 'application/json' } });

  // 2. reviews for the most prominent, then enrich (skipped in noLLM fallback mode)
  let enriched = new Map<string, Row>();
  let enrichErr: string[] = [];
  if (!noLLM) {
    const top = [...cands].sort((a, b) => popularity(b) - popularity(a)).slice(0, 28);
    await Promise.all(top.map(async (p) => { p._reviews = await fetchReviews(p.id, key); }));
    const r = await enrich(cands.slice(0, 80), anthropicKey);
    enriched = r.map; enrichErr = r.errors;
  }
  // Fallback: if the LLM is unavailable (e.g. no Anthropic credit), still seed
  // real spots using Google's own editorial summary + the vibe they were found
  // under. Lower fidelity, but populated now; re-seed later upgrades the voice.
  const llm = enriched.size > 0;
  const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

  // 3. group by vibe, rank, cap
  const byVibe: Record<Vibe, any[]> = { classics: [], matcha: [], nature: [], nightlife: [] };
  for (const p of cands) {
    if (llm) {
      const e = enriched.get(p.id);
      if (!e || !e.keep) continue;
      byVibe[e.vibe].push({ p, e, rank: e.score * Math.log10((p.userRatingCount ?? 0) + 10) });
    } else {
      const v: Vibe = VIBES.includes(p._hint) ? p._hint : 'classics';
      byVibe[v].push({ p, e: null, rank: popularity(p) });
    }
  }
  let tone = 0;
  const rows: any[] = [];
  for (const v of wanted) {
    byVibe[v].sort((a, b) => b.rank - a.rank);
    for (const { p, e } of byVibe[v].slice(0, perVibe)) {
      const kind = (e?.kind || (p.primaryType ?? 'place').replace(/_/g, ' ')).trim();
      const area = (e?.area || (p.shortFormattedAddress ?? '').split(',')[0] || '').trim();
      rows.push({
        id: p.id,
        place_id: p.id,
        city,
        vibes: [v],
        title: p.displayName?.text ?? 'Unnamed',
        kind,
        area,
        hours: e?.when || 'Anytime',
        tone: PALETTE[tone++ % PALETTE.length],
        photo: '',
        tags: e?.tags ?? [],
        description: e?.blurb || p.editorialSummary?.text || `${cap(kind)}${area ? ` in ${area}` : ''}.`,
        lat: p.location?.latitude ?? null,
        lng: p.location?.longitude ?? null,
        nearby: [],
      });
    }
  }
  if (!rows.length) return new Response(JSON.stringify({ city, inserted: 0, note: 'all pruned' }), { headers: { 'Content-Type': 'application/json' } });

  const { error } = await admin.from('spots').upsert(rows, { onConflict: 'id' });
  if (error) return new Response(JSON.stringify({ city, error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  const counts = Object.fromEntries(wanted.map((v) => [v, rows.filter((r) => r.vibes[0] === v).length]));
  return new Response(JSON.stringify({ city, inserted: rows.length, counts, candidates: cands.length, mode: llm ? 'llm' : 'fallback', enrichErr: enrichErr.slice(0, 1) }), { headers: { 'Content-Type': 'application/json' } });
});
