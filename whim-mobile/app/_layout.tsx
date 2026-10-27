import '../global.css';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { QueryClientProvider, focusManager } from '@tanstack/react-query';
import { Stack, useRouter, useSegments } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import {
  useFonts,
  BricolageGrotesque_600SemiBold,
  BricolageGrotesque_700Bold,
  BricolageGrotesque_800ExtraBold,
} from '@expo-google-fonts/bricolage-grotesque';
import { IBMPlexMono_400Regular } from '@expo-google-fonts/ibm-plex-mono';
import * as SplashScreen from 'expo-splash-screen';
import { AuthProvider, useAuth } from '@/lib/auth';
import { installErrorLogging, track } from '@/lib/analytics';
import { registerForPush } from '@/lib/push';
import { getOnboarded } from '@/lib/onboarding';
import { queryClient } from '@/lib/queryClient';
import ToastHost from '@/components/Toast';
import AnimatedSplash from '@/components/AnimatedSplash';
import '@/lib/mapbox'; // sets the Mapbox access token once at startup
import { installFontScaleCap } from '@/lib/fontScale';

// cap Dynamic Type at XXXL before anything renders (see lib/fontScale.ts)
installFontScaleCap();

// keep the native splash up until the animated overlay is ready to take over
SplashScreen.preventAutoHideAsync().catch(() => {});

// route uncaught JS errors to error_logs
installErrorLogging();

// React Query client is shared from lib/queryClient so auth can clear it on
// account switch. Refresh stale data when the app returns to the foreground.
focusManager.setEventListener((handleFocus) => {
  const sub = AppState.addEventListener('change', (s) => handleFocus(s === 'active'));
  return () => sub.remove();
});

// Redirects between the app and the sign-in screen based on auth state.
function RootNavigator() {
  const { session, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  // one "app_open" per launch, once we know who the user is
  const openTracked = useRef(false);
  useEffect(() => {
    if (session && !openTracked.current) {
      openTracked.current = true;
      track('app_open');
      registerForPush();
    }
  }, [session]);

  // Tapping a local reminder deep-links to the route it points at. Only routes
  // on this allowlist are followed — if we ever add remote push, a spoofed
  // payload must not be able to navigate anywhere else.
  useEffect(() => {
    const allowedRoutes = new Set(['/', '/swipe', '/hitlist', '/itinerary', '/passport', '/notifications']);
    const sub = Notifications.addNotificationResponseReceivedListener((res) => {
      const route = res.notification.request.content.data?.route;
      if (typeof route === 'string' && allowedRoutes.has(route)) router.navigate(route as never);
    });
    return () => sub.remove();
  }, []);

  // Where the user was headed when the gate intercepted them — so an invite
  // deep link (whim://room/…) survives the sign-in round-trip.
  const pendingRoute = useRef<string | null>(null);
  // null = still reading the first-run flag
  const [onboarded, setOnboardedState] = useState<boolean | null>(null);
  useEffect(() => {
    getOnboarded().then(setOnboardedState);
  }, []);

  useEffect(() => {
    if (loading || onboarded === null) return;
    const inAuthArea = segments[0] === 'sign-in' || segments[0] === 'onboarding';
    if (!session && !inAuthArea) {
      // drop route-group names like "(tabs)" so the resumed path is a real URL
      pendingRoute.current = '/' + segments.filter((s) => !s.startsWith('(')).join('/');
      // fresh installs get the intro once, then the sign-in gate
      router.replace(onboarded ? '/sign-in' : ('/onboarding' as never));
    } else if (session && inAuthArea) {
      const target = pendingRoute.current ?? '/';
      pendingRoute.current = null;
      router.replace(target as never); // resume where they were headed
    }
  }, [session, loading, segments, onboarded]);

  if (loading || onboarded === null) {
    return (
      <View className="flex-1 items-center justify-center bg-canvas">
        <ActivityIndicator color="#2740E0" />
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#F0EEE8' },
        animation: 'slide_from_right',
      }}
    />
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    BricolageGrotesque_600SemiBold,
    BricolageGrotesque_700Bold,
    BricolageGrotesque_800ExtraBold,
    IBMPlexMono_400Regular,
  });

  const [splashDone, setSplashDone] = useState(false);

  // native splash stays up (preventAutoHideAsync) until fonts are in, so
  // returning null here never shows a blank frame
  if (!fontsLoaded) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <SafeAreaProvider>
          <BottomSheetModalProvider>
            <StatusBar style="dark" />
            <AuthProvider>
              <RootNavigator />
              <ToastHost />
              {!splashDone && <AnimatedSplash onDone={() => setSplashDone(true)} />}
            </AuthProvider>
          </BottomSheetModalProvider>
        </SafeAreaProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
