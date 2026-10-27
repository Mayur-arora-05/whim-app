import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { fetchAdminAnalytics, type AdminAnalytics as AdminAnalyticsData } from '@/lib/db';
import { COLORS, SHADOWS, press } from '@/lib/theme';
import BackButton from '@/components/BackButton';

const RANGES = [7, 30, 90];

// Readable labels for the tracked funnel events.
const LABEL: Record<string, string> = {
  app_open: 'App opens',
  deck_started: 'Deck started',
  spot_saved: 'Spots saved',
  checkin: 'Check-ins',
  trip_published: 'Trips published',
  user_followed: 'Follows',
  deck_finished: 'Decks finished',
  route_viewed: 'Route views',
  open_in_maps: 'Maps opened',
  plan_share_requested: 'Plan share requests',
  room_created: 'Rooms created',
  room_joined: 'Room joins',
  room_match: 'New matches seen',
  room_invite_share_requested: 'Invite share requests',
  room_invite_shared: 'Invites shared',
  nearby_started: 'Nearby loads started',
  nearby_loaded: 'Nearby lists loaded',
  nearby_failed: 'Nearby loads failed',
  nearby_enriched: 'Nearby tips loaded',
  nearby_saved: 'Nearby places saved',
  guide_saved: 'Guides saved on device',
  guide_remix_started: 'Guide remixes started',
};

export default function AdminAnalytics() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AdminAnalyticsData | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'denied' | 'error'>('loading');

  const load = useCallback(() => {
    setState('loading');
    fetchAdminAnalytics(days)
      .then((d) => {
        if (!d) return setState('denied');
        setData(d);
        setState('ready');
      })
      .catch(() => setState('error'));
  }, [days]);
  useFocusEffect(useCallback(() => load(), [load]));

  const maxEvent = Math.max(1, ...(data?.events ?? []).map((e) => e.count));
  const maxDau = Math.max(1, ...(data?.dau ?? []).map((d) => d.users));

  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={['top']}>
      <View className="flex-row items-center gap-2.5 px-4 pb-1 pt-1">
        <BackButton />
      </View>

      <View className="px-5 pt-1">
        <View className="flex-row items-center gap-2">
          <View className="h-1.5 w-1.5 rounded-full bg-accent" />
          <Text className="font-mono text-[11px] tracking-[0.16em] text-accent">ANALYTICS</Text>
        </View>
        <Text className="mt-1 font-serif text-[32px] leading-[1.02] text-ink">The funnel</Text>
      </View>

      {/* range picker */}
      <View className="mt-4 flex-row gap-2 px-5">
        {RANGES.map((r) => {
          const on = r === days;
          return (
            <Pressable
              key={r}
              onPress={() => setDays(r)}
              style={press(on ? SHADOWS.accent : undefined)}
              className={`h-8 items-center justify-center rounded-full border px-3.5 ${on ? 'border-accent bg-accent' : 'border-ink/10 bg-white'}`}
            >
              <Text className={`text-[12.5px] font-bold ${on ? 'text-white' : 'text-ink'}`}>{r}d</Text>
            </Pressable>
          );
        })}
      </View>

      <ScrollView className="flex-1 px-5 pt-4" contentContainerStyle={{ paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {state === 'loading' && (
          <View className="items-center pt-16">
            <ActivityIndicator color={COLORS.accent} />
          </View>
        )}
        {state === 'denied' && <Text className="mt-10 text-center text-[14px] text-muted">Admins only.</Text>}
        {state === 'error' && (
          <View className="items-center pt-14">
            <Text className="text-center text-[14px] text-muted">Couldn’t load analytics.</Text>
            <Pressable onPress={load} className="mt-5 rounded-2xl bg-ink px-6 py-3"><Text className="font-semibold text-white">Retry</Text></Pressable>
          </View>
        )}

        {state === 'ready' && data && (
          <>
            {/* top stats */}
            <View className="flex-row rounded-2xl bg-white py-3.5" style={SHADOWS.soft}>
              {[
                { n: data.users, l: 'Users' },
                { n: data.dau.at(-1)?.users ?? 0, l: 'Active today' },
                { n: data.errors, l: 'Errors' },
              ].map((s, i) => (
                <View key={s.l} className={`flex-1 items-center ${i > 0 ? 'border-l border-ink/8' : ''}`}>
                  <Text className="font-serif text-[26px] text-ink" style={{ fontVariant: ['tabular-nums'] }}>{s.n}</Text>
                  <Text className="mt-0.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted">{s.l}</Text>
                </View>
              ))}
            </View>

            {/* DAU sparkbars */}
            <Text className="mb-2 mt-7 font-mono text-[11px] uppercase tracking-[0.14em] text-ink">Daily active · 14d</Text>
            <View className="flex-row items-end gap-1 rounded-2xl bg-white p-4" style={{ height: 110, ...SHADOWS.soft }}>
              {data.dau.length === 0 ? (
                <Text className="m-auto text-[13px] text-muted">No activity yet.</Text>
              ) : (
                data.dau.map((d) => (
                  <View key={d.day} className="flex-1 items-center justify-end">
                    <View className="w-full rounded-t-sm bg-accent" style={{ height: `${Math.max(6, (d.users / maxDau) * 100)}%` }} />
                  </View>
                ))
              )}
            </View>

            {/* event funnel */}
            <Text className="mb-2 mt-7 font-mono text-[11px] uppercase tracking-[0.14em] text-ink">Events · {days}d</Text>
            {data.events.length === 0 ? (
              <Text className="mt-2 text-[13.5px] text-muted">No events in this window yet — they’ll flow in as people use the app.</Text>
            ) : (
              data.events.map((e) => (
                <View key={e.event} className="mb-2.5 rounded-2xl bg-white p-3.5" style={SHADOWS.soft}>
                  <View className="flex-row items-center justify-between">
                    <Text className="text-[14.5px] font-bold text-ink">{LABEL[e.event] ?? e.event}</Text>
                    <Text className="font-mono text-[13px] text-ink" style={{ fontVariant: ['tabular-nums'] }}>
                      {e.count} <Text className="text-[11px] text-muted">· {e.users} ppl</Text>
                    </Text>
                  </View>
                  <View className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink/8">
                    <View className="h-full rounded-full bg-accent" style={{ width: `${(e.count / maxEvent) * 100}%` }} />
                  </View>
                </View>
              ))
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
