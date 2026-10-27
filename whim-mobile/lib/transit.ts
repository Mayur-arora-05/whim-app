import { supabase } from './supabase';
import type { RouteStop } from './route';

export interface TransitSegment {
  mode: 'walk' | 'transit';
  line?: string;
  vehicle?: string;
  durationText?: string;
  numStops?: number;
  headsign?: string;
}

export interface TransitResult {
  totalDuration?: string | null;
  segments: TransitSegment[];
}

// Emoji here are deliberate — friendly transit glyphs in the timeline copy.
export function vehicleEmoji(v?: string): string {
  switch ((v ?? '').toUpperCase()) {
    case 'BUS':
      return '🚌';
    case 'TRAM':
    case 'LIGHT_RAIL':
      return '🚊';
    case 'HEAVY_RAIL':
    case 'RAIL':
    case 'COMMUTER_TRAIN':
    case 'HIGH_SPEED_TRAIN':
      return '🚆';
    case 'FERRY':
      return '⛴️';
    default:
      return '🚇'; // subway / metro
  }
}

/** One-line label for a leg: "🚇 Ginza  →  🚆 JR Yamanote  ·  22 min". */
export function legText(leg: TransitResult): string {
  const transit = leg.segments.filter((s) => s.mode === 'transit');
  if (transit.length === 0) return `🚶 ${leg.totalDuration ?? 'walk'}`;
  const lines = transit.map((t) => `${vehicleEmoji(t.vehicle)} ${t.line ?? 'Line'}`).join('  →  ');
  return leg.totalDuration ? `${lines}  ·  ${leg.totalDuration}` : lines;
}

// Google Routes has no transit data for Japan — it answers empty (or a walk-only
// route), and empty answers aren't cached server-side, so every Route view there
// re-bills Google for nothing. Coarse box over the main islands; its west edge
// (129.5°E) keeps Busan/Seoul out.
const inJapan = (s: RouteStop) => s.lat >= 30 && s.lat <= 46 && s.lng >= 129.5 && s.lng <= 146;

/**
 * Public-transit directions between two stops via the cache-aside Edge Function.
 * Returns null on any failure (function not deployed yet, no Google key, no
 * transit found, or a Japan leg Google can't route) so the UI can fall back to
 * a time estimate.
 */
export async function getTransit(origin: RouteStop, dest: RouteStop): Promise<TransitResult | null> {
  if (inJapan(origin) && inJapan(dest)) return null;
  try {
    const { data, error } = await supabase.functions.invoke<TransitResult>('transit-route', {
      body: { origin: [origin.lat, origin.lng], dest: [dest.lat, dest.lng] },
    });
    if (error || !data || !data.segments?.length) return null;
    return data;
  } catch {
    return null;
  }
}
