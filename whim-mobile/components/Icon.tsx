import Svg, { Circle, Path } from 'react-native-svg';
import { COLORS } from '@/lib/theme';

// Crisp line icons ported from the design prototype (Travelo.dc.html). Stroked,
// so they tint to any color (active nav = accent, etc.).
export type IconName =
  | 'discover'
  | 'community'
  | 'heart'
  | 'heartFilled'
  | 'route'
  | 'person'
  | 'bell'
  | 'chevronLeft'
  | 'chevronDown'
  | 'arrowRight'
  | 'close'
  | 'clock'
  | 'check'
  | 'share'
  | 'pin'
  | 'trash'
  | 'undo'
  | 'star'
  | 'starFilled';

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export default function Icon({ name, size = 24, color = COLORS.ink, strokeWidth = 1.8 }: IconProps) {
  const s = { stroke: color, strokeWidth, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  // key={name}: react-native-svg updates a reused <Path> in place and can keep
  // the old shape/fill (heart → heartFilled stayed filled), so remount on change
  const svg = (children: React.ReactNode) => (
    <Svg key={name} width={size} height={size} viewBox="0 0 24 24" fill="none">
      {children}
    </Svg>
  );

  switch (name) {
    case 'discover':
      return svg(
        <>
          <Circle cx={12} cy={12} r={9} stroke={color} strokeWidth={strokeWidth} fill="none" />
          <Path d="M15.5 8.5l-2.2 5.3-5.3 2.2 2.2-5.3 5.3-2.2z" fill={color} />
        </>,
      );
    case 'community':
      return svg(
        <>
          <Circle cx={9} cy={8} r={3.1} stroke={color} strokeWidth={strokeWidth} fill="none" />
          <Path d="M3.5 20c0-3.1 2.6-4.9 5.5-4.9s5.5 1.8 5.5 4.9" {...s} />
          <Path d="M15.5 5.3a3 3 0 0 1 0 5.7" {...s} />
          <Path d="M17.2 20c0-2.9-1.4-4.5-3-5.2" {...s} />
        </>,
      );
    case 'heart':
      return svg(<Path d="M12 21s-7-4.6-9.2-8C1 9.7 2.4 6.2 5.7 6c2-.1 3.4 1.1 3.8 1.9.4-.8 1.8-2 3.8-1.9C16.6 6.2 18 9.7 16.2 13 14 16.4 12 21 12 21z" {...s} />);
    case 'heartFilled':
      return svg(<Path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" fill={color} />);
    case 'route':
      return svg(
        <>
          <Path d="M9 20l-5.5-2V6L9 8l6-2 5.5 2v12L15 18l-6 2z" {...s} />
          <Path d="M9 8v12M15 6v12" {...s} />
        </>,
      );
    case 'person':
      return svg(
        <>
          <Circle cx={12} cy={8} r={4} stroke={color} strokeWidth={strokeWidth} fill="none" />
          <Path d="M4 21c0-4 4-6.2 8-6.2S20 17 20 21" {...s} />
        </>,
      );
    case 'bell':
      return svg(
        <>
          <Path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" {...s} />
          <Path d="M13.7 21a2 2 0 0 1-3.4 0" {...s} />
        </>,
      );
    case 'chevronLeft':
      return svg(<Path d="M15 18l-6-6 6-6" {...s} />);
    case 'chevronDown':
      return svg(<Path d="M6 9l6 6 6-6" {...s} />);
    case 'arrowRight':
      return svg(<Path d="M5 12h14M13 6l6 6-6 6" {...s} />);
    case 'close':
      return svg(<Path d="M6 6l12 12M18 6L6 18" {...s} />);
    case 'check':
      return svg(<Path d="M4 12l5 5L20 6" {...s} />);
    case 'share':
      return svg(
        <>
          <Path d="M12 3v13" {...s} />
          <Path d="M8 7l4-4 4 4" {...s} />
          <Path d="M20 13v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6" {...s} />
        </>,
      );
    case 'pin':
      return svg(
        <>
          <Path d="M12 21s-7-5.6-7-11a7 7 0 0 1 14 0c0 5.4-7 11-7 11z" {...s} />
          <Circle cx={12} cy={10} r={2.5} stroke={color} strokeWidth={strokeWidth} fill="none" />
        </>,
      );
    case 'clock':
      return svg(
        <>
          <Circle cx={12} cy={12} r={9} stroke={color} strokeWidth={strokeWidth} fill="none" />
          <Path d="M12 7v5l3 2" {...s} />
        </>,
      );
    case 'trash':
      return svg(
        <>
          <Path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" {...s} />
          <Path d="M6 7l1 13a1.5 1.5 0 0 0 1.5 1.4h7A1.5 1.5 0 0 0 17 20l1-13" {...s} />
          <Path d="M10 11v6M14 11v6" {...s} />
        </>,
      );
    case 'undo':
      return svg(
        <>
          <Path d="M9 14L4 9l5-5" {...s} />
          <Path d="M4 9h11a5 5 0 0 1 0 10h-4" {...s} />
        </>,
      );
    case 'star':
      return svg(
        <Path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.14 1 5.86L12 17.9l-5.25 2.76 1-5.86L3.5 9.7l5.9-.9L12 3.5z" {...s} />,
      );
    case 'starFilled':
      return svg(
        <Path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.14 1 5.86L12 17.9l-5.25 2.76 1-5.86L3.5 9.7l5.9-.9L12 3.5z" fill={color} />,
      );
  }
}
