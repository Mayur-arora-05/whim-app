import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import { useLocalSearchParams } from 'expo-router';
import { useEnsureRoom, useRoomStore } from '@/store/useRoomStore';
import { estimateTransitMins, googleMapsDirectionsUrl, orderSpots } from '@/lib/route';
import { getTransit, legText, type TransitResult } from '@/lib/transit';
import { VIBE_LABEL } from '@/data/vibes';
import RouteMap from '@/components/RouteMap';
import ShareCard from '@/components/ShareCard';
import BackButton from '@/components/BackButton';
import Icon from '@/components/Icon';
import DashedRail from '@/components/DashedRail';
import { track } from '@/lib/analytics';
import { useRouteAnalytics } from '@/lib/useRouteAnalytics';
import { toast } from '@/lib/toast';
import { COLORS } from '@/lib/theme';

// The Rooms payoff — the group's matches sequenced into one shared day:
// hours-smart order, transit legs, map, Open in Maps, and a shareable card.
// Same engine as the solo itinerary; the input is what EVERYONE liked.
export default function RoomPlan() {
  const { id } = useLocalSearchParams<{ id: string }>();
  useEnsureRoom(id);
  const room = useRoomStore((s) => s.room);
  const matches = useRoomStore((s) => s.matches);
  const members = useRoomStore((s) => s.members);
  const matchesLoaded = useRoomStore((s) => s.matchesLoaded);

  const stops = useMemo(() => orderSpots(matches.map((m) => m.spot)), [matches]);
  useRouteAnalytics('room', room?.city, room?.vibe, stops.length, !!room && matchesLoaded, room?.id);

  const [legs, setLegs] = useState<Record<number, TransitResult | null>>({});

  useEffect(() => {
    let cancelled = false;
    setLegs({});
    if (stops.length < 2) return;
    (async () => {
      const entries = await Promise.all(
        stops.slice(0, -1).map((s, i) => getTransit(s, stops[i + 1]).then((r) => [i, r] as const)),
      );
      if (!cancelled) setLegs(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [stops]);

  const renderConnector = (idx: number) => {
    const loaded = idx in legs;
    const leg = legs[idx];
    let label: string;
    if (!loaded) label = 'Finding transit…';
    else if (leg) label = legText(leg);
    else label = `🚇 ~${estimateTransitMins(stops[idx], stops[idx + 1])} min · est.`;
    return (
      <View className="my-1 ml-3.5 flex-row items-center py-1 pl-4">
        <DashedRail />
        <View className="rounded-full bg-[#EFEBE3] px-3 py-1.5">
          <Text className="text-[11.5px] font-medium text-muted">{label}</Text>
        </View>
      </View>
    );
  };

  const openInMaps = () => {
    const url = googleMapsDirectionsUrl(stops);
    if (url) Linking.openURL(url)
      .then(() => track('open_in_maps', { mode: 'room', room_id: room?.id, city: room?.city, vibe: room?.vibe, stop_count: stops.length }))
      .catch(() => toast('Couldn’t open Maps.'));
  };

  const shareRef = useRef<View>(null);
  const shareTrip = async () => {
    try {
      const uri = await captureRef(shareRef, { format: 'png', quality: 1, result: 'tmpfile' });
      if (await Sharing.isAvailableAsync()) {
        track('plan_share_requested', { mode: 'room', room_id: room?.id, city: room?.city, vibe: room?.vibe, stop_count: stops.length });
        await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Share your crew’s day' });
      }
    } catch (e) {
      console.warn('[whim] share failed:', e);
    }
  };

  if (!room) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-canvas">
        <ActivityIndicator color={COLORS.accent} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={[]}>
      <RouteMap key={room.id} stops={stops} height={280} />

      {/* back floats over the map — this is a pushed screen */}
      <View className="absolute left-4 top-14 z-10">
        <BackButton />
      </View>

      <ScrollView className="flex-1 px-5 pt-5" contentContainerStyle={{ paddingBottom: 60 }}>
        <View className="flex-row items-center gap-2">
          <View className="h-1.5 w-1.5 rounded-full bg-accent" />
          <Text className="font-mono text-[11px] tracking-[0.14em] text-accent">
            CREW OF {members.length} ✦ {room.code}
          </Text>
        </View>
        <Text className="mt-1.5 font-serif text-2xl text-ink">The day you all agreed on</Text>
        <Text className="mt-1 text-[13px] text-muted">
          {stops.length} matched stop{stops.length === 1 ? '' : 's'} · {room.city} · {VIBE_LABEL[room.vibe]}
        </Text>

        {stops.length > 0 && (
          <View className="mb-5 mt-3 flex-row gap-2.5">
            <Pressable
              onPress={openInMaps}
              className="h-[52px] flex-1 flex-row items-center justify-center gap-2 rounded-2xl bg-ink"
            >
              <Icon name="arrowRight" size={16} color="#fff" strokeWidth={2.2} />
              <Text className="text-[15px] font-semibold text-white">Open in Maps</Text>
            </Pressable>
            <Pressable
              onPress={shareTrip}
              accessibilityLabel="Share the day plan"
              className="h-[52px] w-[52px] items-center justify-center rounded-2xl border border-ink/12 bg-white"
            >
              <Icon name="share" size={20} strokeWidth={2} />
            </Pressable>
          </View>
        )}

        {stops.map((stop, idx) => (
          <View key={stop.id}>
            {idx > 0 && renderConnector(idx - 1)}
            <View className="flex-row items-center gap-3 rounded-2xl bg-white p-3.5 shadow-sm shadow-black/5">
              <View className="h-7 w-7 items-center justify-center rounded-full bg-accent">
                <Text className="text-[13px] font-bold text-white">{stop.order}</Text>
              </View>
              <View className="flex-1">
                <Text className="font-serif text-[16.5px] text-ink">{stop.title}</Text>
                <Text className="text-xs text-muted">{stop.kind}</Text>
              </View>
              {stop.bestTime && (
                <View className="rounded-full bg-accent/12 px-2.5 py-1">
                  <Text className="text-[10.5px] font-bold uppercase tracking-wide text-accent">{stop.bestTime}</Text>
                </View>
              )}
            </View>
          </View>
        ))}
      </ScrollView>

      {/* off-screen card captured for sharing */}
      <View ref={shareRef} collapsable={false} style={{ position: 'absolute', left: -9999, top: 0 }}>
        <ShareCard city={room.city} vibeLabel={`${VIBE_LABEL[room.vibe]} · crew of ${members.length}`} stops={stops} />
      </View>
    </SafeAreaView>
  );
}
