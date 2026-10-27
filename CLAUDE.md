# Whim

> **Product name: BeWhim** — use it in every user-facing string (app UI, `docs/`
> pages, notifications, App Store listing, website). "Whim" survives only as an
> internal identifier: repo, bundle id `com.pranjalrai.whim`, `whim://` scheme,
> Xcode project, store names (`useWhimStore`). Never rename those — a new bundle
> id is a different App Store app.

A travel-discovery iOS app: swipe through curated spots for a city + "vibe", save
the ones you like into a **Hitlist**, and get an auto-sequenced day plan you can
route on a map and share. Think "Tinder for places to go." Target: the App Store.

> **Continuing this project? Read `HANDOFF.md` next** — non-negotiable security
> rules (with the incidents behind them), the App Store compliance map, pipeline
> runbooks, and how the user likes to work. `ROADMAP.md` has the phased plan.
> **`STATUS.md`** is the latest audit (what works / what's broken / uncommitted
> changes / next steps) — read it before picking up open issues.

> **Repo layout:** this git repo (`whim-app`) is a small monorepo. The Expo app
> lives in **`whim-mobile/`** — that's where you run every command. `.agents/`
> holds installed design skills (see [Design](#design)). `docs/` is the GitHub
> Pages site: `index.html` (email-confirm landing, the auth `site_url`),
> `reset.html` (password reset form — target of `resetPasswordForEmail`), and
> `privacy.html` (the Privacy Policy linked from Settings).

---

## Running the app

All commands run from `whim-mobile/`:

```bash
cd whim-mobile
npm run start      # expo start (Metro dev server on :8081)
npm run ios        # expo run:ios — native dev build on the simulator
npm run lint       # expo lint
```

This app uses **native modules** (Mapbox, notifications, Apple auth), so it needs
a **dev build** — it does **not** run in plain Expo Go. Use `npm run ios` (or an
already-installed dev build + `npm run start`). The simulator target in use is an
iPhone 17 Pro; the launched app bundle id is `com.whim.app`.

Env vars (never commit these — see [Security](#security)):
- `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` — client, safe to ship
- `MAPBOX_DOWNLOAD_TOKEN` — build-time only (native SDK download), injected via `app.config.js`

---

## Tech stack

- **Expo SDK 52** + **expo-router v4** (file-based routing, new architecture on)
- **React Native 0.76**, React 18
- **NativeWind v4** (Tailwind for RN) — styling via `className`
- **Zustand** — single app store (`store/useWhimStore.ts`)
- **Supabase** — Postgres + Auth + Edge Functions, all tables behind **RLS**
- **Mapbox** (`@rnmapbox/maps`) — the day-plan map
- **Reanimated + Gesture Handler** — the swipe deck
- Native: `expo-location`, `expo-notifications` (local), `expo-apple-authentication`,
  `expo-secure-store`, `expo-haptics`, `expo-sharing` + `react-native-view-shot`

---

## Architecture

### Routing (`app/`)
File-based via expo-router. `app/_layout.tsx` is the root: it loads fonts, wires
providers (SafeArea, BottomSheet, GestureHandler, `AuthProvider`), mounts the
`ToastHost`, and acts as the **auth gate** — redirects to `sign-in` when logged
out (remembering the intended route and resuming it after sign-in, so invite
deep links survive), and deep-links notification taps through an allowlist.

**Navigation model:** four **tab roots** — `index` (Discover), `hitlist`,
`itinerary` (Route), `passport` (Profile) — each renders `GlassNav` and **no
back button**. Everything else (`swipe`, `notifications`, `settings`, `room/*`)
is a **pushed screen**: renders `BackButton`, no GlassNav. Don't mix the two
patterns. `onboarding` is pre-auth (shown once via `lib/onboarding.ts` flag,
before the sign-in gate).

**Opening moment:** app icon + native splash are the cobalt "W ✦" postmark
(`assets/icon.png` / `splash-icon.png`, generated from SVG with Bricolage —
regenerate via sharp, don't hand-edit). `_layout.tsx` holds the native splash
(`preventAutoHideAsync`), then `AnimatedSplash` renders the identical frame and
plays the Hinge-style stamp animation before revealing the app. Changing
icon/splash assets requires `expo prebuild` + a native rebuild.

**Check-ins are verified:** stamping requires GPS proximity (~250 m,
`lib/verifyLocation.ts`); `__DEV__` bypasses the gate (simulator) but stamps
`verified=false`. Public/Strava-style stats must count verified stamps only.

### State (`store/useWhimStore.ts`)
One Zustand store is the source of truth for the whole user loop. It updates
**optimistically** for a snappy UI, then persists to Supabase in the background;
if a write fails it warns and the next `hydrate()` reconciles. Key concepts:
- **Context** = `city` + `vibe`. Switching either deals a different deck and shows
  a different Hitlist — collections never bleed across contexts.
- **Deck memory**: spots already saved or passed this session are filtered out
  (`passedIds` is keyed per collection, so clearing one never touches another).
- **`profile`** (display name) hydrates alongside the lists; sign-up captures the
  name into `profiles.display_name` via the signup trigger.
- Selectors (`selectActiveSpot`, `selectDeckDone`, `scopedBucket`) live in the store file.
- Failed background writes surface a toast (`lib/toast.ts`) — never fail silently.

### Data layer (`lib/`)
- `supabase.ts` — the client (anon key only). Sessions persist in the iOS Keychain
  (chunked expo-secure-store adapter), falling back to AsyncStorage on unsigned dev
  builds that lack the keychain entitlement.
- `db.ts` — thin typed data-access over Supabase. **Never passes `user_id`** —
  RLS scopes every read/write to the logged-in user automatically.
- `auth.tsx` — `AuthProvider` / `useAuth`; wipes in-memory state when the user
  identity changes so one account never sees another's data.
- `route.ts` — `orderSmart()`: buckets saved spots into morning/daytime/evening by
  opening hours, then nearest-neighbour walks each block. Pure, framework-agnostic.
- `types.ts` — domain model (`Spot`, `MicroActivity`, `BucketAnchor`, `VibeId`).
- `geocode.ts`, `mapbox.ts`, `transit.ts`, `notify.ts`, `haptics.ts` — helpers.

### Backend (`supabase/`)
- `migrations/` — schema, applied in order. Every table has **RLS enabled** with
  explicit policies (default-deny). `spots` is public-read, client-write-never.
  `saved_spots`, `checkins` are own-rows-only. A signup trigger auto-creates a
  `profiles` row.
- `functions/` — Edge Functions (`search-place`, `transit-route`, `delete-account`)
  run server-side with the service key for things the client must not do directly.

### The user loop (the "phases" referenced in code)
1. Pick city + vibe → fetch curated deck (`fetchDeck`).
2. Swipe the deck; right-swipe → `pendingMatch`.
3. Save anchor (± nearby micro-activities) → `saved_spots` (the Hitlist).
4. Rehydrate the nested Hitlist; sequence it into a day plan; map + share it.
Check-ins (the "Passport") record spots actually visited.

---

## Design

**System — "Field Notes" (v2):** editorial travel-journal look.
- Type: **Bricolage Grotesque** (display/headings) + **IBM Plex Mono** (labels/coords).
- Color: cobalt **`#2740E0`** accent on a warm paper canvas **`#F0EEE8`**, ink `#17150F`.
- This replaced an earlier AI-generic cream/serif/terracotta direction — do **not**
  reintroduce serifs (Fraunces/Playfair are still in deps but are legacy; prefer Bricolage).
- Tailwind tokens live in `tailwind.config.js` (`bg-canvas`, etc.).

**Design skill — `design-taste-frontend`** (installed via `npx skills add Leonxlnx/taste-skill`,
lives in `.agents/skills/`). It's an anti-slop frontend skill: reads the brief, infers a
non-templated design direction, audit-first on redesigns, strict pre-flight check.
- **Use it** when building or redesigning any new screen/component, so UI stays on the
  premium "Field Notes" bar and never drifts back to generic AI defaults.
- Feed it the existing system above as the constraint — it should *extend* Field Notes
  (Bricolage + cobalt + paper), not invent a fresh palette.
- The pinned v1 is also installed as `design-taste-frontend-v1` if exact-legacy behavior
  is ever needed; other taste skills in `.agents/skills/` (imagegen, brandkit, etc.) are
  image-only references, not code generators.

---

## Security

- **Only the anon/publishable Supabase key ships in the app.** It's public by design
  and safe *only* because every table has RLS. **Never** put the `service_role`/secret
  key in client code — that belongs in Edge Functions.
- Secrets come from env vars, never hardcoded. `EXPO_PUBLIC_*` vars are inlined at build
  time — fine for the anon key, never for a real secret.
- `.gitignore` already excludes `.env*`, `.claude/`, `.agents/`, `skills-lock.json`,
  and `supabase/.temp/`. Keep it that way.
- New tables **must** enable RLS with explicit policies before shipping.

---

## Group Rooms ("swipe places together")

> **Status: v1 built** (migration `0007_rooms.sql`, applied to prod). Friends
> create a **room**, everyone swipes the same city/vibe deck, and spots
> **everyone** likes become live **group matches**. Tinder-style "it's a match",
> for a friend group's trip.

**How it works**
1. Host creates a room from the hub (`app/room/index.tsx`) using the current
   Discover context → gets a 6-char **invite code** (lookalike-free alphabet).
2. Friends join by code, or via the invite deep link `whim://room/join?code=…`
   (`app/room/join.tsx`; the auth gate resumes the route after sign-in).
3. Lobby (`app/room/[id]/index.tsx`): code card (tap to share), live member
   chips, live matches list. Group deck (`app/room/[id]/swipe.tsx`) reuses the
   presentational `SwipeDeck`; a right-swipe **upserts a vote** (`room_votes`).
   No micro-discovery in rooms — the group decides anchors, detours stay personal.
4. A spot matches when its like-count ≥ **current member count**
   (`get_room_matches` RPC). Votes/membership stream over **Realtime**
   (`postgres_changes`, RLS-scoped) → `useRoomStore` re-derives matches; new
   matches get a haptic + "It's a match ✦" toast.

**Backend shape (0007):** `rooms`, `room_members`, `room_votes` — all RLS-enabled,
default-deny. Reads require membership via the `is_room_member()` security-definer
helper (avoids recursive policies). Rooms are created/joined ONLY through
security-definer RPCs (`create_room`, `join_room` — 12-member cap, open rooms only);
votes are the only direct client write (own rows). `get_room_members` returns
display names without loosening profiles' own-row RLS. All RPCs are revoked from
`anon`. Realtime publication covers `room_votes` + `room_members`.

**State:** `store/useRoomStore.ts` — one room at a time (`enter`/`leave` own the
realtime channel), optimistic votes, matches enriched via `fetchSpotsByIds`.

5. **Group day-plan** (`app/room/[id]/plan.tsx`): matches → `orderSpots()` →
   hours-smart sequence with transit legs, `RouteMap`, Open in Maps, and the
   `ShareCard` ("crew of N"). Plan/transit helpers are shared with the solo
   itinerary via `lib/route.ts` + `lib/transit.ts`.

**Not yet built:** majority thresholds, host controls (close room, kick), leave-room.

---

## Conventions & gotchas

- Data access goes through `lib/db.ts`; don't scatter raw Supabase calls in components.
- Never pass `user_id` from the client — RLS handles ownership.
- Keep new state optimistic + background-persisted, matching the store pattern;
  toast on persist failure.
- Style with NativeWind `className`; pull colors from Tailwind tokens, not hex literals
  in JSX. For JS-side values (icon colors, shadows) use `lib/theme.ts` (`COLORS`,
  `SHADOWS`, `press`); vibe labels/dots/featured content live in `data/vibes.ts` only.
- `SwipeDeck` is presentational (props in, `onSwipe` out) — wire it to a store in the
  host screen. Reuse it for the group deck; don't fork it.
- Pushed screens use the shared `BackButton`; icons come from `components/Icon.tsx`
  (no emoji glyphs for UI chrome).
- Native module added? It needs a rebuild (`npm run ios`), not just a Metro reload.
- Local notifications only (no Apple Push account) — works on the simulator.
