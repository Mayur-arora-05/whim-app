import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BucketAnchor, MicroActivity, Spot, SwipeDirection, VibeId } from '@/lib/types';
import {
  checkIn,
  clearSavedSpots,
  fetchCheckins,
  fetchDeck,
  fetchProfile,
  fetchSavedSpots,
  removeCheckin,
  removeSavedSpot,
  saveSpot,
  updateDisplayName,
  type CheckinItem,
  type Profile,
} from '@/lib/db';
import { getDeck as getMockDeck } from '@/data/mockDeck';
import { track } from '@/lib/analytics';
import { notifyBadgeEarned } from '@/lib/push';
import { toast } from '@/lib/toast';
import { isNearSpot } from '@/lib/verifyLocation';

// Swipe history is scoped per collection so clearing / re-dealing one
// city+vibe never affects another.
const ctxKey = (city: string, vibe: VibeId) => `${city}|${vibe}`;

/**
 * Single source of truth for the whole user loop (Phases 1–4).
 *
 * State is updated optimistically for snappy UI, and persisted to Supabase in
 * the background. If a write fails (e.g. offline, or spots not seeded yet) the
 * local state still works and we just warn — the next hydrate reconciles.
 */
interface WhimState {
  city: string;
  vibe: VibeId;
  deck: Spot[];
  deckIndex: number;
  deckSourceCount: number; // spots available for this context, before filtering decided ones
  deckLoaded: boolean;
  deckFinished: boolean;
  deckLoading: boolean;
  passedIds: Record<string, string[]>; // per-collection swipe-away history (session only)
  history: { spotId: string; direction: SwipeDirection }[]; // this deck session, for Undo
  pendingMatch: Spot | null;
  bucketList: BucketAnchor[];
  checkins: CheckinItem[];
  profile: Profile | null;
  hydrated: boolean;
  notificationsSeen: boolean;

  setContext: (city: string, vibe: VibeId) => Promise<void>;
  renameProfile: (name: string) => void;
  toggleCheckin: (spot: Spot, city: string) => Promise<void>;
  setCity: (city: string) => void;
  setVibe: (vibe: VibeId) => void;
  markNotificationsSeen: () => void;
  hydrate: () => Promise<void>;
  swipeLeft: () => void;
  swipeRight: () => void;
  superSave: () => void;
  undoLast: () => void;
  dismissMatch: () => void;
  saveAnchorOnly: () => void;
  saveAnchorWithActivities: (activities: MicroActivity[]) => void;
  removeAnchor: (anchorId: string) => void;
  clearCollection: () => void;
  reset: () => void;
}

function finishedDeck(s: WhimState): boolean {
  if (s.deckFinished || !s.deck.length || s.deckIndex + 1 < s.deck.length) return s.deckFinished;
  track('deck_finished', { mode: 'solo', city: s.city, vibe: s.vibe, card_count: s.deck.length });
  return true;
}

let deckGeneration = 0;

export const useWhimStore = create<WhimState>()(
  persist(
    (set, get) => ({
  city: 'Tokyo',
  vibe: 'classics',
  deck: [],
  deckIndex: 0,
  deckSourceCount: 0,
  deckLoaded: false,
  deckFinished: false,
  deckLoading: false,
  passedIds: {},
  history: [],
  pendingMatch: null,
  bucketList: [],
  checkins: [],
  profile: null,
  hydrated: false,
  notificationsSeen: false,

  setContext: async (city, vibe) => {
    const generation = ++deckGeneration;
    set({ city, vibe, deck: [], deckIndex: 0, history: [], deckLoaded: false, deckFinished: false, deckLoading: true });
    track('deck_started', { city, vibe });
    let all: Spot[] = [];
    try {
      all = await fetchDeck(city, vibe);
    } catch (e) {
      console.warn('[whim] fetchDeck failed, using mock:', e);
    }
    if (generation !== deckGeneration) return;
    // dev fallback only for Tokyo, so other cities correctly show "no spots"
    if (all.length === 0 && city === 'Tokyo') all = getMockDeck(city, vibe);
    // deck memory: skip spots already saved (in this collection) or passed
    const s = get();
    const saved = s.bucketList.filter((b) => b.city === city && b.vibe === vibe).map((b) => b.anchor.id);
    const decided = new Set<string>([...(s.passedIds[ctxKey(city, vibe)] ?? []), ...saved]);
    const deck = all.filter((sp) => !decided.has(sp.id));
    set({ deck, deckSourceCount: all.length, deckLoaded: true, deckLoading: false });
  },

  setCity: (city) => {
    if (city === get().city) return;
    deckGeneration++;
    set({ city, deck: [], deckIndex: 0, deckSourceCount: 0, deckLoaded: false, deckFinished: false, deckLoading: false, history: [], pendingMatch: null });
  },
  setVibe: (vibe) => {
    if (vibe === get().vibe) return;
    deckGeneration++;
    set({ vibe, deck: [], deckIndex: 0, deckSourceCount: 0, deckLoaded: false, deckFinished: false, deckLoading: false, history: [], pendingMatch: null });
  },
  markNotificationsSeen: () => set({ notificationsSeen: true }),

  hydrate: async () => {
    try {
      const [bucketList, checkins, profile] = await Promise.all([
        fetchSavedSpots(),
        fetchCheckins(),
        fetchProfile(),
      ]);
      set({ bucketList, checkins, profile, hydrated: true });
    } catch (e) {
      console.warn('[whim] hydrate failed:', e);
      set({ hydrated: true });
    }
  },

  renameProfile: (name) => {
    const trimmed = name.trim().slice(0, 60);
    if (!trimmed) return;
    set((s) => ({ profile: { displayName: trimmed, username: s.profile?.username ?? null } }));
    updateDisplayName(trimmed).catch((e) => {
      console.warn('[whim] updateDisplayName failed:', e);
      toast('Couldn’t save your name — check your connection.');
    });
  },

  toggleCheckin: async (spot, city) => {
    const isIn = get().checkins.some((c) => c.spotId === spot.id);
    if (isIn) {
      set((s) => ({ checkins: s.checkins.filter((c) => c.spotId !== spot.id) }));
      removeCheckin(spot.id).catch((e) => {
        console.warn('[whim] removeCheckin failed:', e);
        toast('Couldn’t remove that stamp — check your connection.');
      });
    } else {
      // a stamp means "I was actually there" — verify proximity (~250 m).
      // Dev builds skip the gate (simulator GPS is mocked) but stamp unverified.
      let verified = false;
      const proximity = await isNearSpot(spot);
      if (proximity === 'near') verified = true;
      else if (!__DEV__) {
        toast(
          proximity === 'far'
            ? 'Too far away — get closer to stamp this one.'
            : 'Turn on location access to stamp check-ins.',
        );
        return;
      }
      const item: CheckinItem = {
        spotId: spot.id,
        title: spot.title,
        kind: spot.kind,
        area: spot.area,
        city,
        tone: spot.tone,
        photo: spot.photo,
      };
      set((s) => ({ checkins: [item, ...s.checkins] }));
      checkIn(spot.id, city, verified)
        .then(() => {
          // crossing 1 / 3 / 5 spots in a city earns Bronze / Silver / Gold —
          // let this user's followers know (server verifies the badge).
          const n = get().checkins.filter((c) => c.city === city).length;
          if (n === 1 || n === 3 || n === 5) notifyBadgeEarned(city);
        })
        .catch((e) => {
          console.warn('[whim] checkIn failed:', e);
          toast('Couldn’t stamp that check-in — check your connection.');
        });
    }
  },

  swipeLeft: () =>
    set((s) => {
      const spot = s.deck[s.deckIndex];
      if (!spot) return s;
      const key = ctxKey(s.city, s.vibe);
      return {
        deckIndex: s.deckIndex + 1,
        deckFinished: finishedDeck(s),
        passedIds: { ...s.passedIds, [key]: [...(s.passedIds[key] ?? []), spot.id] },
        history: [...s.history, { spotId: spot.id, direction: 'left' }],
      };
    }),

  swipeRight: () =>
    set((s) => {
      const spot = s.deck[s.deckIndex];
      if (!spot) return s;
      return {
        deckIndex: s.deckIndex + 1,
        deckFinished: finishedDeck(s),
        pendingMatch: spot,
        history: [...s.history, { spotId: spot.id, direction: 'right' }],
      };
    }),

  // Quick-save: a "super save" that adds the top card straight to the hitlist
  // without opening the Micro-Discovery modal — for spots you're already sure of.
  superSave: () => {
    const { deck, deckIndex, city, vibe } = get();
    const spot = deck[deckIndex];
    if (!spot) return;
    set((s) => ({
      deckIndex: s.deckIndex + 1,
      deckFinished: finishedDeck(s),
      history: [...s.history, { spotId: spot.id, direction: 'right' }],
      bucketList: [...s.bucketList, { anchor: spot, microActivities: [], city, vibe }],
      notificationsSeen: false,
    }));
    saveSpot(spot, [], city, vibe, 'super').catch((e) => {
      console.warn('[whim] superSave failed:', e);
      toast('Couldn’t save that spot — check your connection.');
    });
  },

  // Undo the last swipe: step the deck back one and reverse its effect —
  // a pass is un-remembered; a save (right / super) is removed again.
  undoLast: () =>
    set((s) => {
      const last = s.history[s.history.length - 1];
      if (!last || s.deckIndex === 0) return s;
      const key = ctxKey(s.city, s.vibe);
      const patch: Partial<WhimState> = {
        deckIndex: s.deckIndex - 1,
        history: s.history.slice(0, -1),
        pendingMatch: null,
      };
      if (last.direction === 'left') {
        patch.passedIds = { ...s.passedIds, [key]: (s.passedIds[key] ?? []).filter((id) => id !== last.spotId) };
      } else if (s.bucketList.some((b) => b.anchor.id === last.spotId)) {
        // it was actually saved (super-save, or right-swipe confirmed in the modal)
        patch.bucketList = s.bucketList.filter((b) => b.anchor.id !== last.spotId);
        removeSavedSpot(last.spotId).catch((e) => console.warn('[whim] undo removeSavedSpot failed:', e));
      }
      return patch;
    }),

  dismissMatch: () => set({ pendingMatch: null }),

  saveAnchorOnly: () => {
    const { pendingMatch, city, vibe } = get();
    if (!pendingMatch) return;
    set((s) => ({
      bucketList: [...s.bucketList, { anchor: pendingMatch, microActivities: [], city, vibe }],
      pendingMatch: null,
      notificationsSeen: false,
    }));
    saveSpot(pendingMatch, [], city, vibe).catch((e) => {
      console.warn('[whim] saveSpot failed:', e);
      toast('Couldn’t save that spot — check your connection.');
    });
  },

  saveAnchorWithActivities: (activities) => {
    const { pendingMatch, city, vibe } = get();
    if (!pendingMatch) return;
    set((s) => ({
      bucketList: [...s.bucketList, { anchor: pendingMatch, microActivities: activities, city, vibe }],
      pendingMatch: null,
      notificationsSeen: false,
    }));
    saveSpot(pendingMatch, activities.map((a) => a.id), city, vibe).catch((e) => {
      console.warn('[whim] saveSpot failed:', e);
      toast('Couldn’t save that spot — check your connection.');
    });
  },

  removeAnchor: (anchorId) => {
    set((s) => ({ bucketList: s.bucketList.filter((b) => b.anchor.id !== anchorId) }));
    removeSavedSpot(anchorId).catch((e) => {
      console.warn('[whim] removeSavedSpot failed:', e);
      toast('Couldn’t remove that spot — check your connection.');
    });
  },

  // Delete the current city+vibe collection and forget swipe history, so the
  // deck deals fresh from the top next time.
  clearCollection: () => {
    deckGeneration++;
    const { city, vibe } = get();
    set((s) => {
      // forget swipe history for THIS collection only — others keep theirs
      const { [ctxKey(city, vibe)]: _cleared, ...rest } = s.passedIds;
      return {
        bucketList: s.bucketList.filter((b) => !(b.city === city && b.vibe === vibe)),
        passedIds: rest,
        deck: [],
        deckIndex: 0,
        deckSourceCount: 0,
        deckLoaded: false,
        deckFinished: false,
        deckLoading: false,
      };
    });
    clearSavedSpots(city, vibe).catch((e) => {
      console.warn('[whim] clearSavedSpots failed:', e);
      toast('Couldn’t clear this collection — check your connection.');
    });
  },

  reset: () => {
    deckGeneration++;
    set({ vibe: 'classics', deck: [], deckIndex: 0, deckSourceCount: 0, deckLoaded: false, deckFinished: false, deckLoading: false, passedIds: {}, history: [], pendingMatch: null, bucketList: [], checkins: [], profile: null, hydrated: false, notificationsSeen: false });
  },
    }),
    {
      name: 'whim-store',
      storage: createJSONStorage(() => AsyncStorage),
      // Persist only the user's own content so the Hitlist, Passport and profile
      // are available with no connection (offline / abroad). Deck + session state
      // stay transient; hydrate() reconciles with Supabase when back online.
      partialize: (s) => ({
        city: s.city,
        vibe: s.vibe,
        bucketList: s.bucketList,
        checkins: s.checkins,
        profile: s.profile,
        passedIds: s.passedIds,
      }),
    },
  ),
);

// Derived selectors (kept here so components don't recompute):
export const selectActiveSpot = (s: WhimState): Spot | undefined => s.deck[s.deckIndex];
export const selectDeckDone = (s: WhimState): boolean =>
  s.deckSourceCount > 0 && s.deckIndex >= s.deck.length;

// Hitlists are scoped to a single city + vibe ("collection"), so switching vibe
// or city shows a different list and they never mix.
export const scopedBucket = (bucketList: BucketAnchor[], city: string, vibe: VibeId): BucketAnchor[] =>
  bucketList.filter((b) => b.city === city && b.vibe === vibe);
