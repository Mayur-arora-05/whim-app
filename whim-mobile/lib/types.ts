// Domain model for the Whim flow. Kept framework-agnostic so the same shapes
// can be shared with Supabase row types and the (future) recommendation engine.

export type VibeId = 'classics' | 'matcha' | 'nature' | 'nightlife';

export interface Vibe {
  id: VibeId;
  label: string;
}

/** A small "micro-activity" that sits geographically next to an anchor Spot. */
export interface MicroActivity {
  id: string;
  title: string;
  kind: string; // "Coffee", "Shopping", "Viewpoint"...
  mins: number; // walking minutes from the anchor
  tone: string; // placeholder colour until real imagery loads
  photo: string; // alt / description; swap for an image URL in production
  placeId?: string; // Google place (seed-nearby) — the app shows its live photo
  lat?: number;
  lng?: number;
}

/** An anchor location shown in the swipe deck. */
export interface Spot {
  id: string;
  title: string;
  kind: string;
  area: string;
  hours: string;
  tone: string;
  photo: string; // stock fallback photo (Pexels)
  placeId?: string; // Google place_id → live real photo via the cached proxy
  tags: string[];
  desc: string;
  lat?: number;
  lng?: number;
  nearby: MicroActivity[]; // candidates surfaced in the Micro-Discovery modal
}

/**
 * The nested bucket-list node the brief describes:
 * one anchor + the micro-activities the user chose to attach to it.
 */
export interface BucketAnchor {
  anchor: Spot;
  microActivities: MicroActivity[];
  city: string; // the context this was saved under — hitlists are scoped by
  vibe: VibeId; // city + vibe, so collections never bleed across them
}

export type SwipeDirection = 'left' | 'right';
