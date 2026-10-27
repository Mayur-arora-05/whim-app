import { supabase } from './supabase';
import type { VibeId } from './types';
import { distanceKm } from './route';

// Live "near me" spots from Google Places, sorted into vibes by the
// nearby-places Edge Function. NOT curated, NOT stored — this is the live
// discovery layer that sits alongside the premium curated decks.
export interface NearbySpot {
  id: string; // Google place_id
  title: string;
  kind: string;
  area: string;
  lat?: number;
  lng?: number;
  rating: number | null;
  ratingCount: number;
  photoName: string | null;
  km?: number; // distance from the user, filled client-side
  community?: boolean; // true = a user-submitted local pick, not a live Places result
  blurb?: string | null;
  openNow?: boolean | null;
  closesAt?: string | null; // e.g. "11pm", when open
  price?: number | null; // 1–4 → $–$$$$
  tags?: string[];
  tip?: string | null;
}

export type NearbyVibes = Record<VibeId, NearbySpot[]>;

export interface NearbyResult {
  center: [number, number];
  vibes: NearbyVibes;
  /** true = Google's raw picks; blurbs/tips are still being written — poll for them. */
  enriching?: boolean;
}

type NearbyResponse = { center: [number, number]; vibes: NearbyVibes; enriching?: boolean; pending?: boolean };

// annotate each spot with distance from the user for display + sorting
function withDistances(vibes: NearbyVibes, lat: number, lng: number): NearbyVibes {
  for (const vibe of Object.keys(vibes) as VibeId[]) {
    vibes[vibe] = vibes[vibe].map((s) => ({
      ...s,
      km: s.lat != null && s.lng != null ? distanceKm({ lat, lng }, { lat: s.lat, lng: s.lng }) : undefined,
    }));
  }
  return vibes;
}

/**
 * Fetch nearby spots grouped by vibe — two-phase: returns Google's results as
 * soon as they're in (`enriching: true` while the AI blurbs/tips are still being
 * written server-side; follow up with `pollNearby`). Returns null on any failure.
 */
export async function fetchNearby(lat: number, lng: number, radius = 3000): Promise<NearbyResult | null> {
  try {
    const { data, error } = await supabase.functions.invoke<NearbyResponse>('nearby-places', {
      body: { lat, lng, radius, hour: new Date().getHours(), phase: 'fast' },
    });
    if (error || !data?.vibes) return null;
    return { center: data.center, vibes: withDistances(data.vibes, lat, lng), enriching: data.enriching === true };
  } catch {
    return null;
  }
}

/**
 * Check whether the enriched results for this spot are ready (cache read only —
 * no Google calls, doesn't count toward the daily cap). Must use the same
 * lat/lng/radius as the `fetchNearby` call. 'pending' = not yet; null = failed.
 */
export async function pollNearby(lat: number, lng: number, radius = 3000): Promise<NearbyResult | 'pending' | null> {
  try {
    const { data, error } = await supabase.functions.invoke<NearbyResponse>('nearby-places', {
      body: { lat, lng, radius, hour: new Date().getHours(), phase: 'poll' },
    });
    if (error || !data) return null;
    if (data.pending) return 'pending';
    if (!data.vibes) return null;
    return { center: data.center, vibes: withDistances(data.vibes, lat, lng) };
  } catch {
    return null;
  }
}

/** "4.6★ · 320m" style meta line. */
export function spotMeta(s: NearbySpot): string {
  const bits: string[] = [];
  if (s.rating != null) bits.push(`${s.rating}★`);
  if (s.km != null) bits.push(s.km < 1 ? `${Math.round(s.km * 1000)}m` : `${s.km.toFixed(1)}km`);
  return bits.join('  ·  ');
}

/** "$$" price label, or '' when unknown. */
export function priceLabel(s: NearbySpot): string {
  return s.price ? '$'.repeat(s.price) : '';
}

/** Open-state label: "Open · closes 11pm" / "Open" / "Closed" / '' when unknown. */
export function hoursLabel(s: NearbySpot): { text: string; open: boolean } | null {
  if (s.openNow == null) return null;
  if (!s.openNow) return { text: 'Closed', open: false };
  return { text: s.closesAt ? `Open · closes ${s.closesAt}` : 'Open', open: true };
}

/** Rough walk time from distance (~12 min/km), e.g. "6 min walk". Empty if unknown/far. */
export function walkTime(s: NearbySpot): string {
  if (s.km == null) return '';
  const mins = Math.round(s.km * 12);
  if (mins < 1) return 'right here';
  if (mins > 60) return '';
  return `${mins} min walk`;
}

/** Rich meta line: "4.6★ · $$ · 6 min walk". */
export function richMeta(s: NearbySpot): string {
  const bits: string[] = [];
  if (s.rating != null) bits.push(`${s.rating}★`);
  const p = priceLabel(s);
  if (p) bits.push(p);
  const w = walkTime(s);
  if (w) bits.push(w);
  return bits.join('  ·  ');
}
