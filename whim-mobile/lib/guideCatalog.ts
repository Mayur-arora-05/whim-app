import type { FeedItem } from './db';

export function filterGuideFeed(items: FeedItem[], query: string, city: string): FeedItem[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(item => {
    if (city && item.city !== city) return false;
    const text = [item.title, item.city, item.kind === 'itinerary' ? item.authorName : item.blurb].filter(Boolean).join(' ').toLocaleLowerCase();
    return words.every(word => text.includes(word));
  });
}

export function guideCities(items: FeedItem[]): string[] {
  return [...new Set(items.map(item => item.city).filter((city): city is string => !!city))].sort((a, b) => a.localeCompare(b));
}
