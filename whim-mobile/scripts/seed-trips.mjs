// Seed one official "BeWhim Editors'" 3-day itinerary per curated city from
// that city's real curated spots. Run: node --env-file=.env.seed scripts/seed-trips.mjs
// Seed one official "BeWhim Editors'" 3-day itinerary per curated city, built
// from that city's real curated spots so the map + Maps export work. Each city:
// select a balanced ~12-spot highlight set, cluster into 3 geographic days,
// order each day by nearest-neighbor, and publish.
import { createClient } from '@supabase/supabase-js';

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CITIES = ['Tokyo','Kyoto','Osaka','Fukuoka','Hiroshima','Paris','Nice','Berlin','Munich','London','Edinburgh','New York','San Francisco'];
const VIBE_ORDER = ['classics', 'nature', 'matcha', 'nightlife'];
const POOL = 16;  // candidate spots before trimming outliers
const FINAL = 12; // stops in the final 3-day trip

const d2 = (a, b) => (a.lat - b.lat) ** 2 + (a.lng - b.lng) ** 2;
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };

// pick ~TARGET spots, round-robin across vibes (classics-first) for variety;
// deck order front-loads the icons, so take from the front of each bucket.
function select(spots) {
  const buckets = { classics: [], nature: [], matcha: [], nightlife: [] };
  for (const sp of spots) {
    const v = (sp.vibes ?? [])[0] ?? 'classics';
    (buckets[v] ?? buckets.classics).push(sp);
  }
  const out = [];
  let added = true;
  while (out.length < POOL && added) {
    added = false;
    for (const v of VIBE_ORDER) {
      if (buckets[v].length && out.length < POOL) {
        out.push(buckets[v].shift());
        added = true;
      }
    }
  }
  return out;
}

// k-means++ init + a few iterations, k=3
function cluster(pts, k = 3) {
  if (pts.length <= k) return pts.map((_, i) => i);
  const cent = [pts[0]];
  while (cent.length < k) {
    let far = pts[0], fd = -1;
    for (const p of pts) {
      const nd = Math.min(...cent.map((c) => d2(p, c)));
      if (nd > fd) { fd = nd; far = p; }
    }
    cent.push(far);
  }
  let assign = new Array(pts.length).fill(0);
  for (let it = 0; it < 12; it++) {
    for (let i = 0; i < pts.length; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) { const dd = d2(pts[i], cent[c]); if (dd < bd) { bd = dd; best = c; } }
      assign[i] = best;
    }
    for (let c = 0; c < k; c++) {
      const mem = pts.filter((_, i) => assign[i] === c);
      if (mem.length) cent[c] = { lat: mem.reduce((s, p) => s + p.lat, 0) / mem.length, lng: mem.reduce((s, p) => s + p.lng, 0) / mem.length };
    }
  }
  return assign;
}

// nearest-neighbor order starting from the point nearest the group centroid
function orderDay(pts) {
  if (pts.length <= 2) return pts;
  const cen = { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length };
  const remaining = [...pts];
  let cur = remaining.splice(remaining.reduce((bi, p, i, a) => (d2(p, cen) < d2(a[bi], cen) ? i : bi), 0), 1)[0];
  const path = [cur];
  while (remaining.length) {
    const ni = remaining.reduce((bi, p, i, a) => (d2(p, cur) < d2(a[bi], cur) ? i : bi), 0);
    cur = remaining.splice(ni, 1)[0];
    path.push(cur);
  }
  return path;
}

function buildTrip(cityName, spots) {
  const withCoords = spots.filter((sp) => sp.lat != null && sp.lng != null);
  const pool = select(withCoords);
  // trim geographic outliers: keep the FINAL spots closest to the median center
  // (drops far-flung suburbs so each day stays tight and walkable)
  const center = { lat: median(pool.map((p) => p.lat)), lng: median(pool.map((p) => p.lng)) };
  const central = [...pool].sort((a, b) => d2(a, center) - d2(b, center)).slice(0, FINAL);
  // balanced days: sweep by angle around center, split into 3 EQUAL wedges
  const swept = central
    .map((p) => ({ p, ang: Math.atan2(p.lat - center.lat, p.lng - center.lng) }))
    .sort((a, b) => a.ang - b.ang)
    .map((x) => x.p);
  const per = Math.ceil(swept.length / 3);
  let days = [swept.slice(0, per), swept.slice(per, per * 2), swept.slice(per * 2)]
    .filter((g) => g.length > 0)
    .map((g) => orderDay(g));
  // marquee neighbourhood first (most classics)
  days.sort((a, b) => b.filter((x) => (x.vibes ?? [])[0] === 'classics').length - a.filter((x) => (x.vibes ?? [])[0] === 'classics').length);

  const stop_spot_ids = [];
  const stop_days = [];
  const noteLines = [];
  days.forEach((g, di) => {
    for (const sp of g) { stop_spot_ids.push(sp.id); stop_days.push(di + 1); }
    const area = g[0]?.area || cityName;
    const names = g.slice(0, 3).map((x) => x.title).join(', ');
    noteLines.push(`Day ${di + 1} · ${area} — ${names}${g.length > 3 ? '…' : ''}`);
  });
  const cover = days[0]?.find((x) => x.photo)?.photo ?? chosen.find((x) => x.photo)?.photo ?? null;
  return {
    title: `3 perfect days in ${cityName}`,
    note: `The BeWhim editors’ highlight route — three walkable days, one neighbourhood at a time.\n\n${noteLines.join('\n')}`,
    stop_spot_ids, stop_days, stop_count: stop_spot_ids.length, cover,
  };
}

(async () => {
  const { data: us } = await s.auth.admin.listUsers({ perPage: 1 });
  const author = us.users[0].id;
  for (const city of CITIES) {
    const { data: spots } = await s.from('spots').select('id,title,vibes,area,lat,lng,photo').eq('city', city);
    if (!spots?.length) { console.log(`${city}: no spots, skip`); continue; }
    const trip = buildTrip(city, spots);
    // idempotent: replace any existing editors' pick for this city
    await s.from('published_itineraries').delete().eq('author_name', 'BeWhim').eq('city', city);
    const { error } = await s.from('published_itineraries').insert({
      author, author_name: 'BeWhim', title: trip.title, note: trip.note, city, vibe: null,
      stop_spot_ids: trip.stop_spot_ids, stop_days: trip.stop_days, stop_count: trip.stop_count,
      cover: trip.cover, status: 'approved',
    });
    console.log(error ? `${city}: ERR ${error.message}` : `${city}: ${trip.stop_count} stops · ${Math.max(...trip.stop_days)} days`);
  }
})();
