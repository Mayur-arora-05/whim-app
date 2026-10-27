import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import { router } from 'expo-router';
import Icon from '@/components/Icon';
import ShareCard from '@/components/ShareCard';
import { scheduleTripReminder } from '@/lib/notify';
import { publishItinerary } from '@/lib/db';
import { toast } from '@/lib/toast';
import { useQueryClient } from '@tanstack/react-query';
import { VIBE_LABEL } from '@/data/vibes';
import { COLORS, SHADOWS, press } from '@/lib/theme';
import { useWhimStore, scopedBucket } from '@/store/useWhimStore';
import { estimateTransitMins, googleMapsDirectionsUrl, orderByProximity } from '@/lib/route';
import { getTransit, legText, type TransitResult } from '@/lib/transit';
import RouteMap from '@/components/RouteMap';
import DashedRail from '@/components/DashedRail';
import { track } from '@/lib/analytics';
import { useRouteAnalytics } from '@/lib/useRouteAnalytics';

// Phase 4 — Itinerary. Orders the saved anchors, maps them, lists them as a
// timeline, and shows the transit connection (real line names via Google, or a
// time estimate as a fallback) between each pair of stops.
export default function ItineraryScreen() {
  const bucketList = useWhimStore((s) => s.bucketList);
  const city = useWhimStore((s) => s.city);
  const vibe = useWhimStore((s) => s.vibe);
  const clearCollection = useWhimStore((s) => s.clearCollection);
  const checkins = useWhimStore((s) => s.checkins);
  const toggleCheckin = useWhimStore((s) => s.toggleCheckin);

  const scoped = useMemo(() => scopedBucket(bucketList, city, vibe), [bucketList, city, vibe]);
  const stops = useMemo(() => orderByProximity(scoped), [scoped]);
  const byId = useMemo(() => Object.fromEntries(scoped.map((b) => [b.anchor.id, b])), [scoped]);

  const hydrated = useWhimStore((s) => s.hydrated);
  useRouteAnalytics('solo', city, vibe, stops.length, hydrated);

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
      .then(() => track('open_in_maps', { mode: 'solo', city, vibe, stop_count: stops.length }))
      .catch(() => toast('Couldn’t open Maps.'));
  };

  // ── publish this trip to the community feed ──────────────────────────────
  const qc = useQueryClient();
  const [pubOpen, setPubOpen] = useState(false);
  const [pubTitle, setPubTitle] = useState('');
  const [pubNote, setPubNote] = useState('');
  const [pubBusy, setPubBusy] = useState(false);
  // shown inline: a toast would render behind the publish Modal on iOS
  const [pubError, setPubError] = useState<string | null>(null);

  const doPublish = async () => {
    const title = pubTitle.trim();
    if (!title) {
      setPubError('Give your trip a title.');
      return;
    }
    setPubBusy(true);
    setPubError(null);
    try {
      await publishItinerary({
        title,
        note: pubNote,
        city,
        vibe,
        spotIds: stops.map((s) => s.id),
        cover: byId[stops[0]?.id]?.anchor.photo ?? null,
      });
      qc.invalidateQueries({ queryKey: ['communityFeed'] });
      setPubOpen(false);
      setPubTitle('');
      setPubNote('');
      toast('Published to the community ✦');
    } catch (e: any) {
      setPubError(e?.message || 'Couldn’t publish — try again.');
    } finally {
      setPubBusy(false);
    }
  };

  const shareRef = useRef<View>(null);
  const shareTrip = async () => {
    try {
      const uri = await captureRef(shareRef, { format: 'png', quality: 1, result: 'tmpfile' });
      if (await Sharing.isAvailableAsync()) {
        track('plan_share_requested', { mode: 'solo', city, vibe, stop_count: stops.length });
        await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Share your BeWhim day' });
      }
    } catch (e) {
      console.warn('[whim] share failed:', e);
    }
  };

  const remindMe = async () => {
    const when = await scheduleTripReminder(city, VIBE_LABEL[vibe], stops.length);
    if (when) {
      Alert.alert('Reminder set 🔔', `We’ll nudge you tomorrow at 9:00 AM about your ${city} day.`);
    } else {
      Alert.alert('Notifications are off', 'Enable notifications in Settings to get a reminder about your trip.');
    }
  };

  const confirmClear = () =>
    Alert.alert(
      'Delete this itinerary?',
      `This clears all ${stops.length} stops and lets you build a new route. This can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete & start fresh', style: 'destructive', onPress: () => clearCollection() },
      ],
    );

  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={[]}>
      {/* key by collection so switching city/vibe REMOUNTS the native map
          instead of mutating its ShapeSource across a different route —
          the in-place swap flashed the old city's pins and could crash. */}
      <RouteMap key={`${city}|${vibe}`} stops={stops} height={280} />

      <ScrollView className="flex-1 px-5 pt-5" contentContainerStyle={{ paddingBottom: 120 }}>
        <Text className="font-serif text-2xl text-ink">Your optimised day</Text>
        <Text className="mt-1 text-[13px] text-muted">{stops.length} stops · timed by opening hours & transit</Text>

        {stops.length === 0 && (
          <View className="mt-6 items-center rounded-[20px] border border-dashed border-ink/15 px-6 py-8">
            <Text className="text-center font-serif text-[19px] text-ink">
              No {VIBE_LABEL[vibe]} spots saved in {city} yet
            </Text>
            <Text className="mt-2 text-center text-[13.5px] leading-5 text-muted">
              Swipe right on a few places and BeWhim sequences them into a day — timed by opening hours, with transit between stops.
            </Text>
            <Pressable
              onPress={() => router.navigate('/')}
              style={press()}
              className="mt-5 h-[48px] flex-row items-center justify-center gap-2 rounded-full bg-ink px-6"
            >
              <Text className="text-[15px] font-semibold text-white">Find spots to save</Text>
              <Icon name="arrowRight" size={15} color="#fff" strokeWidth={2.2} />
            </Pressable>
          </View>
        )}

        {stops.length > 0 && (
          <View className="mt-3">
            <View className="flex-row gap-2.5">
              <Pressable
                onPress={openInMaps}
                className="h-[52px] flex-1 flex-row items-center justify-center gap-2 rounded-2xl bg-ink"
              >
                <Icon name="arrowRight" size={16} color="#fff" strokeWidth={2.2} />
                <Text className="text-[15px] font-semibold text-white">Open in Maps</Text>
              </Pressable>
              <Pressable
                onPress={shareTrip}
                accessibilityLabel="Share day"
                className="h-[52px] w-[52px] items-center justify-center rounded-2xl border border-ink/12 bg-white"
              >
                <Icon name="share" size={20} color={COLORS.ink} strokeWidth={2} />
              </Pressable>
              <Pressable
                onPress={remindMe}
                accessibilityLabel="Remind me"
                className="h-[52px] w-[52px] items-center justify-center rounded-2xl border border-ink/12 bg-white"
              >
                <Icon name="bell" size={20} color={COLORS.ink} strokeWidth={2} />
              </Pressable>
            </View>
            <Pressable
              onPress={() => setPubOpen(true)}
              style={press(SHADOWS.accent)}
              className="mt-2.5 h-[52px] flex-row items-center justify-center gap-2 rounded-2xl bg-accent"
            >
              <Text className="text-[15px] font-semibold text-white">Publish this trip ✦</Text>
            </Pressable>
            <Text className="mb-5 mt-1.5 text-center text-[11.5px] text-muted">
              Share your route with the BeWhim community
            </Text>
          </View>
        )}

        {stops.map((stop, idx) => {
          const entry = byId[stop.id];
          return (
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
                {entry && (
                  <Pressable
                    onPress={() => toggleCheckin(entry.anchor, city)}
                    hitSlop={8}
                    accessibilityLabel="Check in"
                    className={`h-9 w-9 items-center justify-center rounded-full border ${
                      checkins.some((c) => c.spotId === stop.id) ? 'border-accent bg-accent' : 'border-ink/15 bg-white'
                    }`}
                  >
                    <Icon name="check" size={16} color={checkins.some((c) => c.spotId === stop.id) ? '#fff' : '#C9C4BC'} strokeWidth={2.6} />
                  </Pressable>
                )}
              </View>

              {entry?.microActivities.map((a) => (
                <View
                  key={a.id}
                  className="ml-8 mt-2 flex-row items-center gap-2 rounded-xl border border-[#F0ECE3] bg-white px-3 py-2.5"
                >
                  <View className="h-1.5 w-1.5 rounded-full bg-accent" />
                  <Text className="text-sm font-semibold text-ink">{a.title}</Text>
                  <Text className="text-[11.5px] text-muted">· {a.mins} min</Text>
                </View>
              ))}
            </View>
          );
        })}

        {/* destructive action lives below the plan, away from Publish */}
        {stops.length > 0 && (
          <Pressable onPress={confirmClear} className="mt-8 items-center py-2">
            <Text className="text-[13px] font-semibold text-[#D23B2C]">Delete itinerary & start fresh</Text>
          </Pressable>
        )}
      </ScrollView>


      {/* off-screen card captured for sharing */}
      <View ref={shareRef} collapsable={false} style={{ position: 'absolute', left: -9999, top: 0 }}>
        <ShareCard city={city} vibeLabel={VIBE_LABEL[vibe]} stops={stops} />
      </View>

      {/* publish sheet */}
      <Modal visible={pubOpen} transparent animationType="slide" onRequestClose={() => setPubOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 justify-end">
          <Pressable className="absolute inset-0 bg-black/40" onPress={() => !pubBusy && setPubOpen(false)} />
          <View className="rounded-t-[26px] bg-canvas px-5 pb-9 pt-3">
            <View className="mb-4 h-1 w-10 self-center rounded-full bg-ink/15" />
            <View className="flex-row items-center gap-2">
              <View className="h-1.5 w-1.5 rounded-full bg-accent" />
              <Text className="font-mono text-[11px] tracking-[0.16em] text-accent">PUBLISH TO COMMUNITY</Text>
            </View>
            <Text className="mt-2 font-serif text-[24px] text-ink">Name your trip</Text>
            <Text className="mt-1 text-[13px] text-muted">
              {city} · {stops.length} stops · visible to everyone on BeWhim.
            </Text>

            <TextInput
              value={pubTitle}
              onChangeText={(t) => {
                setPubTitle(t);
                setPubError(null);
              }}
              placeholder={`e.g. “${city} in a day”`}
              placeholderTextColor="#B6B1A9"
              maxLength={80}
              className="mt-4 rounded-2xl border border-ink/10 bg-white px-4 py-3.5 text-[16px] text-ink"
            />
            <TextInput
              value={pubNote}
              onChangeText={(t) => {
                setPubNote(t);
                setPubError(null);
              }}
              placeholder="Add a note (optional) — who it’s for, the vibe, a tip…"
              placeholderTextColor="#B6B1A9"
              maxLength={500}
              multiline
              className="mt-3 min-h-[84px] rounded-2xl border border-ink/10 bg-white px-4 py-3.5 text-[14.5px] leading-6 text-ink"
              style={{ textAlignVertical: 'top' }}
            />
            {pubError && (
              <Text accessibilityRole="alert" className="mt-2 text-[13px] text-[#D23B2C]">
                {pubError}
              </Text>
            )}

            <Pressable
              onPress={doPublish}
              disabled={pubBusy || !pubTitle.trim()}
              style={press(SHADOWS.accent)}
              className={`mt-4 h-14 flex-row items-center justify-center gap-2 rounded-full ${pubTitle.trim() ? 'bg-accent' : 'bg-[#C9C4BC]'}`}
            >
              {pubBusy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Text className="text-[16px] font-bold text-white">Publish</Text>
                  <Icon name="arrowRight" size={16} color="#fff" strokeWidth={2.4} />
                </>
              )}
            </Pressable>
            <Pressable onPress={() => !pubBusy && setPubOpen(false)} className="mt-2 items-center py-2">
              <Text className="text-[13.5px] font-semibold text-muted">Cancel</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}
