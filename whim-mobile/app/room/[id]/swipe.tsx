import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useEnsureRoom, useRoomStore } from '@/store/useRoomStore';
import SwipeDeck from '@/components/SwipeDeck';
import BackButton from '@/components/BackButton';
import Icon from '@/components/Icon';
import { COLORS } from '@/lib/theme';

// Group deck — same SwipeDeck, but a right-swipe is a VOTE for the crew's
// shared plan, not a personal save. No micro-discovery here: the group decides
// on anchors; detours stay personal. (The lobby usually loads the room;
// useEnsureRoom covers opening this screen directly.)
export default function RoomSwipe() {
  const { id } = useLocalSearchParams<{ id: string }>();
  useEnsureRoom(id);
  const room = useRoomStore((s) => s.room);
  const deck = useRoomStore((s) => s.deck);
  const deckIndex = useRoomStore((s) => s.deckIndex);
  const deckSourceCount = useRoomStore((s) => s.deckSourceCount);
  const loading = useRoomStore((s) => s.loading);
  const vote = useRoomStore((s) => s.vote);
  const matches = useRoomStore((s) => s.matches);

  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={['top']}>
      <View className="flex-row items-center gap-2.5 px-4 pb-1">
        <BackButton />
        <Text className="flex-1 text-center text-base font-semibold text-ink">
          {room ? (room.name ?? `${room.city} together`) : 'Room'}
        </Text>
        <Pressable
          onPress={() => router.back()}
          accessibilityLabel="Group matches"
          className="h-10 flex-row items-center gap-1.5 rounded-full bg-white px-3 shadow-sm shadow-black/5"
        >
          <Icon name="heartFilled" size={13} color={COLORS.accent} />
          <Text className="text-sm font-semibold text-accent">{matches.length}</Text>
        </Pressable>
      </View>

      <View className="flex-1 px-4 pt-3">
        <SwipeDeck
          deck={deck}
          index={deckIndex}
          sourceCount={deckSourceCount}
          loading={loading}
          onSwipe={vote}
          doneCopy={{
            title: 'Your votes are in.',
            body: 'Matches land in the lobby as the rest of the crew finishes swiping.',
          }}
          doneAction={{ label: 'See group matches', onPress: () => router.back() }}
        />
      </View>
    </SafeAreaView>
  );
}
