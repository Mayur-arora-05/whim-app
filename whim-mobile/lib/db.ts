import { supabase } from './supabase';
import { track } from './analytics';
import { assertClean } from './moderation';
import type { BucketAnchor, MicroActivity, Spot, VibeId } from './types';

// Thin data-access layer over Supabase. All reads/writes are scoped to the
// logged-in user by RLS — these functions never need to pass user_id, the
// database enforces it.

function rowToSpot(row: any): Spot {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    area: row.area,
    hours: row.hours,
    tone: row.tone,
    photo: row.photo,
    placeId: row.place_id ?? undefined,
    tags: row.tags ?? [],
    desc: row.description ?? '',
    lat: row.lat ?? undefined,
    lng: row.lng ?? undefined,
    nearby: (row.nearby ?? []) as MicroActivity[],
  };
}

/** A real spot from this city+vibe's deck, for the Home featured card. Prefers
 * a spot with a Google place (its photo is of that exact place); only 13 of 63
 * cities have stock photos, and those were Pexels first-search-results that are
 * sometimes of another city. */
export async function fetchCoverPhoto(city: string, vibe: VibeId): Promise<{ photo: string | null; placeId?: string } | null> {
  const { data, error } = await supabase
    .from('spots')
    .select('photo, place_id')
    .eq('city', city)
    .contains('vibes', [vibe])
    .order('place_id', { ascending: true, nullsFirst: false })
    .limit(1);
  if (error) throw error;
  const row = data?.[0];
  if (!row) return null;
  const photo = row.photo && row.photo.startsWith('http') ? row.photo : null;
  return { photo, placeId: row.place_id ?? undefined };
}

/** Phase 1 → 2: the curated deck for a (city, vibe), straight from the DB. */
export async function fetchDeck(city: string, vibe: VibeId): Promise<Spot[]> {
  const { data, error } = await supabase
    .from('spots')
    .select('*')
    .eq('city', city)
    .contains('vibes', [vibe]);
  if (error) throw error;
  return (data ?? []).map(rowToSpot);
}

/** Phase 4: rebuild the user's nested bucket list from saved_spots ⋈ spots. */
export async function fetchSavedSpots(): Promise<BucketAnchor[]> {
  const { data, error } = await supabase
    .from('saved_spots')
    .select('spot_id, micro_activity_ids, city, vibe, spots(*)')
    .order('created_at', { ascending: true });
  if (error) throw error;

  return (data ?? [])
    .filter((row: any) => row.spots) // guard against orphaned rows
    .map((row: any) => {
      const anchor = rowToSpot(row.spots);
      const ids: string[] = row.micro_activity_ids ?? [];
      return {
        anchor,
        microActivities: anchor.nearby.filter((n) => ids.includes(n.id)),
        city: row.city ?? '',
        vibe: (row.vibe ?? 'classics') as VibeId,
      };
    });
}

/** Phase 3: persist a right-swipe (idempotent — re-saving updates the row). */
export async function saveSpot(
  spot: Spot,
  microActivityIds: string[],
  city: string,
  vibe: VibeId | null,
  via: 'swipe' | 'super' = 'swipe',
): Promise<void> {
  const { error } = await supabase
    .from('saved_spots')
    .upsert(
      { spot_id: spot.id, micro_activity_ids: microActivityIds, city, vibe },
      { onConflict: 'user_id,spot_id' },
    );
  if (error) throw error;
  track('spot_saved', { city, vibe, via });
}

export async function removeSavedSpot(spotId: string): Promise<void> {
  // RLS limits the delete to the current user's row.
  const { error } = await supabase.from('saved_spots').delete().eq('spot_id', spotId);
  if (error) throw error;
}

/** Wipe a whole collection (all saved spots for a city + vibe). */
export async function clearSavedSpots(city: string, vibe: VibeId): Promise<void> {
  const { error } = await supabase.from('saved_spots').delete().eq('city', city).eq('vibe', vibe);
  if (error) throw error;
}

// ── Group Rooms ──────────────────────────────────────────────────────────
// Creation/joining go through security-definer RPCs; votes are the only
// direct table write (own rows, members only — enforced by RLS).

export interface Room {
  id: string;
  code: string;
  hostId: string;
  name: string | null;
  city: string;
  vibe: VibeId;
  status: 'open' | 'closed';
  memberCount?: number;
}

export interface RoomMember {
  userId: string;
  displayName: string | null;
  isHost: boolean;
}

function rowToRoom(r: any): Room {
  return {
    id: r.id,
    code: r.code,
    hostId: r.host_id,
    name: r.name,
    city: r.city,
    vibe: r.vibe as VibeId,
    status: r.status,
    memberCount: r.member_count != null ? Number(r.member_count) : undefined,
  };
}

export async function createRoom(city: string, vibe: VibeId, name?: string): Promise<Room> {
  assertClean(name);
  const { data, error } = await supabase.rpc('create_room', {
    p_city: city,
    p_vibe: vibe,
    p_name: name ?? null,
  });
  if (error) throw error;
  const room = rowToRoom(data);
  track('room_created', { room_id: room.id, city: room.city, vibe: room.vibe });
  return room;
}

export async function joinRoom(code: string): Promise<Room> {
  const { data, error } = await supabase.rpc('join_room', { p_code: code });
  if (error) throw error;
  const room = rowToRoom(data);
  track('room_joined', { room_id: room.id, city: room.city, vibe: room.vibe });
  return room;
}

export async function fetchRoom(roomId: string): Promise<Room> {
  const { data, error } = await supabase.from('rooms').select('*').eq('id', roomId).single();
  if (error) throw error;
  return rowToRoom(data);
}

export async function fetchMyRooms(): Promise<Room[]> {
  const { data, error } = await supabase.rpc('my_rooms');
  if (error) throw error;
  return (data ?? []).map(rowToRoom);
}

export async function fetchRoomMembers(roomId: string): Promise<RoomMember[]> {
  const { data, error } = await supabase.rpc('get_room_members', { p_room: roomId });
  if (error) throw error;
  return (data ?? []).map((m: any) => ({
    userId: m.user_id,
    displayName: m.display_name,
    isHost: m.is_host,
  }));
}

/** Right/left swipe in a room = a vote. Idempotent (re-voting updates). */
export async function castRoomVote(roomId: string, spotId: string, liked: boolean): Promise<void> {
  const { error } = await supabase
    .from('room_votes')
    .upsert({ room_id: roomId, spot_id: spotId, liked }, { onConflict: 'room_id,user_id,spot_id' });
  if (error) throw error;
}

/** Spot ids the signed-in user has already voted on in this room. */
export async function fetchMyRoomVotes(roomId: string): Promise<string[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from('room_votes')
    .select('spot_id')
    .eq('room_id', roomId)
    .eq('user_id', user.id);
  if (error) throw error;
  return (data ?? []).map((r: any) => r.spot_id);
}

/** Spots every current member liked, with like counts. */
export async function fetchRoomMatches(roomId: string): Promise<{ spotId: string; likes: number }[]> {
  const { data, error } = await supabase.rpc('get_room_matches', { p_room: roomId });
  if (error) throw error;
  return (data ?? []).map((r: any) => ({ spotId: r.spot_id, likes: Number(r.likes) }));
}

export async function fetchSpotsByIds(ids: string[]): Promise<Spot[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase.from('spots').select('*').in('id', ids);
  if (error) throw error;
  return (data ?? []).map(rowToSpot);
}

// ── Community spots (UGC — "dump your top places") ───────────────────────
export interface CommunitySpot {
  id: string;
  title: string;
  vibe: VibeId;
  kind: string | null;
  city: string | null;
  area: string | null;
  blurb: string | null;
}

/** Submit freeform favorite places → resolved + LLM-categorized + saved. */
export async function submitPlaces(
  text: string,
): Promise<{ saved: { title: string; vibe: VibeId; blurb: string; city: string }[]; notFound: string[] }> {
  const { data, error } = await supabase.functions.invoke('submit-places', { body: { places: text } });
  if (error) {
    // surface the function's own error message when present
    const msg = (await error.context?.json?.().catch(() => null))?.error;
    throw new Error(msg || error.message);
  }
  return data;
}

/** Approved community spots near a point (for surfacing in "Around you"). */
export async function fetchNearbyCommunitySpots(
  lat: number,
  lng: number,
  radiusKm = 3,
): Promise<(CommunitySpot & { lat: number; lng: number; submittedBy: string | null })[]> {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  const { data, error } = await supabase
    .from('community_spots')
    .select('id, title, vibe, kind, city, area, blurb, lat, lng, submitted_by')
    .eq('status', 'approved')
    .gte('lat', lat - dLat)
    .lte('lat', lat + dLat)
    .gte('lng', lng - dLng)
    .lte('lng', lng + dLng)
    .limit(60);
  if (error) throw error;
  return (data ?? []).map((r: any) => ({ ...r, submittedBy: r.submitted_by ?? null }));
}

// ── "Your spots" — the user's own saved / added places ──────────────────────
export interface MySpot {
  id: string;
  title: string;
  vibe: VibeId;
  kind: string | null;
  city: string | null;
  area: string | null;
  blurb: string | null;
  lat: number | null;
  lng: number | null;
  createdAt: string;
}

/** Everything this user has saved from Near Me or added via "Add your spots". */
export async function fetchMySpots(): Promise<MySpot[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from('community_spots')
    .select('id, title, vibe, kind, city, area, blurb, lat, lng, created_at')
    .eq('submitted_by', user.id)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r: any) => ({ ...r, createdAt: r.created_at }));
}

/** Remove one of your saved spots (owner-only, enforced by RLS). */
export async function removeMySpot(id: string): Promise<void> {
  const { error } = await supabase.from('community_spots').delete().eq('id', id);
  if (error) throw error;
}

/** Flag a community spot for review (App Store 1.2 UGC moderation). */
export async function reportCommunitySpot(spotId: string, reason: string): Promise<void> {
  const { error } = await supabase.from('community_reports').insert({ spot_id: spotId, reason });
  if (error) throw error;
}

/** The current user's own submitted community spots. */
export async function fetchMyCommunitySpots(): Promise<CommunitySpot[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from('community_spots')
    .select('id, title, vibe, kind, city, area, blurb')
    .eq('submitted_by', user.id)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as CommunitySpot[];
}

// ── Published itineraries (users publish a whole day-plan for others) ─────
export interface PublishedItinerary {
  id: string;
  authorId: string;
  authorName: string | null;
  title: string;
  note: string | null;
  city: string | null;
  vibe: VibeId | null;
  stopSpotIds: string[];
  stopDays: number[] | null;
  embeddedStops: EmbeddedStop[] | null;
  stopCount: number;
  cover: string | null;
  createdAt: string;
}

// A stop stored inline on a custom (build-your-own) trip.
export interface EmbeddedStop {
  title: string;
  placeId?: string;
  spotId?: string;
  lat: number | null;
  lng: number | null;
  kind?: string;
  area?: string;
  day?: number | null;
}

// The shape the trip view renders — works for both curated and custom stops.
export interface TripStop {
  id: string;
  title: string;
  kind: string;
  area: string;
  lat: number | null;
  lng: number | null;
  day: number | null;
}

function rowToItin(r: any): PublishedItinerary {
  return {
    id: r.id,
    authorId: r.author,
    authorName: r.author_name,
    title: r.title,
    note: r.note,
    city: r.city,
    vibe: r.vibe,
    stopSpotIds: r.stop_spot_ids ?? [],
    stopDays: r.stop_days ?? null,
    embeddedStops: r.stops ?? null,
    stopCount: r.stop_count ?? (r.stop_spot_ids ?? []).length,
    cover: r.cover,
    createdAt: r.created_at,
  };
}

export interface PlaceResult {
  id: string;
  title: string;
  kind: string;
  area: string;
  city: string;
  lat: number | null;
  lng: number | null;
}

/** Search real locations for the trip builder ("add a location"). */
export async function searchPlaces(query: string, near?: { lat: number; lng: number }): Promise<PlaceResult[]> {
  const { data, error } = await supabase.functions.invoke('place-search', { body: { query, near } });
  if (error) {
    const msg = (await error.context?.json?.().catch(() => null))?.error;
    throw new Error(msg || error.message);
  }
  return (data?.results ?? []) as PlaceResult[];
}

/** Publish a build-your-own trip of arbitrary locations (any city, e.g. Goa). */
export async function publishCustomTrip(input: {
  title: string;
  city: string;
  note?: string;
  stops: EmbeddedStop[];
}): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const stops = input.stops.slice(0, 30);
  if (stops.length === 0) throw new Error('Add at least one location.');
  if (!input.title.trim()) throw new Error('Give your trip a title.');
  assertClean(input.title, input.note);
  const { data: prof } = await supabase.from('profiles').select('display_name').eq('id', user.id).maybeSingle();
  const { data, error } = await supabase
    .from('published_itineraries')
    .insert({
      author: user.id,
      author_name: prof?.display_name ?? null,
      title: input.title.trim().slice(0, 80),
      note: input.note?.trim().slice(0, 500) || null,
      city: input.city.trim() || null,
      vibe: null,
      stops,
      stop_count: stops.length,
      cover: null,
    })
    .select('id')
    .single();
  if (error) throw error;
  track('trip_published', { kind: 'custom', city: input.city, stops: stops.length });
  return data.id as string;
}

/** Publish a saved collection as a shareable itinerary. */
export async function publishItinerary(input: {
  title: string;
  note?: string;
  city: string;
  vibe: VibeId;
  spotIds: string[];
  cover?: string | null;
}): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const ids = input.spotIds.slice(0, 30);
  if (ids.length === 0) throw new Error('Add at least one spot before publishing.');
  assertClean(input.title, input.note);
  // snapshot the author's display name — profiles are read-own-only, so a feed
  // can't join to it; this is how "by <name>" renders for other viewers.
  const { data: prof } = await supabase.from('profiles').select('display_name').eq('id', user.id).maybeSingle();
  const { error } = await supabase.from('published_itineraries').insert({
    author: user.id,
    author_name: prof?.display_name ?? null,
    title: input.title.trim().slice(0, 80),
    note: input.note?.trim().slice(0, 500) || null,
    city: input.city,
    vibe: input.vibe,
    stop_spot_ids: ids,
    stop_count: ids.length,
    cover: input.cover ?? null,
  });
  if (error) throw error;
  track('trip_published', { kind: 'curated', city: input.city, stops: ids.length });
}

/** The current user's own published itineraries. */
export async function fetchMyItineraries(): Promise<PublishedItinerary[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from('published_itineraries')
    .select('*')
    .eq('author', user.id)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(rowToItin);
}

/** Unpublish / delete one of your own itineraries. */
export async function deleteMyItinerary(id: string): Promise<void> {
  const { error } = await supabase.from('published_itineraries').delete().eq('id', id);
  if (error) throw error;
}

/** A published itinerary + its stops in order — from embedded custom stops when
 *  present, else resolved from the curated catalogue. */
export async function fetchPublishedItinerary(id: string): Promise<{ itin: PublishedItinerary; stops: TripStop[] } | null> {
  const { data, error } = await supabase.from('published_itineraries').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const itin = rowToItin(data);

  if (itin.embeddedStops && itin.embeddedStops.length) {
    const stops: TripStop[] = itin.embeddedStops.map((s, i) => ({
      id: s.placeId ?? s.spotId ?? `stop-${i}`,
      title: s.title,
      kind: s.kind ?? '',
      area: s.area ?? '',
      lat: s.lat ?? null,
      lng: s.lng ?? null,
      day: s.day ?? null,
    }));
    return { itin, stops };
  }

  const resolved = await fetchSpotsByIds(itin.stopSpotIds);
  const order = new Map(itin.stopSpotIds.map((sid, i) => [sid, i] as const));
  resolved.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
  const dayBy = new Map<string, number>();
  if (itin.stopDays) itin.stopSpotIds.forEach((sid, i) => dayBy.set(sid, itin.stopDays![i] ?? 1));
  const stops: TripStop[] = resolved.map((s) => ({
    id: s.id,
    title: s.title,
    kind: s.kind,
    area: s.area,
    lat: s.lat ?? null,
    lng: s.lng ?? null,
    day: dayBy.get(s.id) ?? null,
  }));
  return { itin, stops };
}

/** Flag a published itinerary for review (App Store 1.2 UGC moderation). */
export async function reportItinerary(id: string, reason: string): Promise<void> {
  const { error } = await supabase.from('itinerary_reports').insert({ itinerary_id: id, reason });
  if (error) throw error;
}

// ── Community feed (unified: published itineraries + community spots) ─────
export type FeedItem =
  | {
      kind: 'itinerary';
      id: string;
      title: string;
      authorId: string;
      authorName: string | null;
      city: string | null;
      vibe: VibeId | null;
      stopCount: number;
      cover: string | null;
      createdAt: string;
    }
  | {
      kind: 'spot';
      id: string; // google place_id
      title: string;
      authorId: string;
      vibe: VibeId;
      city: string | null;
      area: string | null;
      blurb: string | null;
      createdAt: string;
    };

/** Who's viewing — their id and whether they're an admin (can approve UGC into
 *  the official curated catalogue). */
export async function fetchViewer(): Promise<{ id: string | null; isAdmin: boolean }> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { id: null, isAdmin: false };
  const { data } = await supabase.from('profiles').select('is_admin').eq('id', user.id).maybeSingle();
  return { id: user.id, isAdmin: !!(data as any)?.is_admin };
}

export interface AdminAnalytics {
  events: { event: string; count: number; users: number }[];
  dau: { day: string; users: number }[];
  errors: number;
  users: number;
  days: number;
}

/** Admin-only funnel summary for the in-app dashboard. Returns null if not admin. */
export async function fetchAdminAnalytics(days = 30): Promise<AdminAnalytics | null> {
  const { data, error } = await supabase.rpc('admin_analytics', { p_days: days });
  if (error) throw error;
  if (!data || (data as any).error) return null;
  return data as AdminAnalytics;
}

/** Admin-only: promote a community spot into the official curated `spots` deck. */
export async function promoteSpot(placeId: string): Promise<void> {
  const { error } = await supabase.functions.invoke('promote-spot', { body: { place_id: placeId } });
  if (error) {
    const msg = (await error.context?.json?.().catch(() => null))?.error;
    throw new Error(msg || error.message);
  }
}

/** One published_itineraries row → feed card (community feed, creator page, saved shelf). */
function itineraryFeedItem(row: any): FeedItem {
  return {
    kind: 'itinerary', id: row.id, title: row.title, authorId: row.author,
    authorName: row.author_name, city: row.city, vibe: row.vibe,
    stopCount: row.stop_count ?? 0, cover: row.cover, createdAt: row.created_at,
  };
}

/** For mixed feeds: a failed block-list read shouldn't take the whole screen down. */
function blockedUserIdsOrNone(): Promise<string[]> {
  return fetchBlockedUserIds().catch(() => [] as string[]);
}

/** Creator storefront: approved guides only; blocked creators return no content.
 * Fetch one extra row to decide whether another page exists. */
export async function fetchCreatorGuides(authorId: string, page = 0): Promise<{ items: FeedItem[]; nextPage: number | null }> {
  // Block check on the first page only (a blocked creator gets no next page).
  // Fails closed: this page is one person's content, so an error must not show it.
  if (page === 0 && (await fetchBlockedUserIds()).includes(authorId)) return { items: [], nextPage: null };
  const { data, error } = await supabase.from('published_itineraries').select('*')
    .eq('status', 'approved').eq('author', authorId)
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .range(page * 20, page * 20 + 20);
  if (error) throw error;
  const items = (data ?? []).slice(0, 20).map(itineraryFeedItem);
  return { items, nextPage: (data?.length ?? 0) > 20 ? page + 1 : null };
}

export async function fetchCloudSavedGuideIds(): Promise<string[]> {
  const { data, error } = await supabase.from('saved_guides').select('guide_id').order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(row => row.guide_id);
}

/** Idempotent save/remove; ownership comes exclusively from auth.uid() + RLS. */
export async function setCloudGuideSaved(guideId: string, saved: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_saved_guide', { p_guide_id: guideId, p_saved: saved });
  if (error) throw error;
}

/** Resolve the saved shelf by ID, including guides older than the latest feed.
 * Approved status and blocked authors use the same rules as discovery. */
export async function fetchSavedGuideFeed(ids: string[]): Promise<FeedItem[]> {
  if (!ids.length) return [];
  const blocked = new Set(await blockedUserIdsOrNone());
  const rows = [];
  for (let start = 0; start < ids.length; start += 50) {
    const { data, error } = await supabase.from('published_itineraries').select('*').eq('status', 'approved').in('id', ids.slice(start, start + 50));
    if (error) throw error;
    rows.push(...(data ?? []));
  }
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows.filter(row => !blocked.has(row.author)).map(itineraryFeedItem).sort((a, b) => (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0));
}

/** Everything the community is publishing — trips + spots — newest first,
 *  with blocked authors filtered out. */
export async function fetchCommunityFeed(): Promise<FeedItem[]> {
  const [itins, spots, blocked] = await Promise.all([
    supabase
      .from('published_itineraries')
      .select('*')
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
      .limit(60),
    supabase
      .from('community_spots')
      .select('id, title, vibe, city, area, blurb, submitted_by, created_at')
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
      .limit(60),
    blockedUserIdsOrNone(),
  ]);
  if (itins.error) throw itins.error;
  if (spots.error) throw spots.error;
  const blockedSet = new Set(blocked);
  const items: FeedItem[] = [];
  for (const r of itins.data ?? []) {
    if (blockedSet.has(r.author)) continue;
    items.push(itineraryFeedItem(r));
  }
  for (const r of spots.data ?? []) {
    if (blockedSet.has(r.submitted_by)) continue;
    items.push({
      kind: 'spot',
      id: r.id,
      title: r.title,
      authorId: r.submitted_by,
      vibe: r.vibe,
      city: r.city,
      area: r.area,
      blurb: r.blurb,
      createdAt: r.created_at,
    });
  }
  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return items;
}

// ── Room moderation (App Store Guideline 1.2 for UGC) ────────────────────

/** Flag a room member for an offensive name or behaviour. */
export async function reportRoomMember(roomId: string, reportedUserId: string, reason: string): Promise<void> {
  const { error } = await supabase
    .from('room_reports')
    .insert({ room_id: roomId, reported_user_id: reportedUserId, reason });
  if (error) throw error;
}

/** Block a user — you stop seeing their name/content anywhere. */
export async function blockUser(blockedId: string): Promise<void> {
  const { error } = await supabase.from('blocked_users').upsert({ blocked_id: blockedId }, { onConflict: 'blocker_id,blocked_id' });
  if (error) throw error;
}

export async function fetchBlockedUserIds(): Promise<string[]> {
  const { data, error } = await supabase.from('blocked_users').select('blocked_id');
  if (error) throw error;
  return (data ?? []).map((r: any) => r.blocked_id);
}

/** Remove yourself from a room. */
export async function leaveRoom(roomId: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  // RLS turns a delete it doesn't allow (e.g. a request that went out without
  // the session, mid token-refresh) into "0 rows, no error" — ask for the
  // deleted row back so a silent no-op surfaces as a failure (toast) instead of
  // the app acting as if you left while you're still a member.
  const { data, error } = await supabase
    .from('room_members')
    .delete()
    .eq('room_id', roomId)
    .eq('user_id', user.id)
    .select('user_id');
  if (error) throw error;
  if (!data?.length) throw new Error('Leave had no effect — nothing was deleted');
}

// ── Profile ──────────────────────────────────────────────────────────────
export interface Profile {
  displayName: string | null;
  username: string | null;
}

/** The signed-in user's profile row (auto-created by the signup trigger). */
export async function fetchProfile(): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles').select('display_name, username').maybeSingle();
  if (error) throw error;
  return data ? { displayName: data.display_name, username: (data as any).username ?? null } : null;
}

export async function updateDisplayName(name: string): Promise<void> {
  assertClean(name);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const { error } = await supabase.from('profiles').update({ display_name: name }).eq('id', user.id);
  if (error) throw error;
}

// ── Social: usernames, follows, badges ───────────────────────────────────
export interface UserLite {
  id: string;
  username: string | null;
  displayName: string | null;
}
export interface Badge {
  city: string;
  spotCount: number;
  tier: number;
  earnedAt: string;
  updatedAt: string;
}
const rowToBadge = (r: any): Badge => ({
  city: r.city,
  spotCount: r.spot_count,
  tier: r.tier,
  earnedAt: r.earned_at,
  updatedAt: r.updated_at,
});

/** Claim / change your public @handle. Throws a friendly error if taken/invalid. */
export async function setUsername(username: string): Promise<void> {
  const u = username.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(u)) throw new Error('Handles are 3–20 characters: letters, numbers or _.');
  assertClean(u.replace(/_/g, ' '));
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const { error } = await supabase.from('profiles').update({ username: u }).eq('id', user.id);
  if (error) {
    if ((error as any).code === '23505' || /duplicate|unique/i.test(error.message)) throw new Error('That handle is taken — try another.');
    throw error;
  }
}

/** Find people by @handle prefix (excludes yourself). */
export async function searchUsers(q: string): Promise<UserLite[]> {
  const term = q.trim().replace(/^@/, '').toLowerCase();
  if (term.length < 2) return [];
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('public_profiles')
    .select('id, username, display_name')
    .ilike('username', `${term}%`)
    .limit(12);
  if (error) throw error;
  return (data ?? [])
    .filter((r: any) => r.id !== user?.id)
    .map((r: any) => ({ id: r.id, username: r.username, displayName: r.display_name }));
}

export async function followUser(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const { error } = await supabase.from('follows').upsert({ follower: user.id, followee: id }, { onConflict: 'follower,followee' });
  if (error) throw error;
  track('user_followed');
}

export async function unfollowUser(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  const { error } = await supabase.from('follows').delete().eq('follower', user.id).eq('followee', id);
  if (error) throw error;
}

export async function fetchFollowingIds(): Promise<string[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase.from('follows').select('followee').eq('follower', user.id);
  if (error) throw error;
  return (data ?? []).map((r: any) => r.followee);
}

export async function fetchSocialCounts(): Promise<{ following: number; followers: number }> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { following: 0, followers: 0 };
  const [a, b] = await Promise.all([
    supabase.from('follows').select('followee', { count: 'exact', head: true }).eq('follower', user.id),
    supabase.from('follows').select('follower', { count: 'exact', head: true }).eq('followee', user.id),
  ]);
  return { following: a.count ?? 0, followers: b.count ?? 0 };
}

export interface Friend extends UserLite {
  badgeCount: number;
  bestTier: number;
  topCity: string | null;
}

/** People you follow, with a quick badge summary each. */
export async function fetchFriends(): Promise<Friend[]> {
  const ids = await fetchFollowingIds();
  if (!ids.length) return [];
  const [profs, badges] = await Promise.all([
    supabase.from('public_profiles').select('id, username, display_name').in('id', ids),
    supabase.from('badges').select('user_id, city, tier').in('user_id', ids),
  ]);
  const byUser = new Map<string, { city: string; tier: number }[]>();
  (badges.data ?? []).forEach((b: any) => {
    if (!byUser.has(b.user_id)) byUser.set(b.user_id, []);
    byUser.get(b.user_id)!.push({ city: b.city, tier: b.tier });
  });
  return (profs.data ?? []).map((p: any) => {
    const bs = (byUser.get(p.id) ?? []).slice().sort((x, y) => y.tier - x.tier);
    return {
      id: p.id,
      username: p.username,
      displayName: p.display_name,
      badgeCount: bs.length,
      bestTier: bs[0]?.tier ?? 0,
      topCity: bs[0]?.city ?? null,
    };
  });
}

export interface Activity extends UserLite {
  city: string;
  tier: number;
  at: string;
}

/** Recent badge earns / tier-ups from people you follow — newest first. */
export async function fetchFriendsActivity(): Promise<Activity[]> {
  const ids = await fetchFollowingIds();
  if (!ids.length) return [];
  const { data: badges, error } = await supabase
    .from('badges')
    .select('user_id, city, tier, updated_at')
    .in('user_id', ids)
    .order('updated_at', { ascending: false })
    .limit(30);
  if (error) throw error;
  const uids = [...new Set((badges ?? []).map((b: any) => b.user_id))];
  const { data: profs } = await supabase.from('public_profiles').select('id, username, display_name').in('id', uids);
  const pm = new Map((profs ?? []).map((p: any) => [p.id, p]));
  return (badges ?? []).map((b: any) => ({
    id: b.user_id,
    username: pm.get(b.user_id)?.username ?? null,
    displayName: pm.get(b.user_id)?.display_name ?? null,
    city: b.city,
    tier: b.tier,
    at: b.updated_at,
  }));
}

export async function fetchMyBadges(): Promise<Badge[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from('badges')
    .select('*')
    .eq('user_id', user.id)
    .order('tier', { ascending: false })
    .order('spot_count', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(rowToBadge);
}

/** A followed user's public profile + badges (RLS lets you read only if you follow them). */
export async function fetchUserProfileWithBadges(userId: string): Promise<{ user: UserLite; badges: Badge[] } | null> {
  const [{ data: prof }, { data: badges }] = await Promise.all([
    supabase.from('public_profiles').select('id, username, display_name').eq('id', userId).maybeSingle(),
    supabase.from('badges').select('*').eq('user_id', userId).order('tier', { ascending: false }).order('spot_count', { ascending: false }),
  ]);
  if (!prof) return null;
  return {
    user: { id: (prof as any).id, username: (prof as any).username, displayName: (prof as any).display_name },
    badges: (badges ?? []).map(rowToBadge),
  };
}

// ── Passport / check-ins ─────────────────────────────────────────────────
export interface CheckinItem {
  spotId: string;
  title: string;
  kind: string;
  area: string;
  city: string;
  tone: string;
  photo: string;
  placeId?: string;
}

export async function fetchCheckins(): Promise<CheckinItem[]> {
  const { data, error } = await supabase
    .from('checkins')
    .select('spot_id, city, spots(*)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? [])
    .filter((r: any) => r.spots)
    .map((r: any) => ({
      spotId: r.spot_id,
      title: r.spots.title,
      kind: r.spots.kind ?? '',
      area: r.spots.area ?? '',
      city: r.city ?? r.spots.city ?? '',
      tone: r.spots.tone ?? '#E7DCCB',
      photo: r.spots.photo ?? '',
      placeId: r.spots.place_id ?? undefined,
    }));
}

export async function checkIn(spotId: string, city: string, verified: boolean): Promise<void> {
  const { error } = await supabase
    .from('checkins')
    .upsert({ spot_id: spotId, city, verified }, { onConflict: 'user_id,spot_id' });
  if (error) throw error;
  track('checkin', { city, verified });
}

export async function removeCheckin(spotId: string): Promise<void> {
  const { error } = await supabase.from('checkins').delete().eq('spot_id', spotId);
  if (error) throw error;
}
