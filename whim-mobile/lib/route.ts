import type { BucketAnchor, Spot } from './types';

export interface RouteStop {
  id: string;
  title: string;
  kind: string;
  lat: number;
  lng: number;
  order: number;
  hours?: string;
  bestTime?: string; // Morning | Daytime | Evening
}

// Haversine distance in km between two lat/lng points.
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Classify a spot's freeform opening-hours into a part of day:
// 0 = morning, 1 = daytime / anytime, 2 = evening.
// Only a real constraint moves a stop out of daytime: "opens (in the) morning"
// just says when the doors open, so it stays daytime — otherwise far-flung
// gardens all pile into one morning block and the day zig-zags. Morning = best
// early; evening = opens at 4 PM or later, or is explicitly an after-dark spot.
function timeSlot(hours?: string): 0 | 1 | 2 {
  const h = (hours ?? '').toLowerCase();
  if (/(best (at dawn|at sunrise|before noon|in the morning)|^start (early|by noon)|^mornings\b)/.test(h)) return 0;
  // opening clock time: "Daily 6:00 PM - 2:00 AM", "From 8 PM", "Tue-Sat 6:00 PM…", "sets typically 8:30 PM"
  const open = h.match(/(?:from|daily|sets(?: typically)?|mon|tue|wed|thu|fri|sat|sun)[,\s]+(\d{1,2})(?::\d\d)?\s*(am|pm)/);
  if (open) return (Number(open[1]) % 12) + (open[2] === 'pm' ? 12 : 0) >= 16 ? 2 : 1;
  if (/(till|until|to) (dusk|evening|sunset)/.test(h)) return 1; // "dawn to dusk", "open till evening"
  if (/(^evenings?\b|after dark|at dusk|from dusk|comes alive|sunset|at night|all night|till dawn|dinner|afternoon-evening)/.test(h)) return 2;
  return 1;
}
const SLOT_LABEL = ['Morning', 'Daytime', 'Evening'] as const;

interface Pt {
  lat: number;
  lng: number;
}
function nearestNeighbour<T extends Pt>(pts: T[], startFrom?: Pt): T[] {
  const remaining = [...pts];
  const ordered: T[] = [];
  let anchor = startFrom;
  if (!anchor && remaining.length) {
    ordered.push(remaining.shift()!);
    anchor = ordered[0];
  }
  while (remaining.length && anchor) {
    let bestIdx = 0;
    let bestDist = Infinity;
    remaining.forEach((p, i) => {
      const d = distanceKm(anchor!, p);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    });
    const next = remaining.splice(bestIdx, 1)[0];
    ordered.push(next);
    anchor = next;
  }
  return ordered;
}

function pathKm(pts: Pt[]): number {
  let km = 0;
  for (let i = 1; i < pts.length; i++) km += distanceKm(pts[i - 1], pts[i]);
  return km;
}

// 2-opt on an open path: keep reversing any stretch whose reversal shortens
// the walk (i.e. untangle crossings) until nothing improves. `from` is a fixed
// point the path must start next to (end of the previous block); it never moves.
function twoOpt<T extends Pt>(path: T[], from?: Pt): T[] {
  const p: Pt[] = from ? [from, ...path] : [...path];
  const d = (a: Pt, b: Pt) => distanceKm(a, b);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = from ? 1 : 0; i < p.length - 1; i++) {
      for (let k = i + 1; k < p.length; k++) {
        const prev = i > 0 ? p[i - 1] : undefined;
        const next = k + 1 < p.length ? p[k + 1] : undefined;
        const before = (prev ? d(prev, p[i]) : 0) + (next ? d(p[k], next) : 0);
        const after = (prev ? d(prev, p[k]) : 0) + (next ? d(p[i], next) : 0);
        if (after < before - 1e-9) {
          p.splice(i, k - i + 1, ...p.slice(i, k + 1).reverse());
          improved = true;
        }
      }
    }
  }
  return (from ? p.slice(1) : p) as T[];
}

// Walk the time blocks in order. Plain = the original behaviour (first saved
// spot opens the day, nearest-neighbour only). Otherwise `first` picks the
// day's opening stop and every block is nearest-neighbour + 2-opt.
function walkBlocks<T extends Pt>(blocks: T[][], first?: number): T[] {
  const out: T[] = [];
  blocks.forEach((group, gi) => {
    const last = out[out.length - 1];
    if (first == null) {
      out.push(...nearestNeighbour(group, last));
    } else if (gi === 0) {
      const [head, ...tail] = nearestNeighbour([group[first], ...group.filter((_, j) => j !== first)]);
      out.push(head, ...twoOpt(tail, head));
    } else {
      out.push(...twoOpt(nearestNeighbour(group, last), last));
    }
  });
  return out;
}

/**
 * Time-of-day-aware ordering: bucket the stops into morning / daytime / evening
 * from their opening hours, sequence those blocks in order, and walk each block
 * continuing from where the previous block ended. Tries every stop of the first
 * block as the day's start (nearest-neighbour + 2-opt per block) and keeps the
 * shortest total — the plain first-saved-spot walk stays a candidate, so the
 * result is never longer than it was before. Keeps the day both geographically
 * sane and open-when-you-arrive.
 */
export function orderSmart(bucket: BucketAnchor[]): RouteStop[] {
  const points = bucket
    .filter((b) => b.anchor.lat != null && b.anchor.lng != null)
    .map((b) => ({
      id: b.anchor.id,
      title: b.anchor.title,
      kind: b.anchor.kind,
      lat: b.anchor.lat as number,
      lng: b.anchor.lng as number,
      hours: b.anchor.hours,
      slot: timeSlot(b.anchor.hours),
    }));

  const blocks = ([0, 1, 2] as const).map((slot) => points.filter((p) => p.slot === slot)).filter((g) => g.length);

  // strict < keeps the original order on ties, so plans don't reshuffle for nothing
  let ordered = walkBlocks(blocks);
  let bestKm = pathKm(ordered);
  for (let s = 0; s < (blocks[0]?.length ?? 0); s++) {
    const candidate = walkBlocks(blocks, s);
    const km = pathKm(candidate);
    if (km < bestKm - 1e-9) {
      ordered = candidate;
      bestKm = km;
    }
  }

  return ordered.map((p, i) => ({
    id: p.id,
    title: p.title,
    kind: p.kind,
    lat: p.lat,
    lng: p.lng,
    hours: p.hours,
    order: i + 1,
    bestTime: SLOT_LABEL[p.slot],
  }));
}

// keep the old name working for existing imports
export const orderByProximity = orderSmart;

/** Wrap bare spots (e.g. room matches) so orderSmart can sequence them. */
export function orderSpots(spots: Spot[]): RouteStop[] {
  return orderSmart(spots.map((s) => ({ anchor: s, microActivities: [], city: '', vibe: 'classics' })));
}

/** Rough transit-time estimate between stops (fallback when Google is down). */
export function estimateTransitMins(a: RouteStop, b: RouteStop): number {
  return Math.max(5, Math.round(distanceKm(a, b) * 3) + 3);
}

/** Hand the whole route to Google Maps (opens the app if installed). */
export function googleMapsDirectionsUrl(stops: RouteStop[]): string | null {
  if (stops.length === 0) return null;
  const pt = (s: RouteStop) => `${s.lat},${s.lng}`;
  if (stops.length === 1) return `https://www.google.com/maps/search/?api=1&query=${pt(stops[0])}`;
  const waypoints = stops.slice(1, -1).map(pt).join('|');
  return (
    `https://www.google.com/maps/dir/?api=1&origin=${pt(stops[0])}&destination=${pt(stops[stops.length - 1])}` +
    // Google Maps can't route transit through waypoints — a multi-stop transit
    // link opens a blank route. Only force transit for a single A→B leg.
    (waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : '&travelmode=transit')
  );
}
