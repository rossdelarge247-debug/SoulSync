import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  playInAppPlayer,
  toggleAppPlayer,
  useAppPlayerMedia,
} from '@/features/playback/app-player';

import type {
  AudiobookItem,
  AudiobookNarratorMode,
  AudiobookPlayback,
  AudiobookWishlistCounts,
} from '../-audiobooks.types';

import {
  addToWishlist,
  fetchWishlist,
  removeFromWishlist,
  sampleStreamUrl,
} from '../-audiobooks.api';

/**
 * Sample playback, shared by every /audiobooks/* route.
 *
 * Every Audible title ships a real preview mp3, so a card anywhere on the page
 * can be auditioned without leaving it. It plays in the app's player (the bar
 * along the bottom, board 6a), so it survives navigation anywhere; this
 * context mirrors what that player has loaded.
 */

export interface AudiobookContextValue {
  playback: AudiobookPlayback | null;
  /** Start a sample, or toggle it when the same title is already loaded. */
  playSample: (book: AudiobookItem) => void;
  togglePlay: () => void;
  closePlayer: () => void;
  /** True when this ASIN is the one currently loaded and running. */
  isPlaying: (asin: string) => boolean;
  /** True when this ASIN is loaded at all, playing or paused. */
  isLoaded: (asin: string) => boolean;

  /** True when the book is on the wishlist. */
  isWishlisted: (asin: string) => boolean;
  /** True while a toggle for this ASIN is in flight. */
  isWishlistBusy: (asin: string) => boolean;
  /**
   * Add or remove; returns the state it ended up in. The narrator mode only
   * applies when adding — removing needs no question.
   */
  toggleWishlist: (book: AudiobookItem, mode?: AudiobookNarratorMode) => Promise<boolean>;
  wishlistCounts: AudiobookWishlistCounts;
  refreshWishlist: () => Promise<void>;
}

const AudiobookContext = createContext<AudiobookContextValue | null>(null);

export function useAudiobookContext(): AudiobookContextValue {
  const ctx = useContext(AudiobookContext);
  if (!ctx) throw new Error('useAudiobookContext must be used within AudiobookProvider');
  return ctx;
}

const EMPTY_COUNTS: AudiobookWishlistCounts = {
  wanted: 0,
  searching: 0,
  grabbed: 0,
  done: 0,
  failed: 0,
  total: 0,
};

export function AudiobookProvider({ children }: { children: ReactNode }) {
  const media = useAppPlayerMedia('audiobook');
  const books = useRef(new Map<string, Omit<AudiobookPlayback, 'isPlaying'>>());
  const playback = useMemo<AudiobookPlayback | null>(() => {
    const hit = media.id ? books.current.get(media.id) : undefined;
    return hit ? { ...hit, isPlaying: media.playing } : null;
  }, [media]);

  /**
   * The wishlist is held as a set of ASINs rather than asked about per card.
   * A browse page renders well over a hundred covers, and a "is this
   * wishlisted" request per card would be a hundred round trips to answer a
   * question one request already answers.
   */
  const [wishlisted, setWishlisted] = useState<Set<string>>(() => new Set());
  const [wishlistCounts, setWishlistCounts] = useState<AudiobookWishlistCounts>(EMPTY_COUNTS);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());

  const refreshWishlist = useCallback(async () => {
    const view = await fetchWishlist();
    setWishlisted(new Set(view.items.map((item) => item.asin)));
    setWishlistCounts(view.counts);
  }, []);

  useEffect(() => {
    void refreshWishlist();
  }, [refreshWishlist]);

  const isWishlisted = useCallback((asin: string) => wishlisted.has(asin), [wishlisted]);
  const isWishlistBusy = useCallback((asin: string) => busy.has(asin), [busy]);

  const toggleWishlist = useCallback(
    async (book: AudiobookItem, mode: AudiobookNarratorMode = 'exact'): Promise<boolean> => {
      const asin = book.asin;
      if (!asin || busy.has(asin)) return wishlisted.has(asin);

      const wanted = !wishlisted.has(asin);
      setBusy((current) => new Set(current).add(asin));
      // Optimistic: the button answers immediately and rolls back if the
      // server disagrees, because a wishlist toggle that waits on an indexer
      // round trip feels broken.
      setWishlisted((current) => {
        const next = new Set(current);
        if (wanted) next.add(asin);
        else next.delete(asin);
        return next;
      });

      const ok = wanted ? await addToWishlist(asin, mode) : await removeFromWishlist(asin);
      if (!ok) {
        setWishlisted((current) => {
          const next = new Set(current);
          if (wanted) next.delete(asin);
          else next.add(asin);
          return next;
        });
      } else {
        void refreshWishlist();
      }

      setBusy((current) => {
        const next = new Set(current);
        next.delete(asin);
        return next;
      });
      return ok ? wanted : !wanted;
    },
    [busy, wishlisted, refreshWishlist],
  );

  const playSample = useCallback((book: AudiobookItem) => {
    if (!book.sample_url) return;
    const entry = {
      asin: book.asin,
      title: book.title,
      author: book.author_names[0] || '',
      narrator: book.narrator_names[0] || '',
      coverUrl: book.cover_url || book.cover_url_large,
      sampleUrl: book.sample_url as string,
    };
    books.current.set(book.asin, entry);
    // Same title already loaded: the player toggles it rather than restarting,
    // which would drop the listener back to zero mid-preview.
    playInAppPlayer({
      kind: 'audiobook',
      id: book.asin,
      // Through the server proxy: the sample CDNs send no CORS headers, and
      // the proxy forwards Range so the scrubber can actually seek.
      src: sampleStreamUrl(entry.sampleUrl),
      title: entry.title,
      subtitle: [entry.author, entry.narrator && `Narrated by ${entry.narrator}`]
        .filter(Boolean)
        .join(' · '),
      artUrl: entry.coverUrl,
    });
  }, []);

  const togglePlay = useCallback(() => toggleAppPlayer(), []);

  const closePlayer = useCallback(() => {
    if (media.playing) toggleAppPlayer();
  }, [media.playing]);

  const isPlaying = useCallback(
    (asin: string) => Boolean(playback && playback.asin === asin && playback.isPlaying),
    [playback],
  );

  const isLoaded = useCallback(
    (asin: string) => Boolean(playback && playback.asin === asin),
    [playback],
  );

  const value = useMemo(
    () => ({
      playback,
      playSample,
      togglePlay,
      closePlayer,
      isPlaying,
      isLoaded,
      isWishlisted,
      isWishlistBusy,
      toggleWishlist,
      wishlistCounts,
      refreshWishlist,
    }),
    [
      playback,
      playSample,
      togglePlay,
      closePlayer,
      isPlaying,
      isLoaded,
      isWishlisted,
      isWishlistBusy,
      toggleWishlist,
      wishlistCounts,
      refreshWishlist,
    ],
  );

  return <AudiobookContext.Provider value={value}>{children}</AudiobookContext.Provider>;
}
