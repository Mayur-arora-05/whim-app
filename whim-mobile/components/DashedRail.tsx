import { View } from 'react-native';

// iOS can't dash a single border side (`border-l-2 border-dashed` warns
// "Unsupported dashed / dotted border style" and draws solid), so the plan's
// leg connector draws its own: a 2px column of short dashes pinned to the
// parent's left edge and clipped to whatever height the row ends up.
export default function DashedRail() {
  return (
    <View pointerEvents="none" className="absolute bottom-0 left-0 top-0 w-[2px] overflow-hidden">
      {Array.from({ length: 24 }, (_, i) => (
        <View key={i} className="mb-[3px] h-[4px] w-[2px] rounded-full bg-[#D7D1C6]" />
      ))}
    </View>
  );
}
