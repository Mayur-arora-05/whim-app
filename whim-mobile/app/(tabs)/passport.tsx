import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import { useWhimStore } from '@/store/useWhimStore';
import {
  fetchMyBadges,
  fetchProfile,
  fetchSocialCounts,
  setUsername,
  type Badge,
  type CheckinItem,
  type Profile,
} from '@/lib/db';
import { TIER, MILESTONES, tierOf, nextTier, tierProgress, type Tier } from '@/data/badges';
import SpotImage from '@/components/SpotImage';
import PassportCard from '@/components/PassportCard';
import Icon from '@/components/Icon';
import { COLORS, SHADOWS, press } from '@/lib/theme';
import { toast } from '@/lib/toast';

const initialsOf = (name: string) =>
  name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

// Passport — your travel profile, Strava-style: city badges that tier up as you
// check in, milestones, and a link into friends' badges + activity.
export default function Passport() {
  const checkins = useWhimStore((s) => s.checkins);
  const storeProfile = useWhimStore((s) => s.profile);

  const [profile, setProfile] = useState<Profile | null>(storeProfile);
  const [badges, setBadges] = useState<Badge[]>([]);
  const [counts, setCounts] = useState({ following: 0, followers: 0 });
  const [handleOpen, setHandleOpen] = useState(false);

  const refresh = useCallback(() => {
    fetchProfile().then(setProfile).catch(() => {});
    fetchMyBadges().then(setBadges).catch(() => {});
    fetchSocialCounts().then(setCounts).catch(() => {});
  }, []);
  useFocusEffect(useCallback(() => refresh(), [refresh]));

  const byCity = useMemo(() => {
    const map = new Map<string, CheckinItem[]>();
    checkins.forEach((c) => {
      if (!map.has(c.city)) map.set(c.city, []);
      map.get(c.city)!.push(c);
    });
    return [...map.entries()];
  }, [checkins]);

  const cityCount = byCity.length;
  const spotCount = checkins.length;
  const stats = { cities: cityCount, places: spotCount };
  const name = profile?.displayName || 'Traveler';

  const shareRef = useRef<View>(null);
  const sharePassport = async () => {
    try {
      const uri = await captureRef(shareRef, { format: 'png', quality: 1, result: 'tmpfile' });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Share your Passport' });
    } catch (e) {
      console.warn('[whim] passport share failed:', e);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={['top']}>
      <View className="flex-row items-center justify-end gap-2.5 px-4 pt-1">
        {spotCount > 0 && (
          <Pressable onPress={sharePassport} accessibilityLabel="Share Passport" className="h-10 w-10 items-center justify-center rounded-full bg-white" style={SHADOWS.soft}>
            <Icon name="share" size={19} color={COLORS.ink} strokeWidth={2} />
          </Pressable>
        )}
        <Pressable onPress={() => router.push('/settings')} accessibilityLabel="Settings" className="h-10 w-10 items-center justify-center rounded-full bg-white" style={SHADOWS.soft}>
          <Icon name="person" size={20} color={COLORS.ink} strokeWidth={1.9} />
        </Pressable>
      </View>

      <FlatList
        data={spotCount > 0 ? byCity : []}
        keyExtractor={(item) => item[0]}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 130 }}
        initialNumToRender={2}
        maxToRenderPerBatch={2}
        windowSize={5}
        renderItem={({ item: [cityName, stamps] }) => (
          <View className="mt-3 px-5">
            <Text className="mb-2.5 font-mono text-[11px] uppercase tracking-wide text-muted">{cityName} · {stamps.length}</Text>
            <View className="flex-row flex-wrap" style={{ gap: 10 }}>
              {stamps.map((s) => (
                <View key={s.spotId} style={{ width: '31.5%' }}>
                  <View className="aspect-square overflow-hidden rounded-2xl" style={{ backgroundColor: s.tone }}>
                    <SpotImage uri={s.photo} placeId={s.placeId} width={130} />
                    <View className="absolute right-1.5 top-1.5 h-6 w-6 items-center justify-center rounded-full bg-accent">
                      <Icon name="check" size={13} color="#fff" strokeWidth={3} />
                    </View>
                  </View>
                  <Text numberOfLines={2} className="mt-1.5 text-[11.5px] font-semibold leading-4 text-ink">{s.title}</Text>
                </View>
              ))}
            </View>
          </View>
        )}
        ListHeaderComponent={
          <View>
        {/* identity */}
        <View className="flex-row items-center gap-3.5 px-5 pt-2">
          <View className="h-16 w-16 items-center justify-center rounded-full bg-accent" style={SHADOWS.accent}>
            <Text className="font-serif text-[24px] text-white">{initialsOf(name)}</Text>
          </View>
          <View className="flex-1">
            <Text className="font-serif text-[27px] leading-[1.05] text-ink" numberOfLines={1}>{name}</Text>
            {profile?.username ? (
              <Text className="mt-0.5 font-mono text-[13px] text-accent">@{profile.username}</Text>
            ) : (
              <Pressable onPress={() => setHandleOpen(true)} className="mt-1 self-start rounded-full bg-accent/12 px-2.5 py-1">
                <Text className="font-mono text-[11px] tracking-wide text-accent">+ CLAIM YOUR @HANDLE</Text>
              </Pressable>
            )}
          </View>
        </View>

        {/* stat strip */}
        <View className="mx-5 mt-5 flex-row rounded-2xl bg-white py-3.5" style={SHADOWS.soft}>
          {[
            { n: badges.length, l: 'Badges' },
            { n: cityCount, l: cityCount === 1 ? 'City' : 'Cities' },
            { n: spotCount, l: 'Stamps' },
          ].map((s, i) => (
            <View key={s.l} className={`flex-1 items-center ${i > 0 ? 'border-l border-ink/8' : ''}`}>
              <Text className="font-serif text-[26px] text-ink" style={{ fontVariant: ['tabular-nums'] }}>{s.n}</Text>
              <Text className="mt-0.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted">{s.l}</Text>
            </View>
          ))}
        </View>

        {/* friends */}
        <Pressable onPress={() => router.push('/friends')} style={press(SHADOWS.soft)} className="mx-5 mt-3 flex-row items-center gap-3 rounded-2xl bg-white p-3.5">
          <View className="h-10 w-10 items-center justify-center rounded-full bg-accent-soft">
            <Icon name="community" size={20} color={COLORS.accent} strokeWidth={2} />
          </View>
          <View className="flex-1">
            <Text className="text-[15px] font-bold text-ink">Friends</Text>
            <Text className="mt-0.5 text-[12.5px] text-muted">
              {counts.following} following · {counts.followers} follower{counts.followers === 1 ? '' : 's'}
            </Text>
          </View>
          <Icon name="arrowRight" size={16} color="#B6B1A9" strokeWidth={2} />
        </Pressable>

        <Pressable onPress={() => router.push('/my-spots')} style={press(SHADOWS.soft)} className="mx-5 mt-3 flex-row items-center gap-3 rounded-2xl bg-white p-3.5">
          <View className="h-10 w-10 items-center justify-center rounded-full bg-accent-soft">
            <Icon name="starFilled" size={19} color={COLORS.accent} />
          </View>
          <View className="flex-1">
            <Text className="text-[15px] font-bold text-ink">Your spots</Text>
            <Text className="mt-0.5 text-[12.5px] text-muted">Places you’ve saved from Near me &amp; added yourself.</Text>
          </View>
          <Icon name="arrowRight" size={16} color="#B6B1A9" strokeWidth={2} />
        </Pressable>

        {/* badges showcase */}
        <View className="mt-7 px-5">
          <Text className="font-serif text-[20px] text-ink">City badges</Text>
          <Text className="mt-0.5 text-[12.5px] text-muted">Check in around a city to level up Bronze → Silver → Gold.</Text>
        </View>
        {badges.length === 0 ? (
          <View className="mx-5 mt-3 items-center rounded-2xl border border-dashed border-ink/15 px-6 py-8">
            <Text className="text-center font-serif text-[17px] text-ink">No badges yet</Text>
            <Text className="mt-1.5 text-center text-[13px] leading-5 text-muted">Check in at a spot on your route to earn your first city badge.</Text>
          </View>
        ) : (
          <View className="mt-3 flex-row flex-wrap px-5" style={{ gap: 12 }}>
            {badges.map((b) => {
              const tier = tierOf(b.spotCount) as Tier;
              const t = TIER[tier];
              const nx = nextTier(b.spotCount);
              return (
                <View key={b.city} style={{ width: '30.6%' }} className="items-center">
                  <View className="aspect-square w-full items-center justify-center rounded-full" style={{ borderWidth: 3.5, borderColor: t.color, backgroundColor: t.soft }}>
                    <Text className="font-serif text-[24px]" style={{ color: t.color }}>{initialsOf(b.city)}</Text>
                    {tier === 3 && <Text className="absolute bottom-2 text-[11px]">★</Text>}
                  </View>
                  <Text className="mt-1.5 text-[12.5px] font-bold text-ink" numberOfLines={1}>{b.city}</Text>
                  <Text className="font-mono text-[9px] uppercase tracking-wide" style={{ color: t.color }}>{t.label}</Text>
                  {/* progress to next tier */}
                  <View className="mt-1 h-1 w-full overflow-hidden rounded-full bg-ink/8">
                    <View className="h-full rounded-full" style={{ width: `${Math.round(tierProgress(b.spotCount) * 100)}%`, backgroundColor: t.color }} />
                  </View>
                  <Text className="mt-0.5 font-mono text-[8.5px] text-muted">{nx ? `${nx.need} to ${TIER[nx.to].label}` : `${b.spotCount} spots`}</Text>
                </View>
              );
            })}
          </View>
        )}

        {/* milestones */}
        <View className="mt-7 px-5">
          <Text className="font-serif text-[20px] text-ink">Milestones</Text>
          <View className="mt-3 flex-row flex-wrap" style={{ gap: 8 }}>
            {MILESTONES.map((m) => {
              const earned = m.earned(stats);
              return (
                <View
                  key={m.id}
                  className="flex-row items-center gap-1.5 rounded-full border px-3 py-1.5"
                  style={{ borderColor: earned ? COLORS.accent : '#E2DED5', backgroundColor: earned ? 'rgba(39,64,224,0.08)' : 'transparent' }}
                >
                  <Text className="text-[11px]">{earned ? '✦' : '○'}</Text>
                  <Text className={`text-[12.5px] font-bold ${earned ? 'text-accent' : 'text-muted'}`}>{m.label}</Text>
                  <Text className="font-mono text-[9px] text-muted">{m.hint}</Text>
                </View>
              );
            })}
          </View>
        </View>

        {/* stamps title (the grids themselves are the virtualized list below) */}
        {spotCount > 0 && (
          <View className="mt-7 px-5">
            <Text className="font-serif text-[20px] text-ink">Stamps</Text>
          </View>
        )}
          </View>
        }
      />


      <HandleModal
        visible={handleOpen}
        onClose={() => setHandleOpen(false)}
        onSaved={() => {
          setHandleOpen(false);
          refresh();
          toast('Handle claimed ✦');
        }}
      />

      <View ref={shareRef} collapsable={false} style={{ position: 'absolute', left: -9999, top: 0 }}>
        <PassportCard displayName={profile?.displayName ?? null} checkins={checkins} />
      </View>
    </SafeAreaView>
  );
}

function HandleModal({ visible, onClose, onSaved }: { visible: boolean; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  // shown inline: a toast would render behind this Modal on iOS
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await setUsername(value);
      setValue('');
      onSaved();
    } catch (e: any) {
      setError(e?.message || 'Couldn’t save handle.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 justify-end">
        <Pressable className="absolute inset-0 bg-black/40" onPress={() => !busy && onClose()} />
        <View className="rounded-t-[26px] bg-canvas px-5 pb-9 pt-3">
          <View className="mb-4 h-1 w-10 self-center rounded-full bg-ink/15" />
          <Text className="font-serif text-[24px] text-ink">Claim your handle</Text>
          <Text className="mt-1 text-[13px] text-muted">This is how friends find you. Letters, numbers, and _ only.</Text>
          <View className="mt-4 flex-row items-center rounded-2xl border border-ink/10 bg-white px-4">
            <Text className="font-mono text-[17px] text-muted">@</Text>
            <TextInput
              value={value}
              onChangeText={(t) => {
                setValue(t.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase());
                setError(null);
              }}
              placeholder="yourname"
              placeholderTextColor="#B6B1A9"
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={20}
              className="flex-1 py-3.5 text-[17px] text-ink"
            />
          </View>
          {error && <Text accessibilityRole="alert" className="mt-2 text-[13px] text-[#D23B2C]">{error}</Text>}
          <Pressable
            onPress={save}
            disabled={busy || value.length < 3}
            style={press(SHADOWS.accent)}
            className={`mt-4 h-14 flex-row items-center justify-center gap-2 rounded-full ${value.length >= 3 ? 'bg-accent' : 'bg-[#C9C4BC]'}`}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text className="text-[16px] font-bold text-white">Claim @{value || 'handle'}</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
