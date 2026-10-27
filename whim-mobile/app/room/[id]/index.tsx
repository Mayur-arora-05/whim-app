import { useEffect } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Share, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useRoomStore } from '@/store/useRoomStore';
import { useAuth } from '@/lib/auth';
import { VIBE_LABEL, VIBE_DOT } from '@/data/vibes';
import { COLORS, SHADOWS, press } from '@/lib/theme';
import BackButton from '@/components/BackButton';
import SpotImage from '@/components/SpotImage';
import Icon from '@/components/Icon';
import { track } from '@/lib/analytics';

const memberInitials = (name: string | null) => {
  const n = (name ?? '').trim();
  if (!n) return '·';
  const parts = n.split(/\s+/);
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
};

// Room lobby — invite code, who's here (live), and the group matches as they
// land. The realtime subscription lives in the room store (enter/leave).
export default function RoomLobby() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const room = useRoomStore((s) => s.room);
  const members = useRoomStore((s) => s.members);
  const matches = useRoomStore((s) => s.matches);
  const loading = useRoomStore((s) => s.loading);
  const enter = useRoomStore((s) => s.enter);
  const leave = useRoomStore((s) => s.leave);
  const reportMember = useRoomStore((s) => s.reportMember);
  const blockMember = useRoomStore((s) => s.blockMember);
  const leaveCurrentRoom = useRoomStore((s) => s.leaveCurrentRoom);
  const { session } = useAuth();
  const myId = session?.user?.id;

  useEffect(() => {
    if (id) enter(id);
    return () => leave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Tap another member → report / block (App Store 1.2 UGC moderation).
  const memberActions = (userId: string, name: string) => {
    Alert.alert(name, undefined, [
      {
        text: 'Report name or behaviour',
        onPress: () =>
          Alert.alert('Report this person?', 'We review reports within 24 hours and act on violations.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Report', style: 'destructive', onPress: () => reportMember(userId, 'reported from room lobby') },
          ]),
      },
      {
        text: 'Block',
        style: 'destructive',
        onPress: () =>
          Alert.alert('Block this person?', 'You won’t see them or their activity again.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Block', style: 'destructive', onPress: () => blockMember(userId) },
          ]),
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const confirmLeave = () =>
    Alert.alert('Leave this room?', 'You’ll stop swiping with this group. You can re-join later with the code.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: async () => {
          // stay in the lobby if it didn't work — the toast explains
          if (await leaveCurrentRoom()) router.back();
        },
      },
    ]);

  const shareInvite = () => {
    if (!room) return;
    track('room_invite_share_requested', { room_id: room.id });
    Share.share({
      message:
        `Help me plan our ${room.city} day on BeWhim ✦ swipe with me!\n` +
        `Room code: ${room.code}\n` +
        `Open: whim://room/join?code=${room.code}`,
    }).then((result) => {
      if (result.action === Share.sharedAction) track('room_invite_shared', { room_id: room.id });
    }).catch(() => {});
  };

  if (loading || !room) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-canvas">
        <ActivityIndicator color={COLORS.accent} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={['top']}>
      <View className="flex-row items-center justify-between px-4 pb-1 pt-1">
        <BackButton />
        <Pressable
          onPress={shareInvite}
          accessibilityLabel="Share invite"
          className="h-10 w-10 items-center justify-center rounded-full bg-white"
          style={SHADOWS.soft}
        >
          <Icon name="share" size={19} color={COLORS.ink} strokeWidth={2} />
        </Pressable>
      </View>

      <ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingBottom: 60 }} showsVerticalScrollIndicator={false}>
        <View className="mt-1 flex-row items-center gap-2">
          <View className="h-1.5 w-1.5 rounded-full bg-accent" />
          <Text className="font-mono text-[11px] tracking-[0.14em] text-accent">ROOM ✦ {room.code}</Text>
        </View>
        <Text className="mt-2 font-serif text-[34px] leading-[1.02] text-ink">
          {room.name ?? `${room.city} together`}
        </Text>
        <View className="mt-2.5 flex-row items-center gap-2">
          <View className="h-2 w-2 rounded-full" style={{ backgroundColor: VIBE_DOT[room.vibe] }} />
          <Text className="text-[13.5px] font-semibold text-ink">
            {room.city} · {VIBE_LABEL[room.vibe]}
          </Text>
        </View>

        {/* invite code — postmark-style card */}
        <Pressable onPress={shareInvite} style={press(SHADOWS.soft)} className="mt-6 rounded-[24px] bg-white p-5">
          <View className="flex-row items-center justify-between">
            <View>
              <Text className="text-[11.5px] font-bold uppercase tracking-wide text-muted">Invite code</Text>
              <Text className="mt-1 font-mono text-[30px] tracking-[0.28em] text-ink">{room.code}</Text>
            </View>
            <View className="rotate-[-5deg] rounded-lg border-2 border-accent px-2.5 py-1.5">
              <Text className="font-mono text-[9.5px] tracking-[0.15em] text-accent">TAP TO{'\n'}SHARE ✦</Text>
            </View>
          </View>
        </Pressable>

        {/* members (live) */}
        <Text className="mb-3 mt-8 text-[12px] font-bold uppercase tracking-wide text-muted">
          Who’s in · {members.length}
        </Text>
        <View className="flex-row flex-wrap" style={{ gap: 10 }}>
          {members.map((m) => {
            const isMe = m.userId === myId;
            const name = (m.displayName ?? 'Traveller').split(/\s+/)[0];
            return (
              <Pressable
                key={m.userId}
                onPress={isMe ? undefined : () => memberActions(m.userId, m.displayName ?? 'This traveller')}
                className="flex-row items-center gap-2 rounded-full bg-white py-1.5 pl-1.5 pr-3.5"
                style={SHADOWS.soft}
              >
                <View className="h-8 w-8 items-center justify-center rounded-full bg-accent-soft">
                  <Text className="text-[12px] font-bold text-accent">{memberInitials(m.displayName)}</Text>
                </View>
                <Text className="text-[13.5px] font-semibold text-ink">{isMe ? 'You' : name}</Text>
                {m.isHost && <Text className="font-mono text-[9px] tracking-[0.12em] text-muted">HOST</Text>}
              </Pressable>
            );
          })}
        </View>
        {members.length > 1 && (
          <Text className="mt-2 text-[11.5px] text-muted">Tap a member to report or block.</Text>
        )}

        {/* start swiping */}
        <Pressable
          onPress={() => router.push(`/room/${room.id}/swipe` as never)}
          style={press(SHADOWS.accent)}
          className="mt-7 h-[56px] flex-row items-center justify-center gap-2.5 rounded-full bg-accent"
        >
          <Text className="text-[16px] font-bold text-white">Swipe together</Text>
          <Icon name="arrowRight" size={17} color="#fff" strokeWidth={2.4} />
        </Pressable>

        {/* group matches (live) */}
        <Text className="mb-3 mt-9 text-[12px] font-bold uppercase tracking-wide text-muted">
          Group matches · {matches.length}
        </Text>
        {matches.length === 0 ? (
          <View className="rounded-[20px] border border-dashed border-ink/15 px-6 py-8">
            <Text className="text-center text-[14px] leading-6 text-muted">
              When everyone in the room likes the same spot, it lands here — live.
            </Text>
          </View>
        ) : (
          <>
          {matches.map((m) => (
            <View key={m.spot.id} className="mb-3 flex-row items-center gap-3.5 rounded-[20px] bg-white p-3.5" style={SHADOWS.soft}>
              <View className="h-[56px] w-[56px] overflow-hidden rounded-[14px]" style={{ backgroundColor: m.spot.tone }}>
                <SpotImage uri={m.spot.photo} placeId={m.spot.placeId} width={130} />
              </View>
              <View className="flex-1">
                <Text className="font-serif text-[17px] text-ink">{m.spot.title}</Text>
                <Text className="mt-0.5 text-[12.5px] text-muted">
                  {m.spot.kind} · {m.spot.area}
                </Text>
              </View>
              <View className="flex-row items-center gap-1 rounded-full bg-accent/12 px-2.5 py-1">
                <Icon name="heartFilled" size={11} color={COLORS.accent} />
                <Text className="text-[11px] font-bold text-accent">{m.likes}</Text>
              </View>
            </View>
          ))}
          <Pressable
            onPress={() => router.push(`/room/${room.id}/plan` as never)}
            style={press()}
            className="mt-2 h-[54px] flex-row items-center justify-center gap-2 rounded-2xl bg-ink"
          >
            <Text className="text-[15px] font-semibold text-white">Build the day plan</Text>
            <Icon name="route" size={18} color="#fff" strokeWidth={1.9} />
          </Pressable>
          </>
        )}

        {/* leave room */}
        <Pressable onPress={confirmLeave} className="mt-8 items-center py-2">
          <Text className="text-[13px] font-semibold text-destructive">Leave room</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
