import { useEffect, useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useWhimStore, scopedBucket } from '@/store/useWhimStore';
import { VIBE_LABEL } from '@/data/vibes';
import SwipeDeck from '@/components/SwipeDeck';
import MicroDiscoveryModal from '@/components/MicroDiscoveryModal';
import BackButton from '@/components/BackButton';
import type { SwipeDirection } from '@/lib/types';

// Phase 2 host screen — wires the presentational SwipeDeck to the solo store
// and owns the post-match modal overlay.
export default function SwipeScreen() {
  const vibe = useWhimStore((s) => s.vibe);
  const city = useWhimStore((s) => s.city);
  const deck = useWhimStore((s) => s.deck);
  const deckIndex = useWhimStore((s) => s.deckIndex);
  const deckSourceCount = useWhimStore((s) => s.deckSourceCount);
  const deckLoading = useWhimStore((s) => s.deckLoading);
  const swipeLeft = useWhimStore((s) => s.swipeLeft);
  const swipeRight = useWhimStore((s) => s.swipeRight);
  const superSave = useWhimStore((s) => s.superSave);
  const undoLast = useWhimStore((s) => s.undoLast);
  const canUndo = useWhimStore((s) => s.history.length > 0 && s.deckIndex > 0);
  const bucketList = useWhimStore((s) => s.bucketList);
  const setContext = useWhimStore((s) => s.setContext);

  // Normally Discover deals the deck before pushing here. Opened any other way
  // (notification, link) nothing is loaded yet, and the empty deck would claim
  // "we haven't curated this vibe" — so deal it for the current context once.
  useEffect(() => {
    const st = useWhimStore.getState();
    if (!st.deckLoaded && !st.deckLoading) setContext(st.city, st.vibe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // count only what's saved in this city + vibe collection
  const matchCount = useMemo(() => scopedBucket(bucketList, city, vibe).length, [bucketList, city, vibe]);

  const handleSwipe = (direction: SwipeDirection) => {
    if (direction === 'right') swipeRight();
    else swipeLeft();
  };

  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={['top']}>
      <View className="flex-row items-center gap-2.5 px-4 pb-1">
        <BackButton />
        <Text className="flex-1 text-center text-base font-semibold text-ink">
          {VIBE_LABEL[vibe]} in {city}
        </Text>
        <Pressable
          onPress={() => router.navigate('/hitlist')}
          accessibilityLabel="Saved spots"
          className="h-10 min-w-10 items-center justify-center rounded-full bg-white px-3 shadow-sm shadow-black/5"
        >
          <Text className="text-sm font-semibold text-accent">{matchCount}</Text>
        </Pressable>
      </View>

      <View className="flex-1 px-4 pt-3">
        <SwipeDeck
          deck={deck}
          index={deckIndex}
          sourceCount={deckSourceCount}
          loading={deckLoading}
          onSwipe={handleSwipe}
          onSuperSave={superSave}
          onUndo={undoLast}
          canUndo={canUndo}
          doneAction={{ label: 'Review your hitlist', onPress: () => router.navigate('/hitlist') }}
        />
      </View>

      {/* Phase 3 overlay — auto-opens on swipe-right via the store */}
      <MicroDiscoveryModal />
    </SafeAreaView>
  );
}
