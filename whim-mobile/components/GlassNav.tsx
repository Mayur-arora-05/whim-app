import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import Icon, { type IconName } from './Icon';
import { COLORS, SHADOWS } from '@/lib/theme';

// Floating frosted tab bar. Used as the Tabs navigator's `tabBar`, so the tab
// screens persist across switches (no remount). Rendered in a fixed order.
const ITEMS: { name: string; label: string; icon: IconName }[] = [
  { name: 'index', label: 'Discover', icon: 'discover' },
  { name: 'hitlist', label: 'Hitlist', icon: 'heart' },
  { name: 'itinerary', label: 'Route', icon: 'route' },
  { name: 'community', label: 'Community', icon: 'community' },
  { name: 'passport', label: 'Profile', icon: 'person' },
];

// Soft fade from transparent → canvas, painted behind the floating pill so list
// content dissolves into the background instead of being hard-cut by the nav.
// (No gradient dependency: a stack of bands approximates it cleanly.)
const FADE_BANDS = [0, 0.04, 0.09, 0.16, 0.26, 0.38, 0.52, 0.68, 0.84, 1];

export default function GlassNav({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 150, zIndex: 10 }}>
      <View pointerEvents="none" className="absolute bottom-0 left-0 right-0" style={{ height: 150 }}>
        {FADE_BANDS.map((opacity, i) => (
          <View key={i} style={{ flex: 1, backgroundColor: `rgba(240,238,232,${opacity})` }} />
        ))}
      </View>
      <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: Math.max(insets.bottom, 20), alignItems: 'center' }}>
        <View className="flex-row gap-0.5 rounded-full p-1.5" style={{ backgroundColor: 'rgba(255,255,255,0.96)', ...SHADOWS.nav }}>
        {ITEMS.map((item) => {
          const routeIndex = state.routes.findIndex((r) => r.name === item.name);
          const route = state.routes[routeIndex];
          if (!route) return null;
          const on = state.index === routeIndex;
          const color = on ? COLORS.accent : COLORS.inactive;
          return (
            <Pressable
              key={item.name}
              accessibilityRole="button"
              accessibilityState={on ? { selected: true } : {}}
              onPress={() => {
                const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                if (!on && !event.defaultPrevented) navigation.navigate(route.name);
              }}
              className="w-[58px] items-center gap-1 py-2"
            >
              <Icon name={item.icon} size={23} color={color} strokeWidth={1.8} />
              {/* fixed size like iOS's own tab bar: labels don't follow Dynamic Type —
                  at large sizes "Community" wrapped to two lines in the pill */}
              <Text allowFontScaling={false} numberOfLines={1} className="text-[10px] font-semibold" style={{ color }}>
                {item.label}
              </Text>
            </Pressable>
          );
        })}
        </View>
      </View>
    </View>
  );
}
