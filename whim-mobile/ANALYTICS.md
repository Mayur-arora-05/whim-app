# Build 13 funnel instrumentation

Local implementation, 2026-10-02. Uses the existing analytics_events and
error_logs tables. No schema change, SDK, or deployment is required for these
client changes. Ship them in an approved app build.

## Shared context

Every event's props and every error's context contains app_version,
build_number (string or null), build_source (native/manifest/unknown),
environment (development/release), and platform. Installed iOS/Android build
values take precedence over manifest fallbacks. Settings uses the same label.

New funnel events do not include GPS coordinates, room invite codes, names,
search text, or emails. Room events include room_id for conversion analysis;
existing RLS supplies the authenticated user identity. Writes are best-effort
and cannot throw back into the user's flow.

## Event meanings

| Event | Trigger / interpretation |
| --- | --- |
| deck_started | Solo context load starts; includes empty decks and failed requests. |
| deck_finished | Final available card is swiped (solo or room), not a visit to an empty deck. Solo undo/re-swipe does not count twice. This measures the interaction, not confirmation that every background write succeeded. |
| spot_saved | Save succeeded in the database; via=swipe or super. A super-save emits only this event, once per successful save operation. |
| checkin | Existing event after a successful persisted check-in; includes verified. |
| room_created | Create-room RPC succeeds. Includes room_id, city and vibe. |
| room_joined | Join-room RPC succeeds. Rejoining can emit again; deduplicate user/room pairs when measuring membership conversion. |
| room_match | This client observes newly arriving matches after initial hydration. Includes new_match_count. Multiple members may observe the same match; event count is not a count of unique global matches. |
| room_invite_share_requested | User opens the native text-share flow. |
| room_invite_shared | Native text-share API reports sharedAction. It does not prove delivery, opening, or installation; Android's reporting is less specific than iOS. |
| route_viewed | Once per focused visit, once data is ready. Includes mode and stop_count; zero means the empty route state. Realtime updates do not count extra views. |
| open_in_maps | OS accepts the Maps URL. It does not prove arrival or successful navigation inside Maps. |
| plan_share_requested | After capture and sharing-availability checks, immediately before opening Expo's image share sheet. Expo does not expose completed-versus-cancelled sharing, so this is not named plan_shared. |
| nearby_started | Near Me load starts, including refresh. |
| nearby_loaded | The list data is ready for display. duration_ms includes permission, GPS and data lookup; it is not a precise screen-paint measurement. Includes unique spot_count and enriching. No event for stale results after unmount or another load. |
| nearby_failed | Current request fails or location access is denied; reason is a fixed category, without raw location/error text. |
| nearby_enriched | Tips arrive for the active list. duration_ms is measured from the original load start. |
| nearby_saved | The nearby submit/save request returns a saved item. |

Existing app_open, trip_published, and user_followed events remain.

## Reading the funnel

Filter new rows to environment=release for tester/product analysis. Keep
historical untagged rows separate: they cannot reliably be classified. The
existing admin dashboard shows event totals and distinct users but does not
filter development data or compute conversion/latency percentiles yet. Its new
labels alone do not change that backend aggregation.

For Near Me compare starts, loaded lists, failed loads and saves; inspect list
latency separately from tips latency. For Rooms group by room_id and distinct
user_id to examine creation, joining, finishing decks, route views and Maps
handoffs. These events do not yet measure invite-link opens or final group-plan
confirmation; those belong to the upcoming invite/Room features.

## Local verification

Run from whim-mobile:

```sh
node --test scripts/tests/build13.test.cjs
./node_modules/.bin/tsc --noEmit
```

The Node tests transpile the actual TypeScript modules and replace only service
boundaries/device modules. Unexpected imports fail closed; no production
requests are made. Coverage includes build fallbacks, telemetry failures,
persistence-success events, completion/undo/empty decks, stale city loads,
account reset, room exit during entry, and out-of-order realtime updates.

Device sharing, real GPS timings and a three-person Room session still require
real-device QA. These local checks are not a replacement for that testing.


Creator-guide foundation (2026-10-03):
- `guide_saved`: emitted only after local storage succeeds; `guide_id` and
  `storage: device`. This is a device bookmark, not a synced collection.
- `guide_remix_started`: emitted when Customize this guide opens the trip
  builder; it does not mean a remix was published.
