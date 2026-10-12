import { useMemo } from 'react';
import { Alert, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Swipeable } from 'react-native-gesture-handler';
import { router } from 'expo-router';
import { useWhimStore, scopedBucket } from '@/store/useWhimStore';
import { VIBE_LABEL } from '@/data/vibes';
import { SHADOWS, COLORS } from '@/lib/theme';
import { openDirections } from '@/lib/maps';
import SpotImage from '@/components/SpotImage';
import Icon from '@/components/Icon';

// Phase 4 input — the Hitlist, scoped to the current city + vibe. A TAB ROOT
// (GlassNav, no back button). Saved anchors with their chosen micro-activities;
// swipe a card left to remove; "Generate Smart Route" → itinerary.
export default function Hitlist() {
  const bucketList = useWhimStore((s) => s.bucketList);
  const removeAnchor = useWhimStore((s) => s.removeAnchor);
  const clearCollection = useWhimStore((s) => s.clearCollection);
  const city = useWhimStore((s) => s.city);
  const vibe = useWhimStore((s) => s.vibe);
  const scoped = useMemo(() => scopedBucket(bucketList, city, vibe), [bucketList, city, vibe]);
  const count = scoped.length;
  const empty = count === 0;

  const confirmClear = () =>
    Alert.alert(
      'Clear this hitlist?',
      `This removes all ${count} spot${count > 1 ? 's' : ''} in your ${city} · ${VIBE_LABEL[vibe]} collection and lets you start fresh. This can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear & start fresh', style: 'destructive', onPress: () => clearCollection() },
      ],
    );

  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={['top']}>
      <View className="flex-row items-end justify-between px-5 pt-2">
        <View className="flex-1">
          <Text className="font-serif text-[31px] text-ink">Your {city} Hitlist</Text>
          <Text className="mt-1 text-[13.5px] text-muted">{VIBE_LABEL[vibe]} · {count} saved · swipe a card left to remove</Text>
        </View>
        {!empty && (
          <Pressable onPress={confirmClear} className="rounded-full px-2 py-2">
            <Text className="text-[13px] font-semibold text-destructive">Clear</Text>
          </Pressable>
        )}
      </View>

      <FlatList
        data={scoped}
        keyExtractor={(b) => b.anchor.id}
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 12, paddingBottom: 210 }}
        showsVerticalScrollIndicator={false}
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        windowSize={7}
        ListEmptyComponent={
          <View className="items-center px-8 pt-16">
            <Text className="font-serif text-[23px] text-ink">Nothing saved yet</Text>
            <Text className="mt-2.5 text-center text-[14px] leading-5 text-muted">
              Swipe right on spots you love and they’ll land here.
            </Text>
            <Pressable onPress={() => router.navigate('/')} className="mt-6 rounded-2xl bg-ink px-6 py-3.5">
              <Text className="text-[15px] font-semibold text-white">Find spots</Text>
            </Pressable>
          </View>
        }
        renderItem={({ item: b }) => (
          <View className="mb-4">
            <Swipeable
              renderRightActions={() => (
                <View className="my-0.5 ml-2 flex-row items-center justify-end gap-2 rounded-[20px] bg-destructive px-6">
                  <Icon name="trash" size={16} color="#fff" strokeWidth={2} />
                  <Text className="text-[14px] font-semibold text-white">Remove</Text>
                </View>
              )}
              onSwipeableOpen={() => removeAnchor(b.anchor.id)}
            >
              <View className="flex-row items-center gap-3.5 rounded-[20px] bg-white p-3.5" style={SHADOWS.soft}>
                <View className="h-[60px] w-[60px] overflow-hidden rounded-[14px]" style={{ backgroundColor: b.anchor.tone }}>
                  <SpotImage uri={b.anchor.photo} placeId={b.anchor.placeId} width={80} />
                </View>
                <View className="flex-1">
                  <Text className="font-serif text-[18px] text-ink">{b.anchor.title}</Text>
                  <Text className="mt-0.5 text-[12.5px] text-muted">{b.anchor.kind} · {b.anchor.area}</Text>
                </View>
                <Pressable
                  onPress={() => openDirections(b.anchor)}
                  accessibilityLabel={`Directions to ${b.anchor.title}`}
                  hitSlop={8}
                  className="h-11 w-11 items-center justify-center rounded-full bg-accent-soft"
                >
                  <Icon name="pin" size={18} color={COLORS.accent} strokeWidth={2} />
                </Pressable>
              </View>
            </Swipeable>

            {b.microActivities.map((a) => (
              <View
                key={a.id}
                className="ml-8 mt-2 flex-row items-center gap-3 rounded-[15px] border border-[#F0ECE3] bg-white px-3.5 py-2.5"
              >
                <View className="h-1.5 w-1.5 rounded-full bg-accent" />
                <View className="h-9 w-9 overflow-hidden rounded-[9px]" style={{ backgroundColor: a.tone }}>
                  <SpotImage uri={a.photo} placeId={a.placeId} width={60} />
                </View>
                <View className="flex-1">
                  <Text className="text-[14px] font-semibold text-ink">{a.title}</Text>
                  <Text className="mt-0.5 text-[11.5px] text-muted">{a.kind} · {a.mins} min away</Text>
                </View>
              </View>
            ))}
          </View>
        )}
      />

      {/* generate route — sits above the floating tab bar */}
      {!empty && (
        <View className="absolute bottom-[104px] left-0 right-0 px-5">
          <Pressable
            onPress={() => router.navigate('/itinerary')}
            className="flex-row items-center justify-center gap-2 rounded-2xl bg-ink py-[17px]"
            style={{ shadowColor: '#17150F', shadowOpacity: 0.2, shadowRadius: 26, shadowOffset: { width: 0, height: 10 } }}
          >
            <Text className="text-base font-semibold text-white">Generate Smart Route</Text>
            <Icon name="arrowRight" size={18} color="#fff" strokeWidth={2.2} />
          </Pressable>
        </View>
      )}

    </SafeAreaView>
  );
}
