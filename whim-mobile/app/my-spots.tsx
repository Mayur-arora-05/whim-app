import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Swipeable } from 'react-native-gesture-handler';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchMySpots, removeMySpot, type MySpot } from '@/lib/db';
import { placePhotoSource } from '@/lib/placePhoto';
import { openDirections } from '@/lib/maps';
import { VIBES, VIBE_LABEL, VIBE_DOT } from '@/data/vibes';
import { COLORS, SHADOWS, press } from '@/lib/theme';
import { toast } from '@/lib/toast';
import type { VibeId } from '@/lib/types';
import BackButton from '@/components/BackButton';
import Icon from '@/components/Icon';

// A dedicated home for the user's own places — saved from Near me (the ⭐) or
// added via "Add your spots". Kept separate from the curated city+vibe Hitlist.
export default function MySpots() {
  const qc = useQueryClient();
  const { data: spots = [], isLoading } = useQuery({ queryKey: ['mySpots'], queryFn: fetchMySpots });
  const [filter, setFilter] = useState<VibeId | 'all'>('all');
  const shown = useMemo(() => (filter === 'all' ? spots : spots.filter((s) => s.vibe === filter)), [spots, filter]);

  const remove = (s: MySpot) => {
    qc.setQueryData<MySpot[]>(['mySpots'], (old) => (old ?? []).filter((x) => x.id !== s.id));
    qc.invalidateQueries({ queryKey: ['communityFeed'] }); // it also leaves Community › Yours
    removeMySpot(s.id).catch(() => {
      toast('Couldn’t remove — check your connection.');
      qc.invalidateQueries({ queryKey: ['mySpots'] });
    });
  };

  const count = (v: VibeId) => spots.filter((s) => s.vibe === v).length;

  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={['top']}>
      <View className="flex-row items-center gap-2.5 px-4 pb-1 pt-1">
        <BackButton />
      </View>

      <View className="px-5 pt-1">
        <View className="flex-row items-center gap-2">
          <View className="h-1.5 w-1.5 rounded-full bg-accent" />
          <Text className="font-mono text-[11px] tracking-[0.16em] text-accent">YOUR SPOTS</Text>
        </View>
        <Text className="mt-1 font-serif text-[32px] leading-[1.02] text-ink">Saved places</Text>
        <Text className="mt-1 text-[13.5px] text-muted">Everything you’ve saved from Near me or added yourself.</Text>
      </View>

      {/* vibe filter */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        // never let the list below squeeze this row (ScrollViews shrink by default,
        // which sliced the bottoms off the pills); pad so the selected shadow fits
        className="mt-3 shrink-0 grow-0"
        contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 6, gap: 10 }}
      >
        {(['all', ...VIBES.map((v) => v.id)] as (VibeId | 'all')[]).map((id) => {
          const on = id === filter;
          const n = id === 'all' ? spots.length : count(id);
          return (
            <Pressable
              key={id}
              onPress={() => setFilter(id)}
              style={press(on ? SHADOWS.accent : undefined)}
              className={`h-9 flex-row items-center gap-2 self-start rounded-full border px-4 ${on ? 'border-accent bg-accent' : 'border-ink/10 bg-white'}`}
            >
              {id !== 'all' && <View className="h-2 w-2 rounded-full" style={{ backgroundColor: on ? 'rgba(255,255,255,0.9)' : VIBE_DOT[id] }} />}
              <Text className={`text-[13.5px] font-bold ${on ? 'text-white' : 'text-ink'}`}>{id === 'all' ? 'All' : VIBE_LABEL[id]}</Text>
              <Text className={`text-[12px] ${on ? 'text-white/80' : 'text-muted'}`}>{n}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {isLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={COLORS.accent} />
        </View>
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(s) => s.id}
          className="flex-1"
          contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={7}
          ListEmptyComponent={
            <View className="items-center px-8 pt-16">
              <Text className="text-center font-serif text-[22px] text-ink">Nothing saved yet</Text>
              <Text className="mt-2.5 text-center text-[14px] leading-5 text-muted">
                Tap the ⭐ on a place in Near me, or add your own — they’ll collect here.
              </Text>
              <Pressable onPress={() => router.push('/nearby')} className="mt-6 rounded-2xl bg-ink px-6 py-3.5">
                <Text className="text-[15px] font-semibold text-white">Find spots near me</Text>
              </Pressable>
            </View>
          }
          renderItem={({ item: s }) => {
            const photo = placePhotoSource({ photoName: null, placeId: s.id, w: 120 });
            return (
              <View className="mb-3">
                <Swipeable
                  renderRightActions={() => (
                    <View className="my-0.5 ml-2 flex-row items-center justify-end gap-2 rounded-[18px] bg-destructive px-6">
                      <Icon name="trash" size={16} color="#fff" strokeWidth={2} />
                      <Text className="text-[14px] font-semibold text-white">Remove</Text>
                    </View>
                  )}
                  onSwipeableOpen={() => remove(s)}
                >
                  <Pressable
                    onPress={() => openDirections({ title: s.title, lat: s.lat ?? undefined, lng: s.lng ?? undefined, area: s.area ?? undefined })}
                    style={press(SHADOWS.soft)}
                    className="flex-row items-start gap-3.5 rounded-[18px] bg-white p-3"
                  >
                    <View className="h-[52px] w-[52px] overflow-hidden rounded-[13px]" style={{ backgroundColor: COLORS.accentSoft }}>
                      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} className="items-center justify-center">
                        <View className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: VIBE_DOT[s.vibe] }} />
                      </View>
                      {photo ? <Image source={photo} style={{ width: '100%', height: '100%' }} contentFit="cover" transition={200} /> : null}
                    </View>
                    <View className="flex-1">
                      <View className="flex-row items-center gap-1.5">
                        <Text className="flex-shrink font-serif text-[17px] text-ink" numberOfLines={1}>{s.title}</Text>
                        <View className="rounded-full px-1.5 py-0.5" style={{ backgroundColor: VIBE_DOT[s.vibe] + '22' }}>
                          <Text className="font-mono text-[8.5px] tracking-wide" style={{ color: VIBE_DOT[s.vibe] }}>{VIBE_LABEL[s.vibe].toUpperCase()}</Text>
                        </View>
                      </View>
                      {s.blurb ? (
                        <Text className="mt-0.5 text-[12.5px] leading-[16px] text-ink/70" numberOfLines={2}>{s.blurb}</Text>
                      ) : null}
                      {(s.area || s.city) ? (
                        <Text className="mt-1 font-mono text-[10px] tracking-wide text-muted" numberOfLines={1}>
                          {[s.area, s.city].filter(Boolean).join(' · ')}
                        </Text>
                      ) : null}
                    </View>
                    <View className="h-9 w-9 items-center justify-center rounded-full bg-accent-soft">
                      <Icon name="pin" size={16} color={COLORS.accent} strokeWidth={2} />
                    </View>
                  </Pressable>
                </Swipeable>
              </View>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}
