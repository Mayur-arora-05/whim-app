import { useCallback, useEffect, useRef } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import Mapbox, { Camera, CircleLayer, LineLayer, MapView, ShapeSource, SymbolLayer } from '@/lib/mapbox';
import type { RouteStop } from '@/lib/route';

// @rnmapbox/maps is a NATIVE module: it renders only in a custom dev build, not
// in Expo Go. We detect Expo Go and show a graceful placeholder there.
const inExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

interface RouteMapProps {
  stops: RouteStop[];
  height?: number;
}

export default function RouteMap({ stops, height = 280 }: RouteMapProps) {
  const cameraRef = useRef<any>(null);
  // every screen renders this map full-bleed at the top, under the status bar
  // and floating buttons — keep pins below the Dynamic Island / back button
  const { top: safeTop } = useSafeAreaInsets();

  const coords = stops.map((s) => [s.lng, s.lat] as [number, number]);
  const lngs = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);

  // Frame the route: a single stop centers + zooms; multiple stops fit the
  // bounding box with padding (top clears the status bar + floating buttons).
  const fitCamera = useCallback(() => {
    if (!cameraRef.current || coords.length === 0) return;
    if (coords.length === 1) {
      cameraRef.current.setCamera({ centerCoordinate: coords[0], zoomLevel: 14, animationDuration: 600 });
      return;
    }
    cameraRef.current.fitBounds(
      [Math.max(...lngs), Math.max(...lats)],
      [Math.min(...lngs), Math.min(...lats)],
      [safeTop + 36, 40, 44, 40], // [top, right, bottom, left]
      600,
    );
  }, [coords, lngs, lats, safeTop]);

  useEffect(() => {
    fitCamera();
  }, [fitCamera]);

  if (stops.length === 0) {
    return (
      <View className="items-center justify-center bg-[#ECEBE7]" style={{ height }}>
        <Text className="text-[13px] text-muted">Save a few spots to see your route.</Text>
      </View>
    );
  }

  if (inExpoGo) {
    return (
      <View className="items-center justify-center gap-1 bg-[#ECEBE7]" style={{ height }}>
        <Text className="font-serif text-base text-ink">🗺️ Map preview</Text>
        <Text className="px-8 text-center text-[12px] text-muted">
          The live Mapbox map renders in the dev build (expo run:ios), not in Expo Go.
        </Text>
      </View>
    );
  }


  const routeLine = {
    type: 'Feature' as const,
    geometry: { type: 'LineString' as const, coordinates: coords },
    properties: {},
  };

  // Numbered markers rendered NATIVELY (CircleLayer + SymbolLayer) rather than
  // React-view PointAnnotations — the latter fail to rasterize their number on
  // iOS once many markers overlap (you get bare dots). Native layers draw the
  // order label reliably and stay legible when pins cluster.
  const lastOrder = stops.length;
  const markerFC = {
    type: 'FeatureCollection' as const,
    features: stops.map((s) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] },
      properties: { order: s.order, label: String(s.order) },
    })),
  };

  return (
    <View style={{ height }}>
      <MapView
        style={{ flex: 1 }}
        styleURL={Mapbox.StyleURL.Light}
        scaleBarEnabled={false}
        logoEnabled={false}
        onDidFinishLoadingMap={fitCamera}
      >
        <Camera ref={cameraRef} defaultSettings={{ centerCoordinate: coords[0], zoomLevel: 11 }} />

        {stops.length > 1 && (
          <ShapeSource id="route" shape={routeLine}>
            <LineLayer
              id="routeLine"
              style={{ lineColor: '#2740E0', lineWidth: 2.5, lineOpacity: 0.55, lineCap: 'round', lineJoin: 'round', lineDasharray: [2, 2] }}
            />
          </ShapeSource>
        )}

        <ShapeSource id="stops" shape={markerFC}>
          {/* white halo so overlapping pins stay visually separated */}
          <CircleLayer
            id="stopHalo"
            style={{ circleRadius: 11.5, circleColor: '#FFFFFF', circleStrokeColor: 'rgba(23,21,15,0.12)', circleStrokeWidth: 1 }}
          />
          {/* first stop = ink (start of day), the rest = cobalt */}
          <CircleLayer
            id="stopDot"
            style={{
              circleRadius: 9.5,
              circleColor: ['case', ['==', ['get', 'order'], 1], '#17150F', ['==', ['get', 'order'], lastOrder], '#4A5AE8', '#2740E0'],
            }}
          />
          <SymbolLayer
            id="stopLabel"
            style={{
              textField: ['get', 'label'],
              textSize: 11,
              textColor: '#FFFFFF',
              textFont: ['DIN Offc Pro Bold', 'Arial Unicode MS Bold'],
              textAllowOverlap: true,
              textIgnorePlacement: true,
              symbolSortKey: ['get', 'order'], // lower orders draw first, higher on top
            }}
          />
        </ShapeSource>
      </MapView>
    </View>
  );
}
