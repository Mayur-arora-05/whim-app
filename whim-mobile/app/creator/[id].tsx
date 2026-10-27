import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { blockUser, fetchCreatorGuides } from '@/lib/db';
import { hideBlockedAuthor } from '@/lib/blockCache';
import { toast } from '@/lib/toast';
import { useAuth } from '@/lib/auth';
import { COLORS, SHADOWS, press } from '@/lib/theme';
import { sizedPhoto } from '@/lib/img';
import BackButton from '@/components/BackButton';
import Icon from '@/components/Icon';

export default function CreatorGuides() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const qc = useQueryClient();
  const isMe = session?.user.id === id;
  const guides = useInfiniteQuery({
    queryKey: ['creatorGuides', session?.user.id, id],
    queryFn: ({ pageParam }) => fetchCreatorGuides(String(id), pageParam),
    initialPageParam: 0,
    getNextPageParam: page => page.nextPage ?? undefined,
  });
  const items = guides.data?.pages.flatMap(page => page.items) ?? [];
  const first = items.find(item => item.kind === 'itinerary');
  const name = first?.kind === 'itinerary' ? first.authorName || 'Community creator' : 'Community creator';
  // App Store 1.2: block is available wherever someone's content appears.
  // To report a single guide, open it — the guide page has Report.
  const block = () => Alert.alert(`Block ${name}?`, 'You won’t see their guides or spots anywhere in BeWhim.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Block', style: 'destructive', onPress: async () => {
      try {
        await blockUser(String(id));
        hideBlockedAuthor(qc, String(id));
        toast('Blocked — you won’t see their content.');
        router.back();
      } catch {
        toast('Couldn’t block — check your connection and try again.');
      }
    } },
  ]);
  return <SafeAreaView className="flex-1 bg-canvas" edges={['top']}>
    <View className="flex-row items-center justify-between px-4 pt-1">
      <BackButton />
      {!isMe && <Pressable onPress={block} accessibilityRole="button" accessibilityLabel="Block this creator" hitSlop={8} className="min-h-[44px] justify-center rounded-full bg-white px-4">
        <Text className="text-[12.5px] font-semibold text-ink">Block</Text>
      </Pressable>}
    </View>
    <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
      <Text className="mt-3 font-mono text-[11px] tracking-[0.14em] text-accent">CREATOR GUIDES</Text>
      <Text className="mt-2 font-serif text-[30px] text-ink">{name}</Text>
      <Text className="mt-2 text-[14px] leading-6 text-muted">Explore their published routes and make a guide your own.</Text>
      {guides.isLoading && <ActivityIndicator className="mt-10" color={COLORS.accent} />}
      {guides.isError && <View className="mt-6">
        <Text className="text-[14px] text-muted">Couldn’t load these guides. Check your connection and try again.</Text>
        <Pressable onPress={() => guides.refetch()} className="mt-3 min-h-[48px] justify-center rounded-2xl bg-white px-4"><Text className="font-semibold text-accent">Retry</Text></Pressable>
      </View>}
      {!guides.isLoading && !guides.isError && !items.length && <Text className="mt-8 text-[15px] text-muted">No guides available from this creator.</Text>}
      {items.map(item => item.kind === 'itinerary' && <Pressable key={item.id} onPress={() => router.push(`/trip/${item.id}`)} accessibilityRole="button" style={press(SHADOWS.soft)} className="mt-4 overflow-hidden rounded-2xl bg-white">
        {item.cover ? <Image source={sizedPhoto(item.cover, 600)} style={{ width: '100%', height: 140 }} contentFit="cover" recyclingKey={item.id} /> : <View className="h-[100px] items-center justify-center bg-accent-soft"><Icon name="route" color={COLORS.accent} /></View>}
        <View className="p-4">
          <Text className="font-serif text-[20px] text-ink">{item.title}</Text>
          <Text className="mt-2 font-mono text-[11px] text-muted">{[item.city, `${item.stopCount} stops`].filter(Boolean).join(' · ')}</Text>
          <Text className="mt-3 text-[13px] font-semibold text-accent">View guide →</Text>
        </View>
      </Pressable>)}
      {guides.hasNextPage && <Pressable disabled={guides.isFetchingNextPage} onPress={() => guides.fetchNextPage()} className="mt-5 min-h-[48px] items-center justify-center rounded-2xl bg-accent px-4">
        <Text className="font-semibold text-white">{guides.isFetchingNextPage ? 'Loading…' : 'Load more guides'}</Text>
      </Pressable>}
    </ScrollView>
  </SafeAreaView>;
}
