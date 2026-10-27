import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, Stack } from 'expo-router';
import { COLORS, SHADOWS, press } from '@/lib/theme';
import Icon from '@/components/Icon';

// Any link the app can't match (a deleted shared trip, an expired room invite,
// a typo'd deep link) lands here instead of Expo's default dev page — which is
// off-brand and links a sitemap of every screen, admin ones included.
export default function NotFound() {
  const goHome = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <SafeAreaView className="flex-1 bg-canvas">
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 justify-center px-8">
        <View className="flex-row items-center gap-2">
          <View className="h-1.5 w-1.5 rounded-full bg-accent" />
          <Text className="font-mono text-[11px] tracking-[0.14em] text-accent">OFF THE MAP</Text>
        </View>
        <Text className="mt-2 font-serif text-[34px] leading-[1.05] text-ink">This page isn’t{'\n'}on the map.</Text>
        <Text className="mt-3 text-[15px] leading-6 text-muted">
          The link may be old, or the trip or room it pointed to was removed. Let’s get you back to discovering.
        </Text>
        <Pressable
          onPress={goHome}
          style={press(SHADOWS.soft)}
          className="mt-8 h-[52px] flex-row items-center justify-center gap-2 self-start rounded-2xl bg-ink px-6"
        >
          <Icon name="discover" size={18} color={COLORS.white} strokeWidth={2} />
          <Text className="text-[15px] font-semibold text-white">Back to BeWhim</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
