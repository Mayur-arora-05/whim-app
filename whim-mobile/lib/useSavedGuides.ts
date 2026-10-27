import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './auth';
import { moveSavedGuidesToCloud, readSavedGuides, toggleSavedGuide } from './savedGuides';
import { toast } from './toast';
import { track } from './analytics';
import { GUIDE_CLOUD_SYNC_ENABLED } from './guideFeatures';
import { fetchCloudSavedGuideIds, setCloudGuideSaved } from './db';

export function useSavedGuides() {
  const { session } = useAuth();
  const userId = session?.user.id;
  const qc = useQueryClient();
  const queryKey = ['savedGuides', userId];
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      if (!GUIDE_CLOUD_SYNC_ENABLED) return readSavedGuides(userId!);
      // carry over anything saved on this device before cloud sync shipped
      await moveSavedGuidesToCloud(userId!, (id) => setCloudGuideSaved(id, true));
      return fetchCloudSavedGuideIds();
    },
    enabled: !!userId,
  });
  const mutation = useMutation({
    mutationFn: async (id: string) => {
      if (!userId) throw new Error('Sign in to save a guide.');
      if (!GUIDE_CLOUD_SYNC_ENABLED) return toggleSavedGuide(userId, id);
      // Read the cache at call time, not the render's query.data, so two quick
      // toggles each build on the other's result instead of overwriting it.
      const current = () => qc.getQueryData<string[]>(queryKey) ?? [];
      const shouldSave = !current().includes(id);
      await setCloudGuideSaved(id, shouldSave);
      return shouldSave ? [...current().filter(value => value !== id), id] : current().filter(value => value !== id);
    },
    onSuccess: (ids, id) => {
      qc.setQueryData(queryKey, ids);
      const saved = ids.includes(id);
      toast(saved ? GUIDE_CLOUD_SYNC_ENABLED ? 'Guide saved to your account.' : 'Guide saved on this device.' : 'Guide removed from saved.');
      if (saved) track('guide_saved', { guide_id: id, storage: GUIDE_CLOUD_SYNC_ENABLED ? 'cloud' : 'device' });
    },
    onError: () => toast('Couldn’t update saved guides. Try again.'),
  });
  return { synced: GUIDE_CLOUD_SYNC_ENABLED, ids: query.data ?? [], loading: query.isLoading, error: query.isError, retry: query.refetch, busy: mutation.isPending, toggle: mutation.mutate };
}
