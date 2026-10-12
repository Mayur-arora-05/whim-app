import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { BottomSheetModal, BottomSheetBackdrop, BottomSheetView } from '@gorhom/bottom-sheet';
import { useWhimStore } from '@/store/useWhimStore';
import type { MicroActivity } from '@/lib/types';
import SpotImage from './SpotImage';
import Icon from './Icon';
import { hapticSelect, hapticSuccess } from '@/lib/haptics';

/**
 * Phase 3 — Micro-Discovery. Opens automatically when the store has a
 * `pendingMatch` (i.e. the user just swiped right). Two paths:
 *   A) "Just sightseeing" → save the anchor only, close, back to deck.
 *   B) "Explore the area"  → reveal a horizontal carousel of adjacent
 *      micro-activities the user can toggle, then confirm.
 */
export default function MicroDiscoveryModal() {
  const pendingMatch = useWhimStore((s) => s.pendingMatch);
  const saveAnchorOnly = useWhimStore((s) => s.saveAnchorOnly);
  const saveAnchorWithActivities = useWhimStore((s) => s.saveAnchorWithActivities);
  const dismissMatch = useWhimStore((s) => s.dismissMatch);

  const sheetRef = useRef<BottomSheetModal>(null);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const snapPoints = useMemo(() => (expanded ? ['62%'] : ['38%']), [expanded]);

  // Open/close the sheet in response to the store's pendingMatch.
  useEffect(() => {
    if (pendingMatch) {
      setExpanded(false);
      setSelected([]);
      sheetRef.current?.present();
    } else {
      sheetRef.current?.dismiss();
    }
  }, [pendingMatch]);

  const toggle = useCallback((id: string) => {
    hapticSelect();
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const renderBackdrop = useCallback(
    (props: any) => <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="none" />,
    [],
  );

  if (!pendingMatch) return null;

  const chosen: MicroActivity[] = pendingMatch.nearby.filter((a) => selected.includes(a.id));

  return (
    <BottomSheetModal
      ref={sheetRef}
      snapPoints={snapPoints}
      enablePanDownToClose={false}
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={{ backgroundColor: '#E2DDD3', width: 38 }}
      backgroundStyle={{ backgroundColor: '#fff', borderRadius: 28 }}
      // closing via the backdrop/programmatically maps to "sightsee" (keep anchor)
      onDismiss={() => {
        if (useWhimStore.getState().pendingMatch) saveAnchorOnly();
      }}
    >
      <BottomSheetView className="px-6 pb-8">
        <View className="flex-row items-center gap-2">
          <View className="h-5 w-5 items-center justify-center rounded-full bg-accent">
            <Icon name="check" size={12} color="#fff" strokeWidth={3} />
          </View>
          <Text className="text-xs font-bold uppercase tracking-wider text-accent">Added to your hitlist</Text>
        </View>

        <Text className="mt-3.5 font-serif text-[23px] font-semibold text-ink">{pendingMatch.title}</Text>
        <Text className="mt-2 text-[14.5px] leading-6 text-muted">
          Are you just sightseeing, or do you want to explore what’s around {pendingMatch.area}?
        </Text>

        {!expanded ? (
          <View className="mt-6 flex-row gap-3">
            <Pressable
              onPress={() => {
                hapticSuccess();
                saveAnchorOnly();
              }}
              className="flex-1 items-center rounded-2xl border-[1.5px] border-ink/15 py-4"
            >
              <Text className="text-[14.5px] font-semibold text-ink">Just sightseeing</Text>
            </Pressable>
            <Pressable
              onPress={() => setExpanded(true)}
              className="flex-1 items-center rounded-2xl bg-ink py-4"
            >
              <Text className="text-[14.5px] font-semibold text-white">Explore the area</Text>
            </Pressable>
          </View>
        ) : (
          <View className="mt-5">
            <Text className="text-[11.5px] font-bold uppercase tracking-wide text-muted">
              Worth a detour, minutes away
            </Text>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              className="-mx-6 mt-3"
              contentContainerStyle={{ paddingHorizontal: 24, gap: 12 }}
            >
              {pendingMatch.nearby.map((a) => {
                const isOn = selected.includes(a.id);
                return (
                  <View key={a.id} className="w-[164px] overflow-hidden rounded-2xl border border-[#EFEAE2] bg-white">
                    <View className="h-[88px] overflow-hidden" style={{ backgroundColor: a.tone }}>
                      <SpotImage uri={a.photo} placeId={a.placeId} width={130} />
                    </View>
                    <View className="px-3 pb-3 pt-2.5">
                      <Text className="text-[13.5px] font-semibold leading-5 text-ink">{a.title}</Text>
                      <Text className="mt-0.5 text-[11.5px] text-muted">
                        {a.kind} · {a.mins} min
                      </Text>
                      <Pressable
                        onPress={() => toggle(a.id)}
                        className={`mt-2.5 items-center rounded-xl py-2 ${isOn ? 'bg-accent' : 'border-[1.5px] border-ink/15 bg-white'}`}
                      >
                        <Text className={`text-[13px] font-semibold ${isOn ? 'text-white' : 'text-ink'}`}>
                          {isOn ? 'Added' : 'Add'}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </ScrollView>

            <Pressable
              onPress={() => {
                hapticSuccess();
                saveAnchorWithActivities(chosen);
              }}
              className="mt-4 items-center rounded-2xl bg-ink py-4"
            >
              <Text className="text-[15px] font-semibold text-white">
                Add {chosen.length + 1} & continue
              </Text>
            </Pressable>
          </View>
        )}
      </BottomSheetView>
    </BottomSheetModal>
  );
}
