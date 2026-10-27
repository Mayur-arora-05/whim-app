# Whim — Status Audit (2026-09-27)

Snapshot of what works, what doesn't, and what's in flight, from a full audit
session. Read after `CLAUDE.md` / `HANDOFF.md`. Update or delete sections as
items get resolved — this file is a working log, not a spec.

---

## TL;DR

- **Build 13 uploaded to TestFlight 2026-10-03** (from `main` @ PR #6 merge): saved guides sync to the account, guide discovery + creator pages, analytics, App Store 1.2 moderation pass. Next: three-person Room test (WHI-5) and device QA (WHI-11) on build 13.
- Every screen loads, no crashes, no app-log errors or warnings.
- **Transit "est." in Japan = Google coverage gap, not a bug** (confirmed §3.1).
  Japan legs now skip Google and show the estimate instantly.
- **Committed + pushed 2026-09-27:** Open in Maps fix, smart-route best start +
  2-opt, Japan transit skip, nearby-places hardening (`e88e6be..66760a6`).
- **`nearby-places` hardening deployed** 2026-09-27 and verified live (fresh
  Places lookup → 200 with results; no-JWT → 401).
- **Near Me: list on screen in ≤6 s (was ~42 s)** — two-phase load, tips
  swap in ~10–20 s later (§3.5). One app-side stall lead open.
- **Route order fixed:** hours read as constraints + best start + 2-opt
  (Tokyo example 86 → 49 km). Dashed leg connector restored.
- Near Me "showed nothing" earlier was **not a bug** — simulator location was
  unset/odd. Works fine with a real location (verified in Delhi).

---

## 1. Pending actions

- `AGENTS.md` — untracked (pre-existing), left alone.
- **2026-10-02 local Build 13 work (branch `prai2702/whi-30-…`, Linear WHI-30):** funnel instrumentation for
  Near Me, Rooms, deck completion, route views and Maps/share actions; shared
  build/platform/environment tags on events and errors; duplicate super-save
  event removed. Details and event meanings: `whim-mobile/ANALYTICS.md`.
- Related reliability fixes: explicit empty-deck load state, stale solo deck
  requests invalidated on context/reset, stale room matches/members ignored
  after exit or a newer refresh. Existing untracked `AGENTS.md` untouched.
- Validation: 11 isolated Node regression tests pass; TypeScript and targeted
  ESLint pass. No commit, push, deploy, build upload, or production data write.
  Device sharing/GPS and a three-person Room test remain outstanding.

- **2026-10-03 creator guides foundation (branch `prai2702/whi-30-…`, Linear WHI-30):** Community search by
  title/city/creator, city filters, Guides and Saved tabs; guide detail save and
  customize actions. Saved IDs persist locally per authenticated account; the
  saved shelf resolves approved guides by ID (including older feed entries)
  and excludes blocked authors. No cloud sync or payment system yet.
- Multi-day remixes preserve stop day assignments; unassigned extra stops stay
  visible. Guide detail controls use the safe-area inset and wrapping actions.
  Feed errors now surface instead of pretending an API failure is an empty feed.
- Validation: 15 isolated regression tests pass (11 existing + 4 guide tests),
  TypeScript and targeted lint pass. Simulator QA completed for guide discovery, Tokyo search,
  no-match/reset, detail, local save, Saved shelf, persistence after reload, and
  remix with all 12 stops and 3 day assignments. Real-device QA remains. No commits, deploys, public guide submissions or release upload.


JS changes need only a Metro reload — no native rebuild.

---

## 2. Verified working

### Infrastructure (live checks)
| Service | Result |
|---|---|
| Supabase project | Healthy (dashboard, free tier, nano, Tokyo). NOT paused |
| Supabase Auth | `/auth/v1/health` 200 |
| All 10 Edge Functions deployed | 401 without JWT (correct); `seed-city` 403 without secret (correct) |
| Mapbox public token (app) | Valid; styles load |
| Mapbox download token (build) | Valid |
| Expo push service | Reachable |
| GitHub Pages (privacy/reset/confirm) | 200 |
| Google Places API (New) | Google Cloud metrics: 2xx only over 4 days |
| Anthropic key | Working — Near Me returns LLM blurbs + tips |
| `tsc --noEmit` | 0 errors |
| `npm run lint` | 10 "errors" are all false positives (ESLint can't resolve Deno `jsr:` imports in `supabase/functions`); 12 warnings (§4) |

### Screens (toured via deep links `whim:///<route>` + screenshots)
All render correctly: Discover, Swipe (deck exhausted for Tokyo·Nature — expected),
Hitlist, Route, Community, Profile/Passport, Near Me, Notifications, Settings,
Friends, Your spots, Add spots, Build trip, Rooms hub, Admin analytics
("Admins only" for non-admin — correct).

---

## 3. Open issues

### 3.1 Transit "est." legs (Google Routes) — RESOLVED: Japan coverage gap
Symptom: Route screen legs show `~16 min · est.` → `transit-route` returned no
segments, app fell back to `estimateTransitMins`.

Evidence (2026-09-27):
- `transit_cache` (read-only query): **0 Japan rows ever**, despite heavy Tokyo
  use; 36 non-Japan rows (31 with real transit lines). Empty answers aren't
  cached, so Japan never produced a single route.
- Live call through the app's session (Paris, Louvre → Notre-Dame):
  `source: "google"`, 22 min — **the key works**.
- External reports (Google dev forum, other projects): Google exposes no Japan
  transit via its APIs.

Fix shipped (`7d2dae0`): `getTransit` skips the Edge Function when both stops
are in Japan → instant estimate, no wasted billed calls. A real Japan provider
(NAVITIME/Jorudan, paid) is a post-launch option.

Notes: `transit-route` returns 200 + `segments: []` for "no route" but **502
when Google errors** — the Supabase Invocations view distinguishes the two.
No `departureTime` is sent, so late-night plans anywhere may get no transit.

### 3.5 Near Me load time — two-phase (shipped 2026-09-27)
Was ~42 s of spinner. Now:
1. `phase: 'fast'` → server returns Google's results after the Places search
   (server ~2.6 s) with `enriching: true`; reviews + LLM run after the
   response via `EdgeRuntime.waitUntil` and write the enriched list to the cache.
   The raw list is never cached.
2. App shows the raw list immediately ("ADDING LOCAL TIPS" indicator), polls
   `phase: 'poll'` (cache read only — no Google, no cap) every 2.5 s, swaps in
   blurbs/tips/tags when ready. Gives up after ~30 s and keeps the raw list.
3. Location: last-known fix (≤2 min, ≤500 m) before asking for a fresh one.
Measured on the simulator (uncached spot): list visible ≤6 s, tips by ~16–24 s.
No `phase` = old one-shot behaviour, so build 11 keeps working.
LLM stage itself: parallel chunks (`2ef4d43`), ~10 s.

Tips are filled INTO the list on screen — order and membership never change
mid-scroll (reports/saves made meanwhile carry over). The LLM's re-ranking,
re-vibing and generic-spot drops show on the next load (served from cache).
Simulator note: after `simctl location set`, `simctl location clear` + set
again if the app keeps seeing the old fix.

~~Open lead: first request stalls 10–30 s~~ — **resolved 2026-09-30: measurement
artifact.** Promises started from the Metro debugger (CDP `Runtime.evaluate`) on an
idle app don't run until something wakes the JS thread; with a keep-alive timer
the same calls take 1.6–3.3 s. Any in-app timing via CDP must schedule a timer
(e.g. `setInterval(()=>{},30)`) or the numbers are meaningless.

Measuring tip: Metro's debugger (CDP) replays OLD console warnings on connect —
compare timestamps before trusting counts.

### 3.2 Smart-route stop order — RESOLVED
Best start + 2-opt (`c2704dc`) and hours-as-constraints (`167b578`): only
"best early" spots are Morning (6), opening >= 4 PM / after-dark spots are
Evening (68), the rest (incl. 258 "open(s) morning") Daytime. Tokyo example
86 → 49 km; 5,000 random plans −39%. Leg connector is now a real dashed line
(`DashedRail`, `f90b254`) — the "Unsupported dashed / dotted border" warning
is gone.

## 4. Code-quality items (lint warnings)
- `app/friends.tsx:85,89`, `app/u/[id].tsx:52` — `no-unused-expressions`; can hide
  a real bug (`cond && fn()` style). Check first.
- `app/admin-analytics.tsx:21` — `AdminAnalytics` redeclared.
- Unused: `View` in `app/room/join.tsx`, `VibeId` in `components/CollectionsShelf.tsx`,
  `dismissMatch` in `components/MicroDiscoveryModal.tsx`.
- Hook deps: `app/_layout.tsx:67,91`, `app/build-trip.tsx:120`, `app/nearby.tsx:128`,
  `app/sign-in.tsx:49`.

---

## 5. Not yet tested (need taps / accounts)
Screens were checked via deep links only; interactions weren't exercised:
swipe-to-save, check-in stamps (GPS), room create/join + realtime matches
(needs 2 accounts), publish trip, Add-your-spots submit, Build-trip place
search, push delivery, delete account (never on the real account).

---

## 6. Other observations
- Supabase dashboard: **"No backups"** on free tier → export `spots`
  (~2,770 rows, costly to regenerate) before launch, or move to Pro (also
  needed for leaked-password protection).
- Dashboard "No migrations" is expected — migrations were applied via SQL
  editor/API; `whim-mobile/supabase/migrations/` is the source of truth.
- Bundle id mismatch to be aware of: simulator dev build is `com.whim.app`,
  `app.json`/release is `com.pranjalrai.whim`.
- Build 12 still pending (15 Batch-4 cities live in DB, not in picker).

## 7. Handy commands from this session
```bash
# open any screen in the simulator app
xcrun simctl openurl booted "whim:///itinerary"     # hitlist, community, passport, nearby, settings, room, ...
# screenshot
xcrun simctl io booted screenshot /tmp/shot.png
# set simulator GPS
xcrun simctl location booted set 35.6595,139.7005
```

## 8. Simulator guide QA (2026-10-03)

Found and fixed an invisible floating tab bar: GlassNav now has one explicitly
positioned overlay container and respects the bottom safe-area inset. Verified
Community navigation works after the fix. Create a guide moved out of the cramped
header pill into its own full-width, minimum-48px action row; verified it opens
the builder. Test remix was not published. One Tokyo guide remains bookmarked
locally on the simulator. Screenshots: `~/Desktop/notion new/BeWhim-simulator-QA/`.

## 9. Creator pages + cloud-save preparation (2026-10-03 — WHI-30)

- `app/creator/[id].tsx`: creator guide storefront, newest first, 20 per page,
  load-more, loading/error/empty states. Detail links to the creator page.
  Approved content only; blocked creators are excluded. Simulator verified
  BeWhim storefront lists all 13 guides and opens another guide.
- Cloud bookmark data functions and migration `0023_saved_guides.sql` prepared:
  own-account RLS, approved/unblocked guide insert checks, cascading deletes,
  idempotent security-invoker RPC. Migration applied to production on 2026-10-03 with Pranjal’s explicit go.
- `GUIDE_CLOUD_SYNC_ENABLED` is false. The existing device library remains active.
  Live RLS verification passed 2026-10-03 (rolled-back test; see Codex handoff).
  Cloud activation still requires the device→cloud bookmark transfer and an explicit decision
  on transferring existing device bookmarks; automatic import is not implemented.
- 18 isolated Node tests, TypeScript and targeted lint pass. SQL execution and cross-account policy checks passed against the linked
  database in a rolled-back transaction: duplicate saves/removals, own-only reads
  and deletes, forged ownership, rejected/blocked guides, update and anonymous
  denial. RLS enabled; function is security invoker; zero QA rows remain.
  No commits, deploys, release upload or paid marketplace.

### Migration 0023 applied (2026-10-03)

Applied via the existing logged-in Supabase CLI to `gvqldgkdtitueyijptmt`.
Verification SQL preserved in `whim-mobile/scripts/tests/saved-guides-rls.sql`
(run only with authorization: it creates transactional fixtures before rollback).
Cloud sync remains disabled pending device-bookmark transfer implementation and
end-to-end app QA. No commit or app release upload.
