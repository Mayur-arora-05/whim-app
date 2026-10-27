import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import * as Location from 'expo-location';
import { fetchNearby, pollNearby, spotMeta, richMeta, type NearbyResult, type NearbySpot } from '@/lib/nearby';
import { fetchNearbyCommunitySpots, reportCommunitySpot } from '@/lib/db';
import { placePhotoSource } from '@/lib/placePhoto';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { useQueryClient } from '@tanstack/react-query';
import { useWhimStore } from '@/store/useWhimStore';
import { VIBES, VIBE_DOT } from '@/data/vibes';
import { COLORS, SHADOWS, press } from '@/lib/theme';
import { toast } from '@/lib/toast';
import { hapticSuccess } from '@/lib/haptics';
import type { VibeId } from '@/lib/types';
import { distanceKm } from '@/lib/route';
import BackButton from '@/components/BackButton';
import Icon from '@/components/Icon';
import { track } from '@/lib/analytics';

type State =
  | { kind: 'loading' }
  | { kind: 'denied' }
  | { kind: 'error' }
  | { kind: 'ready'; data: NearbyResult };

// Live "Near you" discovery — real spots around the user's GPS, sorted into
// vibes. Separate from the curated decks; these come live from Places.
export default function Nearby() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [vibe, setVibe] = useState<VibeId>('classics');
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<string | null>(null);
  const bucketList = useWhimStore((s) => s.bucketList);
  const { session } = useAuth();
  const viewerId = session?.user?.id ?? null;
  const qc = useQueryClient();

  // Personalize: open the vibe this user saves the most (one-time, on mount).
  useEffect(() => {
    const counts: Partial<Record<VibeId, number>> = {};
    for (const b of bucketList) counts[b.vibe] = (counts[b.vibe] ?? 0) + 1;
    const fav = (Object.entries(counts) as [VibeId, number][]).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (fav) setVibe(fav);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save a live nearby spot into "your spots" (compliant UGC path — resolves +
  // categorizes it server-side; it then shows as a LOCAL pick and in Community).
  const saveToSpots = async (s: NearbySpot) => {
    if (saved.has(s.id) || saving) return;
    setSaving(s.id);
    const query = s.area ? `${s.title}, ${s.area}` : s.title;
    const { data, error } = await supabase.functions.invoke<{ saved?: unknown[] }>('submit-places', { body: { places: [query], vibe } });
    setSaving(null);
    if (error || !data?.saved?.length) {
      toast('Couldn’t save that one — try again.');
      return;
    }
    setSaved((prev) => new Set(prev).add(s.id));
    hapticSuccess();
    track('nearby_saved', { vibe });
    // show it as a LOCAL pick right away, and refresh Community → "Yours"
    setState((prev) =>
      prev.kind === 'ready'
        ? {
            kind: 'ready',
            data: {
              ...prev.data,
              vibes: Object.fromEntries(
                Object.entries(prev.data.vibes).map(([k, list]) => [
                  k,
                  list.map((x) => (x.id === s.id ? { ...x, community: true } : x)),
                ]),
              ) as typeof prev.data.vibes,
            },
          }
        : prev,
    );
    qc.invalidateQueries({ queryKey: ['mySpots'] });
    qc.invalidateQueries({ queryKey: ['communityFeed'] });
    toast('Saved ✦ — find it in Profile › Your spots');
  };

  // bumps on every load/unmount so a stale enrichment poll never overwrites newer state
  const loadGen = useRef(0);
  useEffect(() => () => void loadGen.current++, []);

  const load = useCallback(async () => {
    const gen = ++loadGen.current;
    const started = Date.now();
    setState({ kind: 'loading' });
    track('nearby_started');
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (gen !== loadGen.current) return;
      if (status !== 'granted') {
        track('nearby_failed', { reason: 'permission_denied', duration_ms: Date.now() - started });
        setState({ kind: 'denied' });
        return;
      }
      // a fix from the last couple of minutes is plenty for "around you" and
      // skips the GPS wait; otherwise ask for a fresh one
      const pos =
        (await Location.getLastKnownPositionAsync({ maxAge: 120_000, requiredAccuracy: 500 })) ??
        (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
      const { latitude: lat, longitude: lng } = pos.coords;
      const [data, community] = await Promise.all([
        fetchNearby(lat, lng),
        fetchNearbyCommunitySpots(lat, lng).catch(() => []),
      ]);
      if (gen !== loadGen.current) return;
      if (!data) {
        track('nearby_failed', { reason: 'fetch_failed', duration_ms: Date.now() - started });
        setState({ kind: 'error' });
        return;
      }

      // merge community "local picks". If a spot is already in the live results,
      // badge it as LOCAL instead of dropping it; otherwise add it to the top.
      const mine = new Set<string>();
      for (const c of community) {
        const bucket = data.vibes[c.vibe as VibeId];
        if (!bucket) continue;
        if (c.submittedBy && c.submittedBy === viewerId) mine.add(c.id);
        const existing = bucket.find((s) => s.id === c.id);
        if (existing) {
          existing.community = true;
          if (c.blurb && !existing.blurb) existing.blurb = c.blurb;
          continue;
        }
        bucket.unshift({
          id: c.id, title: c.title, kind: c.kind ?? '', area: c.area ?? '',
          lat: c.lat, lng: c.lng, rating: null, ratingCount: 0, photoName: null,
          km: distanceKm({ lat, lng }, { lat: c.lat, lng: c.lng }),
          community: true, blurb: c.blurb,
        });
      }
      if (mine.size) setSaved((prev) => new Set([...prev, ...mine]));
      setState({ kind: 'ready', data });
      track('nearby_loaded', { duration_ms: Date.now() - started, spot_count: new Set(Object.values(data.vibes).flat().map((s) => s.id)).size, enriching: !!data.enriching });

      // phase 2: blurbs + tips are being written server-side — fill them into the
      // list already on screen (~10 s). Order and membership stay exactly as the
      // user sees them — no reshuffle mid-scroll — and reports/saves made in the
      // meantime carry over. The enriched ranking shows on the next (cached) load.
      if (!data.enriching) return;
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        if (gen !== loadGen.current) return;
        const full = await pollNearby(lat, lng);
        if (gen !== loadGen.current) return;
        if (full === 'pending') continue;
        if (!full) break;
        track('nearby_enriched', { duration_ms: Date.now() - started });
        const byId = new Map<string, NearbySpot>();
        for (const list of Object.values(full.vibes)) for (const s of list) byId.set(s.id, s);
        setState((prev) => {
          if (prev.kind !== 'ready') return prev;
          const vibes = { ...prev.data.vibes };
          for (const v of Object.keys(vibes) as VibeId[])
            vibes[v] = vibes[v].map((s) => {
              const e = byId.get(s.id);
              // only fill what's missing — a community pick's own blurb wins
              return e ? { ...s, blurb: s.blurb || e.blurb, tags: s.tags?.length ? s.tags : e.tags, tip: s.tip || e.tip } : s;
            });
          return { kind: 'ready', data: { ...prev.data, vibes, enriching: false } };
        });
        return;
      }
      setState((prev) => (prev.kind === 'ready' ? { kind: 'ready', data: { ...prev.data, enriching: false } } : prev));
    } catch {
      if (gen === loadGen.current) {
        track('nearby_failed', { reason: 'location_or_network', duration_ms: Date.now() - started });
        setState({ kind: 'error' });
      }
    }
  }, [viewerId]);

  const reportSpot = (s: NearbySpot) =>
    Alert.alert('Report this spot?', 'We review reports within 24 hours and remove violations.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Report',
        style: 'destructive',
        onPress: () => {
          reportCommunitySpot(s.id, 'reported from nearby').catch(() => {});
          setState((prev) =>
            prev.kind === 'ready'
              ? {
                  kind: 'ready',
                  data: {
                    ...prev.data,
                    vibes: Object.fromEntries(
                      Object.entries(prev.data.vibes).map(([k, list]) => [k, list.filter((x) => x.id !== s.id)]),
                    ) as typeof prev.data.vibes,
                  },
                }
              : prev,
          );
          toast('Thanks — we’ll review this within 24 hours.');
        },
      },
    ]);

  useEffect(() => {
    load();
  }, [load]);

  const openInMaps = (s: NearbySpot) => {
    const q = s.lat != null && s.lng != null ? `${s.lat},${s.lng}` : encodeURIComponent(s.title);
    Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${q}&query_place_id=${s.id}`).catch(() => {});
  };

  const coordLabel =
    state.kind === 'ready'
      ? `${Math.abs(state.data.center[0]).toFixed(2)}°${state.data.center[0] >= 0 ? 'N' : 'S'}  ${Math.abs(
          state.data.center[1],
        ).toFixed(2)}°${state.data.center[1] >= 0 ? 'E' : 'W'}`
      : 'LOCATING…';

  const list = state.kind === 'ready' ? state.data.vibes[vibe] ?? [] : [];

  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={['top']}>
      <View className="flex-row items-center gap-2.5 px-4 pb-1 pt-1">
        <BackButton />
        {state.kind === 'ready' && (
          <Pressable onPress={load} accessibilityLabel="Refresh" className="ml-auto rounded-full bg-white p-2.5" style={SHADOWS.soft}>
            <Icon name="pin" size={16} color={COLORS.accent} strokeWidth={2} />
          </Pressable>
        )}
      </View>

      <View className="px-5 pt-1">
        <View className="flex-row items-center gap-2">
          <View className="h-1.5 w-1.5 rounded-full bg-accent" />
          <Text className="font-mono text-[11px] tracking-[0.14em] text-accent">{coordLabel}</Text>
          {state.kind === 'ready' && state.data.enriching && (
            <View className="ml-1 flex-row items-center gap-1.5">
              <ActivityIndicator size="small" color={COLORS.muted} style={{ transform: [{ scale: 0.7 }] }} />
              <Text className="font-mono text-[11px] tracking-[0.14em] text-muted">ADDING LOCAL TIPS</Text>
            </View>
          )}
        </View>
        <Text className="mt-1 font-serif text-[32px] leading-[1.02] text-ink">Around you</Text>
        <Text className="mt-1 text-[13.5px] text-muted">Real spots near you right now — pick a vibe.</Text>
      </View>

      {/* vibe pills — same control as Home */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        // never let the list below squeeze this row (ScrollViews shrink by default,
        // which sliced the bottoms off the pills); pad so the selected shadow fits
        className="mt-3 shrink-0 grow-0"
        contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 6, gap: 10 }}
      >
        {VIBES.map((v) => {
          const on = v.id === vibe;
          const count = state.kind === 'ready' ? (state.data.vibes[v.id]?.length ?? 0) : 0;
          return (
            <Pressable
              key={v.id}
              onPress={() => setVibe(v.id)}
              style={press(on ? SHADOWS.accent : undefined)}
              className={`h-9 flex-row items-center gap-2 rounded-full border px-4 ${on ? 'border-accent bg-accent' : 'border-ink/10 bg-white'}`}
            >
              <View className="h-2 w-2 rounded-full" style={{ backgroundColor: on ? 'rgba(255,255,255,0.9)' : VIBE_DOT[v.id] }} />
              <Text className={`text-[13.5px] font-bold ${on ? 'text-white' : 'text-ink'}`}>{v.label}</Text>
              {state.kind === 'ready' && <Text className={`text-[12px] ${on ? 'text-white/80' : 'text-muted'}`}>{count}</Text>}
            </Pressable>
          );
        })}
      </ScrollView>

      {state.kind === 'loading' && (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={COLORS.accent} />
          <Text className="mt-3 text-[13px] text-muted">Finding what’s around you…</Text>
        </View>
      )}

      {state.kind === 'denied' && (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center font-serif text-[22px] text-ink">Location is off</Text>
          <Text className="mt-2.5 text-center text-[14px] leading-6 text-muted">
            Turn on location access to discover spots right around you.
          </Text>
          <Pressable onPress={() => Linking.openSettings()} className="mt-6 rounded-2xl bg-ink px-6 py-3.5">
            <Text className="text-[15px] font-semibold text-white">Open Settings</Text>
          </Pressable>
        </View>
      )}

      {state.kind === 'error' && (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center font-serif text-[22px] text-ink">Couldn’t load nearby</Text>
          <Text className="mt-2.5 text-center text-[14px] leading-6 text-muted">Check your connection and try again.</Text>
          <Pressable onPress={load} className="mt-6 rounded-2xl bg-ink px-6 py-3.5">
            <Text className="text-[15px] font-semibold text-white">Retry</Text>
          </Pressable>
        </View>
      )}

      {state.kind === 'ready' &&
        (list.length === 0 ? (
          <View className="flex-1 items-center justify-center px-8">
            <Text className="text-center font-serif text-[20px] text-ink">Nothing in this vibe nearby</Text>
            <Text className="mt-2 text-center text-[13.5px] leading-5 text-muted">Try another vibe, or refresh.</Text>
          </View>
        ) : (
          <FlatList
            data={list}
            keyExtractor={(s) => s.id}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40 }}
            initialNumToRender={8}
            maxToRenderPerBatch={8}
            windowSize={7}
            renderItem={({ item: s }) => {
              const photo = placePhotoSource({ photoName: s.photoName, placeId: s.id, w: 200 });
              return (
                <Pressable
                  onPress={() => openInMaps(s)}
                  onLongPress={s.community ? () => reportSpot(s) : undefined}
                  style={press(SHADOWS.soft)}
                  className="mb-3 flex-row items-start gap-3.5 rounded-[18px] bg-white p-3"
                >
                  <View className="h-[52px] w-[52px] overflow-hidden rounded-[13px]" style={{ backgroundColor: COLORS.accentSoft }}>
                    {/* vibe-dot placeholder sits behind, so a missing/blank photo still reads */}
                    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} className="items-center justify-center">
                      <View className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: VIBE_DOT[vibe] }} />
                    </View>
                    {photo ? (
                      <Image source={photo} style={{ width: '100%', height: '100%' }} contentFit="cover" transition={200} />
                    ) : null}
                  </View>
                  <View className="flex-1">
                    <View className="flex-row items-center gap-1.5">
                      <Text className="flex-shrink text-[15.5px] font-bold text-ink" numberOfLines={1}>
                        {s.title}
                      </Text>
                      {s.openNow === true && (
                        <View className="flex-row items-center gap-1 rounded-full bg-[#E7F5EC] px-1.5 py-0.5">
                          <View className="h-1.5 w-1.5 rounded-full bg-[#1F9D57]" />
                          <Text className="font-mono text-[8.5px] tracking-wide text-[#1F9D57]">OPEN</Text>
                        </View>
                      )}
                      {s.openNow === false && (
                        <Text className="font-mono text-[8.5px] tracking-wide text-muted">CLOSED</Text>
                      )}
                      {s.community && (
                        <View className="rounded-full bg-accent/12 px-1.5 py-0.5">
                          <Text className="font-mono text-[8.5px] tracking-wide text-accent">LOCAL ✦</Text>
                        </View>
                      )}
                    </View>

                    {s.blurb ? (
                      <Text className="mt-0.5 text-[12.5px] leading-[16px] text-ink/70" numberOfLines={2}>
                        {s.blurb}
                      </Text>
                    ) : null}

                    {(() => {
                      const base = s.blurb ? richMeta(s) : `${s.kind}${spotMeta(s) ? `  ·  ${spotMeta(s)}` : ''}`;
                      const meta = [base, s.openNow && s.closesAt ? `closes ${s.closesAt}` : ''].filter(Boolean).join('  ·  ');
                      return meta ? (
                        <Text className="mt-1 font-mono text-[10px] tracking-wide text-muted" numberOfLines={1}>
                          {meta}
                        </Text>
                      ) : null;
                    })()}

                    {s.tags && s.tags.length > 0 ? (
                      <View className="mt-1.5 flex-row flex-wrap gap-1.5">
                        {s.tags.map((t) => (
                          <View key={t} className="rounded-full bg-ink/[0.06] px-2 py-0.5">
                            <Text className="text-[10.5px] text-muted">{t}</Text>
                          </View>
                        ))}
                      </View>
                    ) : null}

                    {s.tip ? (
                      <Text className="mt-1.5 text-[11.5px] leading-[15px] text-accent" numberOfLines={2}>
                        ✦ {s.tip}
                      </Text>
                    ) : null}
                  </View>
                  <Pressable
                    onPress={() => saveToSpots(s)}
                    hitSlop={8}
                    accessibilityLabel={saved.has(s.id) ? 'Saved to your spots' : 'Save to your spots'}
                    className="p-1"
                  >
                    {saving === s.id ? (
                      <ActivityIndicator size="small" color={COLORS.accent} />
                    ) : (
                      <Icon name={saved.has(s.id) ? 'starFilled' : 'star'} size={20} color={COLORS.accent} strokeWidth={2} />
                    )}
                  </Pressable>
                </Pressable>
              );
            }}
            ListFooterComponent={
              <Text className="mt-4 text-center font-mono text-[10.5px] tracking-[0.08em] text-muted">
                LIVE ✦ tap to open in Maps · long-press a LOCAL pick to report
              </Text>
            }
          />
        ))}
    </SafeAreaView>
  );
}
