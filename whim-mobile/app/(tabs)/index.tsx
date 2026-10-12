import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useWhimStore, scopedBucket } from '@/store/useWhimStore';
import { useAuth } from '@/lib/auth';
import { fetchCoverPhoto } from '@/lib/db';
import { CITIES } from '@/data/cities';
import { VIBES, FEATURED, VIBE_DOT } from '@/data/vibes';
import { COLORS, SHADOWS, press } from '@/lib/theme';
import CityPicker from '@/components/CityPicker';
import CollectionsShelf from '@/components/CollectionsShelf';
import SpotImage from '@/components/SpotImage';
import Icon from '@/components/Icon';
import type { Collection } from '@/data/collections';

// Phase 1 — Context & Vibe. Bold editorial-meets-playful home.

// featured-card cover photos already fetched this session, keyed "city|vibe"
const coverCache = new Map<string, { photo: string | null; placeId?: string } | null>();

export default function Home() {
  const city = useWhimStore((s) => s.city);
  const setContext = useWhimStore((s) => s.setContext);
  const setCity = useWhimStore((s) => s.setCity);
  const hydrate = useWhimStore((s) => s.hydrate);
  const hydrated = useWhimStore((s) => s.hydrated);
  const vibe = useWhimStore((s) => s.vibe);
  const setVibe = useWhimStore((s) => s.setVibe);
  const bucketList = useWhimStore((s) => s.bucketList);
  const notificationsSeen = useWhimStore((s) => s.notificationsSeen);
  const markNotificationsSeen = useWhimStore((s) => s.markNotificationsSeen);
  const profile = useWhimStore((s) => s.profile);
  const { session } = useAuth();
  const [pickerOpen, setPickerOpen] = useState(false);

  // real initials from the profile (fallback: first letter of the email)
  const initials = useMemo(() => {
    const name = profile?.displayName?.trim();
    if (name) {
      const parts = name.split(/\s+/);
      return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
    }
    return (session?.user?.email?.[0] ?? '·').toUpperCase();
  }, [profile, session]);

  const f = FEATURED[vibe];
  const savedHere = useMemo(() => scopedBucket(bucketList, city, vibe).length, [bucketList, city, vibe]);

  // featured art should belong to the chosen CITY. Tokyo keeps the original
  // curated vibe art (it was shot for Tokyo); every other city shows a real
  // photo from its own deck — and NEVER the Tokyo art, not even while
  // loading (tone placeholder instead). Covers are cached so revisiting a
  // city doesn't flash.
  const isTokyo = city === 'Tokyo';
  const [coverPhoto, setCoverPhoto] = useState<{ photo: string | null; placeId?: string } | null>(null);
  useEffect(() => {
    if (isTokyo) return;
    const key = `${city}|${vibe}`;
    if (coverCache.has(key)) {
      setCoverPhoto(coverCache.get(key) ?? null);
      return;
    }
    let cancelled = false;
    setCoverPhoto(null);
    fetchCoverPhoto(city, vibe)
      .then((p) => {
        coverCache.set(key, p);
        if (!cancelled) setCoverPhoto(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [city, vibe, isTokyo]);

  // GPS-readout eyebrow — real travel data as a signature texture (not decoration).
  const coordLabel = useMemo(() => {
    const c = CITIES.find((x) => x.name === city);
    if (!c) return '';
    const ns = `${Math.abs(c.lat).toFixed(2)}°${c.lat >= 0 ? 'N' : 'S'}`;
    const ew = `${Math.abs(c.lng).toFixed(2)}°${c.lng >= 0 ? 'E' : 'W'}`;
    return `${ns}  ${ew}`;
  }, [city]);

  useEffect(() => {
    if (!hydrated) hydrate();
  }, [hydrated, hydrate]);

  const start = async () => {
    await setContext(city, vibe);
    router.push('/swipe');
  };

  // A collection is a curated (city, vibe) deck — set that context and swipe.
  const startCollection = async (c: Collection) => {
    setCity(c.city);
    setVibe(c.vibe);
    await setContext(c.city, c.vibe);
    router.push('/swipe');
  };

  // "Near me" — live discovery of real spots around the user's GPS (Places),
  // shown alongside the curated decks. The nearby screen handles permission.
  const nearMe = () => router.push('/nearby');

  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={['top']}>
      {/* header */}
      <View className="flex-row items-center justify-between px-5 pt-1">
        <Text style={{ fontFamily: 'BricolageGrotesque_800ExtraBold', fontSize: 26, color: COLORS.ink, letterSpacing: -0.8 }}>BeWhim</Text>
        <View className="flex-row items-center gap-4">
          <Pressable
            onPress={() => {
              markNotificationsSeen();
              router.push('/notifications');
            }}
            accessibilityLabel="Notifications"
            className="relative p-1"
          >
            <Icon name="bell" size={24} color={COLORS.ink} strokeWidth={1.7} />
            {!notificationsSeen && (
              <View className="absolute right-0 top-0 h-2.5 w-2.5 rounded-full border-2 border-canvas bg-accent" />
            )}
          </Pressable>
          <Pressable onPress={() => router.push('/settings')} accessibilityLabel="Account" className="h-9 w-9 items-center justify-center rounded-full bg-accent-soft">
            <Text className="text-[13px] font-bold text-accent">{initials}</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingBottom: 150 }} showsVerticalScrollIndicator={false}>
        {/* eyebrow — live GPS-style coordinate readout for the chosen city */}
        <View className="mt-6 flex-row items-center gap-2">
          <View className="h-1.5 w-1.5 rounded-full bg-accent" />
          <Text className="font-mono text-[11px] tracking-[0.08em] text-accent">{coordLabel}</Text>
        </View>

        {/* greeting + city chip */}
        <Text className="mt-2 font-serif text-[40px] leading-[0.98] text-ink">I’m going to</Text>
        <View className="mt-3 flex-row items-center gap-2.5">
          <Pressable
            onPress={() => setPickerOpen(true)}
            style={press(SHADOWS.soft)}
            className="flex-row items-center gap-2.5 rounded-full bg-white py-2 pl-5 pr-2"
          >
            <Text className="font-serif text-[26px] text-ink" style={{ lineHeight: 32 }}>
              {city}
            </Text>
            <View className="h-8 w-8 items-center justify-center rounded-full bg-ink/5">
              <Icon name="chevronDown" size={16} color={COLORS.ink} strokeWidth={2.6} />
            </View>
          </Pressable>
          <Pressable
            onPress={nearMe}
            style={press()}
            accessibilityLabel="Find spots near me"
            className="flex-row items-center gap-1.5 rounded-full border border-ink/12 bg-white px-3.5 py-2.5"
          >
            <Icon name="pin" size={15} color={COLORS.accent} strokeWidth={2} />
            <Text className="text-[13px] font-bold text-ink">Near me</Text>
          </Pressable>
        </View>

        <Text className="mt-4 text-[15px] text-muted">Pick a vibe to start discovering.</Text>

        {/* vibe pills — vibrant active */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="-mx-5 mt-5" contentContainerStyle={{ paddingHorizontal: 20, gap: 10 }}>
          {VIBES.map((v) => {
            const on = v.id === vibe;
            return (
              <Pressable
                key={v.id}
                onPress={() => setVibe(v.id)}
                style={press(on ? SHADOWS.accent : undefined)}
                className={`flex-row items-center gap-2 rounded-full border px-5 py-3 ${on ? 'border-accent bg-accent' : 'border-ink/10 bg-white'}`}
              >
                <View className="h-2 w-2 rounded-full" style={{ backgroundColor: on ? 'rgba(255,255,255,0.9)' : VIBE_DOT[v.id] }} />
                <Text className={`text-[14.5px] font-bold ${on ? 'text-white' : 'text-ink'}`}>{v.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* featured hero card with stacked-paper effect */}
        <View className="mt-9">
          <View className="absolute left-[18px] right-[18px] -top-3 h-8 rounded-[24px] bg-white" style={{ opacity: 0.7, ...SHADOWS.soft }} />
          <View className="absolute left-2 right-2 -top-1.5 h-8 rounded-3xl bg-white" style={{ opacity: 0.85, ...SHADOWS.soft }} />
          <View className="overflow-hidden rounded-[28px] bg-white" style={SHADOWS.card}>
            <View className="h-[196px] justify-end overflow-hidden" style={{ backgroundColor: f.tone }}>
              {isTokyo ? <SpotImage uri={f.photo} width={440} /> : <SpotImage uri={coverPhoto?.photo} placeId={coverPhoto?.placeId} width={440} />}
              {/* no vibe badge here — the active pill above already says it */}
              {/* postmark stamp — the signature element, grounded in travel documents */}
              <View className="absolute right-3.5 top-3.5" style={{ transform: [{ rotate: '-5deg' }] }}>
                <View className="rounded-lg border-2 border-white/85 px-2.5 py-1">
                  <Text
                    className="font-mono text-[9px] tracking-[0.15em] text-white"
                    style={{ textShadowColor: 'rgba(0,0,0,0.45)', textShadowRadius: 4, textShadowOffset: { width: 0, height: 1 } }}
                  >
                    BEWHIM ✦ {city.toUpperCase()}
                  </Text>
                </View>
              </View>
              <Text
                className="font-mono p-4 text-[11px] text-white/90"
                style={{ textShadowColor: 'rgba(0,0,0,0.35)', textShadowRadius: 4 }}
              >
                {f.caption}
              </Text>
            </View>
            <View className="p-5">
              <Text className="font-serif text-[27px] leading-[1.05] text-ink">{f.title}</Text>
              <Text className="mt-2.5 text-[14.5px] leading-6 text-muted">{f.desc}</Text>
              {/* island CTA with nested arrow */}
              <Pressable onPress={start} style={press()} className="mt-5 flex-row items-center gap-3 self-start rounded-full bg-ink py-2 pl-6 pr-2">
                <Text className="text-[15px] font-bold text-white">Start Swiping</Text>
                <View className="h-9 w-9 items-center justify-center rounded-full bg-white/15">
                  <Icon name="arrowRight" size={16} color="#fff" strokeWidth={2.6} />
                </View>
              </Pressable>
            </View>
          </View>
        </View>

        {/* seasonal & editorial collections */}
        <CollectionsShelf onPick={startCollection} />

        {/* group rooms entry */}
        <Pressable
          onPress={() => router.push('/room')}
          style={press(SHADOWS.soft)}
          className="mt-4 flex-row items-center gap-3.5 rounded-2xl bg-white p-4"
        >
          <View className="h-11 w-11 items-center justify-center rounded-full bg-accent-soft">
            <Icon name="person" size={20} color={COLORS.accent} strokeWidth={2} />
          </View>
          <View className="flex-1">
            <Text className="text-[15px] font-bold text-ink">Plan with friends</Text>
            <Text className="mt-0.5 text-[12.5px] text-muted">Swipe together — mutual likes become the plan.</Text>
          </View>
          <View className="rotate-[-5deg] rounded-md border-[1.5px] border-accent px-1.5 py-0.5">
            <Text className="font-mono text-[9px] tracking-[0.14em] text-accent">NEW ✦</Text>
          </View>
        </Pressable>

        {/* add your own spots (UGC) */}
        <Pressable
          onPress={() => router.push('/add-spots')}
          style={press(SHADOWS.soft)}
          className="mt-3 flex-row items-center gap-3.5 rounded-2xl bg-white p-4"
        >
          <View className="h-11 w-11 items-center justify-center rounded-full bg-accent-soft">
            <Icon name="pin" size={20} color={COLORS.accent} strokeWidth={2} />
          </View>
          <View className="flex-1">
            <Text className="text-[15px] font-bold text-ink">Add your spots</Text>
            <Text className="mt-0.5 text-[12.5px] text-muted">Drop your favorite places — we sort them into vibes.</Text>
          </View>
          <Icon name="arrowRight" size={16} color="#B6B1A9" strokeWidth={2} />
        </Pressable>

        {/* continue an existing collection */}
        {savedHere > 0 && (
          <Pressable
            onPress={() => router.navigate('/hitlist')}
            style={press()}
            className="mt-4 flex-row items-center justify-between rounded-2xl border border-accent/25 bg-accent/10 px-4 py-3.5"
          >
            <View className="flex-1">
              <Text className="text-[14.5px] font-bold text-ink">
                Continue your {city} · {f.label} list
              </Text>
              <Text className="mt-0.5 text-[12.5px] text-muted">
                {savedHere} spot{savedHere > 1 ? 's' : ''} saved · tap to review
              </Text>
            </View>
            <View className="h-8 w-8 items-center justify-center rounded-full bg-accent">
              <Icon name="arrowRight" size={16} color="#fff" strokeWidth={2.4} />
            </View>
          </Pressable>
        )}
      </ScrollView>


      <CityPicker
        visible={pickerOpen}
        current={city}
        onSelect={(c) => {
          setCity(c);
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />
    </SafeAreaView>
  );
}
