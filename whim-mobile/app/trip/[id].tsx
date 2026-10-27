import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { useSavedGuides } from '@/lib/useSavedGuides';
import { track } from '@/lib/analytics';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { fetchPublishedItinerary, reportItinerary, blockUser, deleteMyItinerary, type PublishedItinerary, type TripStop } from '@/lib/db';
import { supabase } from '@/lib/supabase';
import { googleMapsDirectionsUrl, type RouteStop } from '@/lib/route';
import RouteMap from '@/components/RouteMap';
import { VIBE_DOT } from '@/data/vibes';
import { COLORS, SHADOWS, press } from '@/lib/theme';
import { toast } from '@/lib/toast';
import { hideBlockedAuthor } from '@/lib/blockCache';
import { useQueryClient } from '@tanstack/react-query';
import BackButton from '@/components/BackButton';
import Icon from '@/components/Icon';
import DashedRail from '@/components/DashedRail';

type State =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'missing' }
  | { kind: 'ready'; itin: PublishedItinerary; stops: TripStop[]; mine: boolean };

// Read-only view of a published itinerary — resolves the author's ordered spot
// ids back to full spots, maps the route, and lists the stops in order.
export default function Trip() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();
  const saved = useSavedGuides();
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const [res, { data: { user } }] = await Promise.all([
        fetchPublishedItinerary(String(id)),
        supabase.auth.getUser(),
      ]);
      if (!res) {
        setState({ kind: 'missing' });
        return;
      }
      setState({ kind: 'ready', itin: res.itin, stops: res.stops, mine: user?.id === res.itin.authorId });
    } catch {
      setState({ kind: 'error' });
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (state.kind === 'loading') {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-canvas">
        <ActivityIndicator color={COLORS.accent} />
      </SafeAreaView>
    );
  }
  if (state.kind === 'error' || state.kind === 'missing') {
    return (
      <SafeAreaView className="flex-1 bg-canvas" edges={['top']}>
        <View className="flex-row items-center px-4 pt-1">
          <BackButton />
        </View>
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center font-serif text-[22px] text-ink">
            {state.kind === 'missing' ? 'This trip is no longer available' : 'Couldn’t load this trip'}
          </Text>
          <Text className="mt-2.5 text-center text-[14px] leading-6 text-muted">
            {state.kind === 'missing' ? 'It may have been unpublished or removed.' : 'Check your connection and try again.'}
          </Text>
          {state.kind === 'error' && (
            <Pressable onPress={load} className="mt-6 rounded-2xl bg-ink px-6 py-3.5">
              <Text className="text-[15px] font-semibold text-white">Retry</Text>
            </Pressable>
          )}
        </View>
      </SafeAreaView>
    );
  }

  const { itin, stops, mine } = state;
  const official = itin.authorName === 'BeWhim';

  // global stop number (matches the map pins) is the position in the full list
  const indexOf = new Map(stops.map((s, i) => [s.id, i] as const));
  const toRoute = (list: TripStop[]): RouteStop[] =>
    list
      .filter((s) => s.lat != null && s.lng != null)
      .map((s) => ({ id: s.id, title: s.title, kind: s.kind, lat: s.lat as number, lng: s.lng as number, order: (indexOf.get(s.id) ?? 0) + 1 }));
  const mapStops = toRoute(stops);

  // group into days when stops carry a per-stop day number
  const dayVals = stops.map((s) => s.day).filter((d): d is number => d != null);
  const multiDay = new Set(dayVals).size > 1;
  const dayNums = multiDay ? [...new Set(dayVals)].sort((a, b) => a - b) : [0];
  if (multiDay && stops.some(s => s.day == null)) dayNums.push(0);
  const groups = dayNums.map((d) => ({ day: d, stops: d === 0 ? (multiDay ? stops.filter(s => s.day == null) : stops) : stops.filter((s) => s.day === d) }));

  const remix = () => { track('guide_remix_started', { guide_id: itin.id }); router.push(`/build-trip?from=${itin.id}`); };

  const openRoute = (list: TripStop[]) => {
    const url = googleMapsDirectionsUrl(toRoute(list));
    if (url) Linking.openURL(url).catch(() => toast('Couldn’t open Maps. Try again.'));
  };
  const openStop = (s: TripStop) =>
    Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${s.title} ${itin.city ?? ''}`)}&query_place_id=${s.id}`).catch(() => {});

  const moderate = () => {
    if (mine) {
      Alert.alert('Unpublish this trip?', 'It will be removed from the community feed. This can’t be undone.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unpublish',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteMyItinerary(itin.id);
              qc.invalidateQueries({ queryKey: ['communityFeed'] });
              toast('Trip unpublished.');
              router.back();
            } catch {
              toast('Couldn’t unpublish — try again.');
            }
          },
        },
      ]);
      return;
    }
    Alert.alert('Report or block?', 'We review reports within 24 hours and remove violations.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Block this person',
        style: 'destructive',
        onPress: async () => {
          try {
            await blockUser(itin.authorId);
            hideBlockedAuthor(qc, itin.authorId);
            toast('Blocked — you won’t see their content.');
            router.back();
          } catch {
            toast('Couldn’t block — check your connection and try again.');
          }
        },
      },
      {
        text: 'Report trip',
        style: 'destructive',
        onPress: async () => {
          try {
            await reportItinerary(itin.id, 'reported from trip view');
            toast('Thanks — we’ll review this within 24 hours.');
            router.back();
          } catch {
            toast('Couldn’t send the report — check your connection and try again.');
          }
        },
      },
    ]);
  };

  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={[]}>
      <RouteMap key={itin.id} stops={mapStops} height={260} />

      <View style={{ top: insets.top + 8 }} className="absolute left-4 right-4 flex-row items-center justify-between">
        <BackButton />
        <View className="flex-row items-center gap-2">
          <Pressable
            onPress={moderate}
            accessibilityLabel={mine ? 'Unpublish' : 'Report'}
            className="h-9 items-center justify-center rounded-full bg-white/95 px-3.5"
            style={SHADOWS.soft}
          >
            <Text className="text-[12.5px] font-semibold text-ink">{mine ? 'Unpublish' : 'Report'}</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView className="flex-1 px-5 pt-5" contentContainerStyle={{ paddingBottom: 60 }} showsVerticalScrollIndicator={false}>
        <View className="flex-row items-center gap-2">
          <Icon name="route" size={14} color={COLORS.accent} strokeWidth={2.2} />
          <Text className="font-mono text-[11px] tracking-[0.16em] text-accent">
            {official ? "BEWHIM · EDITORS’ PICK" : 'COMMUNITY GUIDE'}
          </Text>
        </View>
        <Text className="mt-2 font-serif text-[27px] leading-[1.06] text-ink">{itin.title}</Text>
        <View className="mt-2 flex-row items-center gap-1.5">
          {itin.vibe && !multiDay && <View className="h-2 w-2 rounded-full" style={{ backgroundColor: VIBE_DOT[itin.vibe] }} />}
          <Text className="font-mono text-[10.5px] uppercase tracking-wide text-muted">
            {itin.authorName ? `by ${itin.authorName} · ` : ''}
            {multiDay ? `${new Set(dayVals).size} days · ` : ''}
            {stops.length} stops
            {itin.city ? ` · ${itin.city}` : ''}
          </Text>
        </View>
        <Pressable onPress={() => router.push(`/creator/${itin.authorId}`)} accessibilityRole="button" className="mt-2 min-h-[44px] flex-row items-center gap-2 self-start py-2">
          <Icon name="person" size={16} color={COLORS.accent} />
          <Text className="flex-shrink text-[13px] font-semibold text-accent">More guides by {itin.authorName || 'this creator'}</Text>
          <Icon name="arrowRight" size={14} color={COLORS.accent} />
        </Pressable>
        {itin.note ? <Text className="mt-3 text-[14.5px] leading-6 text-ink/80">{itin.note}</Text> : null}

        <View className="mt-4 flex-row flex-wrap gap-2">
          <Pressable onPress={remix} style={press(SHADOWS.accent)} className="min-h-[48px] flex-row items-center justify-center gap-2 rounded-2xl bg-accent px-4 py-3">
            <Icon name="route" size={16} color={COLORS.canvas} />
            <Text className="text-[14px] font-semibold text-white">Customize this guide</Text>
          </Pressable>
          <Pressable onPress={() => saved.toggle(itin.id)} disabled={saved.busy || saved.loading || saved.error}
            accessibilityRole="button" accessibilityState={{ selected: saved.ids.includes(itin.id), disabled: saved.busy || saved.loading || saved.error }}
            className="min-h-[48px] flex-row items-center justify-center gap-2 rounded-2xl border border-ink/10 bg-white px-4 py-3">
            <Icon name={saved.ids.includes(itin.id) ? 'heartFilled' : 'heart'} size={16} color={COLORS.accent} />
            <Text className="text-[14px] font-semibold text-ink">{saved.busy ? 'Saving…' : saved.ids.includes(itin.id) ? 'Saved guide' : 'Save guide'}</Text>
          </Pressable>
        </View>
        {saved.error ? <Pressable onPress={() => saved.retry()} className="py-3"><Text className="text-[12px] text-accent">Couldn’t read saved guides. Tap to retry.</Text></Pressable> : <Text className="mt-2 text-[11px] text-muted">Free to customize · {saved.synced ? 'saved guides sync to your account' : 'saved guides stay on this device'}</Text>}

        {!multiDay && mapStops.length > 0 && (
          <Pressable
            onPress={() => openRoute(stops)}
            style={press(SHADOWS.accent)}
            className="mt-4 h-[52px] flex-row items-center justify-center gap-2 rounded-2xl bg-ink"
          >
            <Icon name="arrowRight" size={16} color="#fff" strokeWidth={2.2} />
            <Text className="text-[15px] font-semibold text-white">Open route in Maps</Text>
          </Pressable>
        )}

        {groups.map((g) => (
          <View key={g.day} className="mt-6">
            {multiDay && (
              <View className="mb-3 flex-row items-center justify-between">
                <View className="flex-row items-center gap-2.5">
                  <View className="rounded-lg bg-accent px-2.5 py-1">
                    <Text className="font-mono text-[10.5px] font-bold tracking-[0.12em] text-white">{g.day === 0 ? 'EXTRA STOPS' : `DAY ${g.day}`}</Text>
                  </View>
                  <Text className="font-serif text-[17px] text-ink">
                    {g.stops[0]?.area || itin.city} & around
                  </Text>
                </View>
                <Pressable onPress={() => openRoute(g.stops)} hitSlop={8} className="flex-row items-center gap-1">
                  <Text className="text-[12px] font-semibold text-accent">Maps</Text>
                  <Icon name="arrowRight" size={13} color={COLORS.accent} strokeWidth={2.4} />
                </Pressable>
              </View>
            )}
            {g.stops.map((s, idx) => (
              <View key={s.id}>
                {idx > 0 && (
                  <View className="my-1 ml-3.5 h-5">
                    <DashedRail />
                  </View>
                )}
                <Pressable
                  onPress={() => openStop(s)}
                  style={press(SHADOWS.soft)}
                  className="flex-row items-center gap-3 rounded-2xl bg-white p-3.5"
                >
                  <View className="h-7 w-7 items-center justify-center rounded-full bg-accent">
                    <Text className="text-[13px] font-bold text-white">{(indexOf.get(s.id) ?? 0) + 1}</Text>
                  </View>
                  <View className="flex-1">
                    <Text className="font-serif text-[16.5px] text-ink" numberOfLines={1}>{s.title}</Text>
                    <Text className="text-xs text-muted" numberOfLines={1}>
                      {[s.kind, s.area].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                  <Icon name="arrowRight" size={15} color="#B6B1A9" strokeWidth={2} />
                </Pressable>
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
