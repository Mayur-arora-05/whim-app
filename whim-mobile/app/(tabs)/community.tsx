import { useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, RefreshControl, ScrollView, SectionList, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchCommunityFeed,
  fetchSavedGuideFeed,
  fetchViewer,
  promoteSpot,
  reportCommunitySpot,
  reportItinerary,
  deleteMyItinerary,
  blockUser,
  type FeedItem,
} from '@/lib/db';
import { placePhotoSource } from '@/lib/placePhoto';
import { sizedPhoto } from '@/lib/img';
import { VIBE_DOT, VIBE_LABEL } from '@/data/vibes';
import { COLORS, SHADOWS, press } from '@/lib/theme';
import { toast } from '@/lib/toast';
import { hideBlockedAuthor } from '@/lib/blockCache';
import Icon from '@/components/Icon';
import { filterGuideFeed, guideCities } from '@/lib/guideCatalog';
import { useSavedGuides } from '@/lib/useSavedGuides';
import { useAuth } from '@/lib/auth';

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; items: FeedItem[] };
type Filter = 'all' | 'itinerary' | 'spot' | 'saved';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'itinerary', label: 'Guides' },
  { id: 'saved', label: 'Saved' },
  { id: 'spot', label: 'Spots' },
];

function ago(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / 604800)}w`;
}

// The community discovery feed — trips + spots people publish, split into
// Yours / Editors' picks / From the community. Admins can approve a community
// spot straight into the official curated deck (closing the UGC loop).
export default function Community() {
  const [filter, setFilter] = useState<Filter>('all');
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [city, setCity] = useState('');
  const saved = useSavedGuides();
  const { session } = useAuth();
  const shelf = useQuery({
    queryKey: ['savedGuideFeed', session?.user.id, saved.ids],
    queryFn: () => fetchSavedGuideFeed(saved.ids),
    enabled: filter === 'saved' && !saved.loading && !saved.error,
  });
  const feed = useQuery({ queryKey: ['communityFeed'], queryFn: fetchCommunityFeed });
  const { data: viewer = { id: null, isAdmin: false } } = useQuery({
    queryKey: ['viewer'],
    queryFn: fetchViewer,
    staleTime: 5 * 60_000,
  });

  const active = filter === 'saved' ? shelf : feed;
  const items = active.data ?? [];
  const state: State = active.isLoading || (filter === 'saved' && saved.loading) ? { kind: 'loading' } : active.isError || (filter === 'saved' && saved.error) ? { kind: 'error' } : { kind: 'ready', items };
  const refreshing = active.isRefetching;
  const load = () => { if (filter === 'saved' && saved.error) void saved.retry(); else void active.refetch(); };
  const refresh = load;

  const removeLocally = (id: string) => {
    qc.setQueryData<FeedItem[]>(['communityFeed'], (old) => (old ?? []).filter((i) => i.id !== id));
    qc.setQueriesData<FeedItem[]>({ queryKey: ['savedGuideFeed'] }, old => old?.filter(i => i.id !== id));
  };

  const moderate = (item: FeedItem) => {
    const mine = item.authorId === viewer.id;
    const buttons: any[] = [{ text: 'Cancel', style: 'cancel' }];

    if (viewer.isAdmin && item.kind === 'spot') {
      buttons.push({
        text: `Approve into ${item.city ?? 'official'} deck`,
        onPress: async () => {
          try {
            await promoteSpot(item.id);
            removeLocally(item.id);
            toast('Added to the official curated deck ✦');
          } catch (e: any) {
            toast(e?.message || 'Couldn’t approve — try again.');
          }
        },
      });
    }

    if (mine && item.kind === 'itinerary') {
      buttons.push({
        text: 'Unpublish',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteMyItinerary(item.id);
            removeLocally(item.id);
            toast('Trip unpublished.');
          } catch {
            toast('Couldn’t unpublish — try again.');
          }
        },
      });
    } else if (!mine) {
      buttons.push(
        {
          text: 'Block this person',
          style: 'destructive',
          onPress: async () => {
            try {
              await blockUser(item.authorId);
              hideBlockedAuthor(qc, item.authorId);
              toast('Blocked — you won’t see their content.');
            } catch {
              toast('Couldn’t block — check your connection and try again.');
            }
          },
        },
        {
          text: `Report ${item.kind === 'itinerary' ? 'trip' : 'spot'}`,
          style: 'destructive',
          onPress: async () => {
            try {
              await (item.kind === 'itinerary'
                ? reportItinerary(item.id, 'reported from feed')
                : reportCommunitySpot(item.id, 'reported from feed'));
              removeLocally(item.id);
              toast('Thanks — we’ll review this within 24 hours.');
            } catch {
              toast('Couldn’t send the report — check your connection and try again.');
            }
          },
        },
      );
    }

    if (buttons.length === 1) return; // nothing actionable
    Alert.alert(item.title, viewer.isAdmin && item.kind === 'spot' ? 'Approve, report, or block.' : 'Report or block.', buttons);
  };

  const open = (item: FeedItem) => {
    if (item.kind === 'itinerary') {
      router.push(`/trip/${item.id}`);
    } else {
      Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.title)}&query_place_id=${item.id}`).catch(() => {});
    }
  };

  const tripCard = (item: Extract<FeedItem, { kind: 'itinerary' }>) => {
    const official = item.authorName === 'BeWhim';
    return (
      <Pressable
        key={item.id}
        onPress={() => open(item)}
        onLongPress={() => moderate(item)}
        style={press(SHADOWS.soft)}
        className="mb-3 overflow-hidden rounded-[18px] bg-white"
      >
        <View className="h-[116px] w-full bg-accent-soft">
          {item.cover ? (
            <Image source={sizedPhoto(item.cover, 380)} style={{ width: '100%', height: '100%' }} contentFit="cover" transition={200} recyclingKey={item.id} />
          ) : (
            <View className="flex-1 items-center justify-center">
              <Icon name="route" size={26} color={COLORS.accent} strokeWidth={1.8} />
            </View>
          )}
          <View
            className="absolute left-3 top-3 flex-row items-center gap-1.5 rounded-full px-3 py-1.5"
            style={{ backgroundColor: official ? COLORS.accent : 'rgba(0,0,0,0.45)' }}
          >
            <Text className="text-[10px] leading-none text-white">✦</Text>
            <Text className="font-mono text-[9.5px] tracking-[0.12em] text-white">{official ? "EDITORS’ PICK" : 'ITINERARY'}</Text>
          </View>
        </View>
        <View className="p-4">
          <Text className="font-serif text-[19px] leading-[1.15] text-ink" numberOfLines={2}>
            {item.title}
          </Text>
          <View className="mt-1.5 flex-row items-center gap-1.5">
            {item.vibe && <View className="h-2 w-2 rounded-full" style={{ backgroundColor: VIBE_DOT[item.vibe] }} />}
            <Text className="flex-1 font-mono text-[10.5px] uppercase tracking-wide text-muted" numberOfLines={1}>
              {item.authorName ? `by ${item.authorName} · ` : ''}
              {item.stopCount} stops
              {item.city ? ` · ${item.city}` : ''}
            </Text>
            <Text className="font-mono text-[10px] text-muted">{ago(item.createdAt)}</Text>
          </View>
        </View>
      </Pressable>
    );
  };

  const spotCard = (item: Extract<FeedItem, { kind: 'spot' }>) => {
    const photo = placePhotoSource({ placeId: item.id, w: 200 });
    return (
      <Pressable
        key={item.id}
        onPress={() => open(item)}
        onLongPress={() => moderate(item)}
        style={press(SHADOWS.soft)}
        className="mb-3 flex-row items-center gap-3.5 rounded-[18px] bg-white p-3"
      >
        <View className="h-[52px] w-[52px] overflow-hidden rounded-[13px]" style={{ backgroundColor: COLORS.accentSoft }}>
          {photo ? (
            <Image source={photo} style={{ width: '100%', height: '100%' }} contentFit="cover" transition={200} />
          ) : (
            <View className="flex-1 items-center justify-center">
              <View className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: VIBE_DOT[item.vibe] }} />
            </View>
          )}
        </View>
        <View className="flex-1">
          <View className="flex-row items-center gap-1.5">
            <Text className="flex-shrink text-[15.5px] font-bold text-ink" numberOfLines={1}>
              {item.title}
            </Text>
            <View className="rounded-full bg-accent/12 px-1.5 py-0.5">
              <Text className="font-mono text-[8.5px] tracking-wide text-accent">LOCAL ✦</Text>
            </View>
          </View>
          <Text className="mt-0.5 text-[12.5px] text-muted" numberOfLines={1}>
            {item.blurb || [VIBE_LABEL[item.vibe], item.city].filter(Boolean).join(' · ')}
          </Text>
        </View>
        <Icon name="arrowRight" size={16} color="#B6B1A9" strokeWidth={2} />
      </Pressable>
    );
  };

  const card = (item: FeedItem) => (item.kind === 'itinerary' ? tripCard(item) : spotCard(item));

  // filter by type, then split into ownership sections
  const nameOf = (i: FeedItem) => (i.kind === 'itinerary' ? i.authorName : null);
  const filtered = state.kind === 'ready' ? filterGuideFeed(state.items, query, city).filter((i) => filter === 'all' || filter === 'saved' || i.kind === filter) : [];
  const cities = guideCities(items);
  const narrowed = !!query.trim() || !!city;
  const sections = [
    { key: 'mine', title: 'Yours', items: filtered.filter((i) => i.authorId === viewer.id) },
    { key: 'editors', title: "Editors’ picks", items: filtered.filter((i) => nameOf(i) === 'BeWhim' && i.authorId !== viewer.id) },
    { key: 'others', title: 'From the community', items: filtered.filter((i) => i.authorId !== viewer.id && nameOf(i) !== 'BeWhim') },
  ].filter((s) => s.items.length > 0);

  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={['top']}>
      <View className="px-5 pt-2">
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            <View className="h-1.5 w-1.5 rounded-full bg-accent" />
            <Text className="font-mono text-[11px] tracking-[0.16em] text-accent">COMMUNITY</Text>
          </View>
        </View>
        <Text className="mt-1 font-serif text-[32px] leading-[1.02] text-ink">Find your next day out</Text>
        <Text className="mt-1 text-[13.5px] text-muted">City guides, ready-made routes, and spots from the community.</Text>
        <Pressable onPress={() => router.push('/build-trip')} accessibilityRole="button"
          style={press()} className="mt-4 min-h-[48px] flex-row items-center gap-3 rounded-2xl border border-accent/20 bg-accent-soft px-4 py-3">
          <Icon name="route" size={19} color={COLORS.accent} strokeWidth={2} />
          <Text className="flex-1 text-[14px] font-semibold text-accent">Create a guide</Text>
          <Icon name="arrowRight" size={17} color={COLORS.accent} strokeWidth={2} />
        </Pressable>
      </View>

      <View className="mx-5 mt-3 flex-row items-center rounded-2xl border border-ink/10 bg-white px-4">
        <TextInput value={query} onChangeText={setQuery} placeholder="Search city, guide, or creator" placeholderTextColor={COLORS.muted}
          accessibilityLabel="Search community guides and spots" autoCorrect={false} returnKeyType="search" maxLength={100}
          className="min-h-[44px] flex-1 py-3 text-[14px] text-ink" />
        {!!query && <Pressable onPress={() => setQuery('')} accessibilityLabel="Clear search" className="min-h-[44px] min-w-[44px] items-center justify-center"><Icon name="close" size={18} /></Pressable>}
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        // never let the list below squeeze this row (ScrollViews shrink by default,
        // which sliced the bottoms off the pills); pad so the selected shadow fits
        className="mt-3 shrink-0 grow-0"
        contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 6, gap: 10 }}
      >
        {FILTERS.map((f) => {
          const on = f.id === filter;
          return (
            <Pressable
              key={f.id}
              onPress={() => { setFilter(f.id); setCity(''); }}
              style={press(on ? SHADOWS.accent : undefined)}
              accessibilityRole="button" accessibilityState={{ selected: on }}
              className={`min-h-[44px] shrink-0 items-center justify-center rounded-full border px-4 ${on ? 'border-accent bg-accent' : 'border-ink/10 bg-white'}`}
            >
              <Text className={`text-[13.5px] font-bold ${on ? 'text-white' : 'text-ink'}`}>{f.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {cities.length > 1 && <ScrollView horizontal showsHorizontalScrollIndicator={false} className="shrink-0 grow-0" contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 4, gap: 8 }}>
        {['', ...cities].map(value => <Pressable key={value} onPress={() => setCity(value)} accessibilityRole="button" accessibilityState={{ selected: city === value }} className="min-h-[44px] shrink-0 justify-center rounded-full px-3">
          <Text className={`text-[12px] ${city === value ? 'font-bold text-accent' : 'text-muted'}`}>{value || 'All cities'}</Text>
        </Pressable>)}
      </ScrollView>}
      {filter === 'saved' && <Text className="px-5 py-1 text-[11px] text-muted">{saved.synced ? 'Saved to your account' : 'Saved on this device'} · unavailable guides are hidden</Text>}

      {state.kind === 'loading' && (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={COLORS.accent} />
          <Text className="mt-3 text-[13px] text-muted">Loading the community…</Text>
        </View>
      )}

      {state.kind === 'error' && (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center font-serif text-[22px] text-ink">Couldn’t load the feed</Text>
          <Text className="mt-2.5 text-center text-[14px] leading-6 text-muted">Check your connection and try again.</Text>
          <Pressable onPress={load} className="mt-6 rounded-2xl bg-ink px-6 py-3.5">
            <Text className="text-[15px] font-semibold text-white">Retry</Text>
          </Pressable>
        </View>
      )}

      {state.kind === 'ready' &&
        (sections.length === 0 ? (
          <View className="flex-1 items-center justify-center px-8">
            <Text className="text-center font-serif text-[21px] text-ink">{narrowed ? 'No matches yet' : filter === 'saved' ? 'Your guide shelf starts here' : 'Nothing here yet'}</Text>
            <Text className="mt-2 text-center text-[13.5px] leading-5 text-muted">
              {narrowed ? 'Try another city, creator, or guide title.' : filter === 'saved' ? 'Open a guide and tap Save guide to keep it for later.' : 'Build a guide for a city you know and share your favorite stops.'}
            </Text>
            <Pressable onPress={() => { if (narrowed) { setQuery(''); setCity(''); } else if (filter === 'saved') setFilter('itinerary'); else router.push('/build-trip'); }} style={press(SHADOWS.accent)} className="mt-5 h-12 flex-row items-center justify-center gap-2 rounded-full bg-accent px-6">
              <Text className="text-[15px] font-bold text-white">{narrowed ? 'Clear filters' : filter === 'saved' ? 'Explore guides' : 'Create a guide'}</Text>
            </Pressable>
          </View>
        ) : (
          <SectionList
            sections={sections.map((s) => ({ title: s.title, count: s.items.length, data: s.items }))}
            keyExtractor={(item) => `${item.kind}-${item.id}`}
            renderItem={({ item }) => card(item)}
            renderSectionHeader={({ section }) => (
              <View className="mb-2.5 mt-1 flex-row items-center gap-2.5 bg-canvas pt-1">
                <Text className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink">{section.title}</Text>
                <View className="h-px flex-1 bg-ink/10" />
                <Text className="font-mono text-[10.5px] text-muted">{section.count}</Text>
              </View>
            )}
            stickySectionHeadersEnabled={false}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 150 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.accent} />}
            initialNumToRender={6}
            maxToRenderPerBatch={6}
            windowSize={7}
            ListFooterComponent={
              <Text className="mt-3 text-center font-mono text-[10.5px] tracking-[0.08em] text-muted">
                ✦ tap to open · long-press to {viewer.isAdmin ? 'approve or report' : 'report'}
              </Text>
            }
          />
        ))}

    </SafeAreaView>
  );
}
