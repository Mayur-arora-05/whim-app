import { useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import { track } from './analytics';

export function useRouteAnalytics(mode: 'solo' | 'room', city: string | undefined, vibe: string | undefined, stopCount: number, ready: boolean, roomId?: string): void {
  const tracked = useRef(false);
  useFocusEffect(useCallback(() => {
    return () => { tracked.current = false; };
  }, []));
  useFocusEffect(useCallback(() => {
    if (!ready || tracked.current) return;
    tracked.current = true;
    track('route_viewed', { mode, city, vibe, stop_count: stopCount, ...(roomId ? { room_id: roomId } : {}) });
  }, [mode, city, vibe, stopCount, ready, roomId]));
}
