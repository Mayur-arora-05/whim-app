import { useContext } from 'react';
import { PixelRatio, StyleSheet, Text, TextInput } from 'react-native';
// RN-internal: true when rendering inside another <Text>. Used to tell nested
// spans (which inherit the parent's already-capped size) from top-level text.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TextAncestor: React.Context<boolean> = require('react-native/Libraries/Text/TextAncestor');

// Cap Dynamic Type at the largest *standard* iOS size (XXXL ≈ 1.35×).
//
// Why: every screen was checked up to XXXL and reflows fine. The accessibility
// sizes scale text up to ~3× (2.64× at "AX Extra Large"), which overflows
// fixed-height pills and buttons, chops the tab bar labels and splits headings
// mid-word. Users on those sizes get XXXL-sized text instead — still large, and
// the layout holds.
//
// Why not `maxFontSizeMultiplier`: on RN 0.76's new architecture (Fabric), iOS
// ignores it — RCTAttributedTextUtils only honours `allowFontScaling`. So above
// the cap we switch system scaling off and apply the capped scale ourselves.
// Remove this module once RN's Fabric text honours maxFontSizeMultiplier.
export const MAX_FONT_SCALE = 1.35;
const RN_DEFAULT_FONT_SIZE = 14; // RN's iOS default when no fontSize is set

function capped(props: any, nested: boolean): any {
  const scale = PixelRatio.getFontScale();
  if (scale <= MAX_FONT_SCALE || props.allowFontScaling === false) return props;
  const flat = StyleSheet.flatten(props.style) ?? {};
  const style: Record<string, unknown> = {};
  if (typeof flat.fontSize === 'number') style.fontSize = flat.fontSize * MAX_FONT_SCALE;
  // No explicit size: a nested span inherits its parent's (already capped) size
  // and scaling setting, so leave it alone. Top-level text would otherwise drop
  // to the unscaled default — give it the capped default instead.
  else if (nested) return props;
  else style.fontSize = RN_DEFAULT_FONT_SIZE * MAX_FONT_SCALE;
  if (typeof flat.lineHeight === 'number') style.lineHeight = flat.lineHeight * MAX_FONT_SCALE;
  return { ...props, allowFontScaling: false, style: [props.style, style] };
}

let installed = false;
export function installFontScaleCap(): void {
  if (installed) return;
  installed = true;
  for (const C of [Text, TextInput] as any[]) {
    const render = C.render; // both are forwardRef components in RN 0.76
    if (typeof render !== 'function') continue;
    const isText = C === Text;
    C.render = function CappedRender(props: any, ref: any) {
      // forwardRef render functions are components, so a hook is fine here
      const insideText = useContext(TextAncestor);
      return render(capped(props, isText && insideText), ref);
    };
  }
}
