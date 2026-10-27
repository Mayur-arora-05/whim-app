import type { QueryClient } from '@tanstack/react-query';
import type { FeedItem } from './db';

/** After a block: drop the person's cards from every cached feed right away,
 * then refetch so server-side filtering takes over. */
export function hideBlockedAuthor(qc: QueryClient, authorId: string): void {
  const keep = (old?: FeedItem[]) => old?.filter((i) => i.authorId !== authorId);
  qc.setQueryData<FeedItem[]>(['communityFeed'], keep);
  qc.setQueriesData<FeedItem[]>({ queryKey: ['savedGuideFeed'] }, keep);
  qc.invalidateQueries({ queryKey: ['communityFeed'] });
  qc.invalidateQueries({ queryKey: ['savedGuideFeed'] });
  qc.invalidateQueries({ queryKey: ['creatorGuides'] });
}
