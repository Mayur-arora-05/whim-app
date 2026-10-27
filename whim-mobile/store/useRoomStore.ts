import { useEffect } from 'react';
import { create } from 'zustand';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { Spot, SwipeDirection } from '@/lib/types';
import {
  blockUser,
  castRoomVote,
  fetchBlockedUserIds,
  fetchDeck,
  fetchMyRoomVotes,
  fetchRoom,
  fetchRoomMatches,
  fetchRoomMembers,
  fetchSpotsByIds,
  leaveRoom,
  reportRoomMember,
  type Room,
  type RoomMember,
} from '@/lib/db';
import { toast } from '@/lib/toast';
import { hapticSuccess } from '@/lib/haptics';
import { track } from '@/lib/analytics';

let blockedIds = new Set<string>();
const visible = (members: RoomMember[]) => members.filter((m) => !blockedIds.has(m.userId));

export interface RoomMatch {
  spot: Spot;
  likes: number;
}

/**
 * State for the room the user is currently inside. Mirrors the solo store's
 * optimistic pattern: swipes advance instantly, the vote persists in the
 * background, and Realtime (votes + members) keeps matches live for everyone.
 */
interface RoomState {
  room: Room | null;
  members: RoomMember[];
  matches: RoomMatch[];
  deck: Spot[];
  deckIndex: number;
  deckSourceCount: number;
  loading: boolean; // initial room load (deck + members + matches)
  matchesLoaded: boolean; // first matches fetch for this room has landed

  enter: (roomId: string) => Promise<void>;
  leave: () => void;
  vote: (direction: SwipeDirection) => void;
  refreshMatches: () => Promise<void>;
  refreshMembers: () => Promise<void>;
  reportMember: (userId: string, reason: string) => void;
  blockMember: (userId: string) => void;
  leaveCurrentRoom: () => Promise<boolean>; // false = still a member (toast shown)
}

let channel: RealtimeChannel | null = null;
// bumps on every enter()/leave(): an enter() whose awaits resolve after the
// user already left (or entered another room) must not set state or subscribe
let enterGen = 0;
// distinguishes "first matches fetch after entering" (quiet) from live updates
let matchesHydrated = false;
let matchesRequest = 0;
let membersRequest = 0;

export const useRoomStore = create<RoomState>((set, get) => ({
  room: null,
  members: [],
  matches: [],
  deck: [],
  deckIndex: 0,
  deckSourceCount: 0,
  loading: false,
  matchesLoaded: false,

  enter: async (roomId) => {
    get().leave(); // drop any previous room subscription
    const gen = ++enterGen;
    const stale = () => gen !== enterGen;
    matchesHydrated = false;
    set({ room: null, members: [], matches: [], deck: [], deckIndex: 0, deckSourceCount: 0, loading: true, matchesLoaded: false });
    try {
      const room = await fetchRoom(roomId);
      const [members, all, myVotes, blocked] = await Promise.all([
        fetchRoomMembers(roomId),
        fetchDeck(room.city, room.vibe),
        fetchMyRoomVotes(roomId),
        fetchBlockedUserIds().catch(() => []),
      ]);
      if (stale()) return;
      blockedIds = new Set(blocked);
      const voted = new Set(myVotes);
      set({
        room,
        members: visible(members),
        deck: all.filter((s) => !voted.has(s.id)),
        deckSourceCount: all.length,
        loading: false,
      });
      await get().refreshMatches();
      if (stale()) return;

      // live updates: any vote or membership change re-derives the matches.
      // RLS scopes postgres_changes, so only members receive these events.
      channel = supabase
        .channel(`room-${roomId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'room_votes', filter: `room_id=eq.${roomId}` },
          () => void get().refreshMatches(),
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'room_members', filter: `room_id=eq.${roomId}` },
          () => {
            void get().refreshMembers();
            void get().refreshMatches(); // the "everyone" threshold changed
          },
        )
        .subscribe();
    } catch (e) {
      if (stale()) return;
      console.warn('[whim] enter room failed:', e);
      set({ loading: false });
      toast('Couldn’t open that room — try again.');
    }
  },

  leave: () => {
    enterGen++; // invalidate any enter() still in flight
    if (channel) {
      supabase.removeChannel(channel);
      channel = null;
    }
    set({ room: null, members: [], matches: [], deck: [], deckIndex: 0, deckSourceCount: 0, loading: false, matchesLoaded: false });
  },

  vote: (direction) => {
    const { room, deck, deckIndex } = get();
    const spot = deck[deckIndex];
    if (!room || !spot) return;
    set({ deckIndex: deckIndex + 1 }); // optimistic — deck never waits
    if (deckIndex + 1 === deck.length) {
      track('deck_finished', { mode: 'room', room_id: room.id, city: room.city, vibe: room.vibe, card_count: deck.length });
    }
    castRoomVote(room.id, spot.id, direction === 'right').catch((e) => {
      console.warn('[whim] castRoomVote failed:', e);
      toast('Couldn’t send your vote — check your connection.');
    });
  },

  refreshMatches: async () => {
    const { room } = get();
    if (!room) return;
    const gen = enterGen;
    const request = ++matchesRequest;
    try {
      const raw = await fetchRoomMatches(room.id);
      const spots = await fetchSpotsByIds(raw.map((m) => m.spotId));
      if (gen !== enterGen || request !== matchesRequest) return;
      const previous = get().matches;
      const byId = new Map(spots.map((s) => [s.id, s]));
      const matches = raw
        .filter((m) => byId.has(m.spotId))
        .map((m) => ({ spot: byId.get(m.spotId)!, likes: m.likes }));
      // celebrate matches that are new since the last refresh (quiet on the
      // initial fetch after entering, loud for live arrivals — even the first)
      const known = new Set(previous.map((m) => m.spot.id));
      const fresh = matches.filter((m) => !known.has(m.spot.id));
      if (fresh.length && matchesHydrated) {
        track('room_match', { room_id: room.id, city: room.city, vibe: room.vibe, new_match_count: fresh.length, match_count: matches.length });
        hapticSuccess();
        toast(`It’s a match ✦ ${fresh[0].spot.title}`);
      }
      matchesHydrated = true;
      set({ matches, matchesLoaded: true });
    } catch (e) {
      console.warn('[whim] refreshMatches failed:', e);
    }
  },

  refreshMembers: async () => {
    const { room } = get();
    if (!room) return;
    try {
      const gen = enterGen;
      const request = ++membersRequest;
      const members = await fetchRoomMembers(room.id);
      if (gen !== enterGen || request !== membersRequest) return;
      set({ members: visible(members) });
    } catch (e) {
      console.warn('[whim] refreshMembers failed:', e);
    }
  },

  reportMember: (userId, reason) => {
    const { room } = get();
    if (!room) return;
    reportRoomMember(room.id, userId, reason)
      .then(() => toast('Thanks — we’ll review this within 24 hours.'))
      .catch((e) => {
        console.warn('[whim] reportRoomMember failed:', e);
        toast('Couldn’t send that report — try again.');
      });
  },

  blockMember: (userId) => {
    // hide them immediately, then persist
    blockedIds.add(userId);
    set((s) => ({ members: visible(s.members) }));
    blockUser(userId)
      .then(() => toast('Blocked — you won’t see them again.'))
      .catch((e) => {
        console.warn('[whim] blockUser failed:', e);
        toast('Hidden for now, but the block didn’t save — check your connection and try again.');
      });
  },

  leaveCurrentRoom: async () => {
    const { room } = get();
    if (!room) return false;
    try {
      await leaveRoom(room.id);
      get().leave();
      return true;
    } catch (e) {
      console.warn('[whim] leaveRoom failed:', e);
      toast('Couldn’t leave the room — try again.');
      return false;
    }
  },
}));

/**
 * Make sure the room in the URL is loaded. The lobby normally enters the room
 * before pushing the group deck or plan; opened any other way (shared link,
 * notification, app restored on that screen) nothing was loaded and the plan
 * rendered blank. Enters the room if needed, and leaves it again on the way
 * out only when this screen was the one that entered.
 */
export function useEnsureRoom(roomId: string | undefined): void {
  useEffect(() => {
    const st = useRoomStore.getState();
    if (!roomId || st.room?.id === roomId || st.loading) return;
    st.enter(roomId);
    return () => useRoomStore.getState().leave();
  }, [roomId]);
}
