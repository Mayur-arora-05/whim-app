import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  searchPlaces,
  publishCustomTrip,
  fetchPublishedItinerary,
  type EmbeddedStop,
  type PlaceResult,
} from '@/lib/db';
import { COLORS, SHADOWS, press } from '@/lib/theme';
import { toast } from '@/lib/toast';
import BackButton from '@/components/BackButton';
import Icon from '@/components/Icon';

// Build-your-own trip: name any city, add real locations by search, reorder,
// publish. Also the "remix" target — ?from=<id> pre-fills from a sample.
export default function BuildTrip() {
  const { from } = useLocalSearchParams<{ from?: string }>();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [city, setCity] = useState('');
  const [note, setNote] = useState('');
  const [stops, setStops] = useState<EmbeddedStop[]>([]);
  const [prefilling, setPrefilling] = useState(!!from);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchedFor, setSearchedFor] = useState(''); // last query that came back — drives "no matches"
  const [busy, setBusy] = useState(false);

  // remix: prefill from an existing trip (dropped to a flat, editable list)
  useEffect(() => {
    if (!from) return;
    fetchPublishedItinerary(String(from))
      .then((res) => {
        if (!res) return;
        const embedded = !!res.itin.embeddedStops;
        setTitle(res.itin.title.length > 66 ? res.itin.title : `${res.itin.title} (my version)`);
        setCity(res.itin.city ?? '');
        setNote(res.itin.note ?? '');
        setStops(
          res.stops.map((s) => ({
            title: s.title,
            ...(embedded ? { placeId: s.id } : { spotId: s.id }),
            lat: s.lat,
            lng: s.lng,
            kind: s.kind,
            area: s.area,
            day: s.day,
          })),
        );
      })
      .catch(() => toast('Couldn’t load that trip to remix.'))
      .finally(() => setPrefilling(false));
  }, [from]);

  // debounced place search
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      setSearchedFor('');
      return;
    }
    setSearching(true);
    // A bare name ("Fuglen") is too ambiguous for Places and returns nothing;
    // scope it to the trip's city when one is set and not already typed.
    const c = city.trim();
    const scoped = c && !q.toLowerCase().includes(c.toLowerCase()) ? `${q} ${c}` : q;
    // a slower, older request must not overwrite a newer one's results
    let current = true;
    const id = setTimeout(() => {
      searchPlaces(scoped)
        .then((r) => current && setResults(r))
        .catch((e) => {
          if (!current) return;
          setResults([]);
          if (e?.message) toast(e.message);
        })
        .finally(() => {
          if (!current) return;
          setSearching(false);
          setSearchedFor(q);
        });
    }, 320);
    return () => {
      current = false;
      clearTimeout(id);
    };
  }, [query, city]);

  const addPlace = (p: PlaceResult) => {
    if (stops.length >= 30) {
      toast('That’s the max — 30 stops per trip.');
      return;
    }
    if (stops.some((s) => s.placeId === p.id)) {
      toast('Already added.');
      return;
    }
    setStops((prev) => [...prev, { title: p.title, placeId: p.id, lat: p.lat, lng: p.lng, kind: p.kind, area: p.area }]);
    if (!city.trim() && p.city) setCity(p.city);
    setQuery('');
    setResults([]);
  };

  const move = (i: number, dir: -1 | 1) => {
    setStops((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };
  const remove = (i: number) => setStops((prev) => prev.filter((_, k) => k !== i));

  const publish = useCallback(async () => {
    if (!title.trim()) return toast('Give your trip a title.');
    if (stops.length === 0) return toast('Add at least one location.');
    setBusy(true);
    try {
      const id = await publishCustomTrip({ title, city, note, stops });
      qc.invalidateQueries({ queryKey: ['communityFeed'] });
      toast('Trip published ✦');
      router.replace(`/trip/${id}`);
    } catch (e: any) {
      toast(e?.message || 'Couldn’t publish — try again.');
    } finally {
      setBusy(false);
    }
  }, [title, city, note, stops, qc]);

  if (prefilling) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-canvas">
        <ActivityIndicator color={COLORS.accent} />
        <Text className="mt-3 text-[13px] text-muted">Loading trip to remix…</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-canvas" edges={['top']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1">
        <View className="flex-row items-center gap-2.5 px-4 pb-1 pt-1">
          <BackButton />
        </View>

        <ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View className="mt-1 flex-row items-center gap-2">
            <View className="h-1.5 w-1.5 rounded-full bg-accent" />
            <Text className="font-mono text-[11px] tracking-[0.16em] text-accent">{from ? 'REMIX A TRIP' : 'BUILD A TRIP'}</Text>
          </View>
          <Text className="mt-2 font-serif text-[32px] leading-[1.02] text-ink">{from ? 'Make it yours' : 'Your own trip'}</Text>
          <Text className="mt-1.5 text-[14px] leading-6 text-muted">
            Name it, pick a city, and add the places you love — anywhere in the world.
          </Text>

          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Trip title — e.g. “3 days in Goa”"
            placeholderTextColor="#B6B1A9"
            maxLength={80}
            className="mt-5 rounded-2xl border border-ink/10 bg-white px-4 py-3.5 text-[16px] text-ink"
          />
          <TextInput
            value={city}
            onChangeText={setCity}
            placeholder="City / place — e.g. “Goa”"
            placeholderTextColor="#B6B1A9"
            maxLength={60}
            className="mt-3 rounded-2xl border border-ink/10 bg-white px-4 py-3.5 text-[15px] text-ink"
          />
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="Add a note (optional)…"
            placeholderTextColor="#B6B1A9"
            maxLength={500}
            multiline
            className="mt-3 min-h-[64px] rounded-2xl border border-ink/10 bg-white px-4 py-3 text-[14.5px] leading-6 text-ink"
            style={{ textAlignVertical: 'top' }}
          />

          {/* add locations */}
          <Text className="mt-6 mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-ink">Add locations</Text>
          <View className="flex-row items-center rounded-2xl border border-ink/10 bg-white px-4">
            <Icon name="pin" size={16} color="#B6B1A9" strokeWidth={2} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search a place, café, beach…"
              placeholderTextColor="#B6B1A9"
              autoCorrect={false}
              className="ml-2 flex-1 py-3 text-[15px] text-ink"
            />
            {searching && <ActivityIndicator size="small" color={COLORS.accent} />}
          </View>

          {!searching && results.length === 0 && searchedFor !== '' && searchedFor === query.trim() && (
            <Text className="mt-2 px-1 text-[12.5px] leading-5 text-muted">
              No places found for “{searchedFor}”{city.trim() ? ` in ${city.trim()}` : ''}.{' '}
              {city.trim() ? 'Try the full name or a nearby landmark.' : 'Add the city above, or include it in the search.'}
            </Text>
          )}

          {results.length > 0 && (
            <View className="mt-2 overflow-hidden rounded-2xl bg-white" style={SHADOWS.soft}>
              {results.map((r) => (
                <Pressable key={r.id} onPress={() => addPlace(r)} className="flex-row items-center gap-3 border-b border-ink/5 px-4 py-3">
                  <Icon name="pin" size={15} color={COLORS.accent} strokeWidth={2} />
                  <View className="flex-1">
                    <Text className="text-[14.5px] font-semibold text-ink" numberOfLines={1}>{r.title}</Text>
                    {!!r.area && <Text className="text-[11.5px] text-muted" numberOfLines={1}>{r.area}</Text>}
                  </View>
                  <Text className="font-mono text-[18px] text-accent">＋</Text>
                </Pressable>
              ))}
            </View>
          )}

          {/* the trip so far */}
          {stops.length > 0 && (
            <View className="mt-5">
              <Text className="mb-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                Your route · {stops.length} stop{stops.length === 1 ? '' : 's'}
              </Text>
              {stops.map((s, i) => (
                <View key={`${s.placeId ?? s.spotId ?? s.title}-${i}`} className="mb-2.5 flex-row items-center gap-3 rounded-2xl bg-white p-3" style={SHADOWS.soft}>
                  <View className="h-7 w-7 items-center justify-center rounded-full bg-accent">
                    <Text className="text-[13px] font-bold text-white">{i + 1}</Text>
                  </View>
                  <View className="flex-1">
                    <Text className="text-[15px] font-semibold text-ink" numberOfLines={1}>{s.title}</Text>
                    {(!!s.area || s.day != null) && <Text className="text-[11.5px] text-muted" numberOfLines={1}>{[s.day != null ? `Day ${s.day}` : null, s.area].filter(Boolean).join(' · ')}</Text>}
                  </View>
                  <Pressable onPress={() => move(i, -1)} disabled={i === 0} hitSlop={6} className="h-8 w-7 items-center justify-center">
                    <View className="rotate-180">
                      <Icon name="chevronDown" size={17} color={i === 0 ? '#D8D3CA' : COLORS.ink} strokeWidth={2.2} />
                    </View>
                  </Pressable>
                  <Pressable onPress={() => move(i, 1)} disabled={i === stops.length - 1} hitSlop={6} className="h-8 w-7 items-center justify-center">
                    <Icon name="chevronDown" size={17} color={i === stops.length - 1 ? '#D8D3CA' : COLORS.ink} strokeWidth={2.2} />
                  </Pressable>
                  <Pressable onPress={() => remove(i)} hitSlop={6} className="h-8 w-7 items-center justify-center">
                    <Icon name="trash" size={16} color="#C67" strokeWidth={2} />
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          <Pressable
            onPress={publish}
            disabled={busy || !title.trim() || stops.length === 0}
            style={press(SHADOWS.accent)}
            className={`mt-6 h-14 flex-row items-center justify-center gap-2 rounded-full ${title.trim() && stops.length ? 'bg-accent' : 'bg-[#C9C4BC]'}`}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Text className="text-[16px] font-bold text-white">Publish trip</Text>
                <Icon name="arrowRight" size={16} color="#fff" strokeWidth={2.4} />
              </>
            )}
          </Pressable>
          <Text className="mt-2 text-center text-[11.5px] text-muted">Publishes to the community · you can unpublish anytime.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
