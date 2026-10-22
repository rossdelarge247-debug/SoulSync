import { createFileRoute } from '@tanstack/react-router';

import { DirectoryPage } from './-ui/directory-page';

export interface DirectorySearch {
  q?: string;
  codec?: 'FLAC' | 'AAC' | 'MP3';
  min?: number;
  country?: string;
}

const CODECS = ['FLAC', 'AAC', 'MP3'] as const;

export const Route = createFileRoute('/radio/search')({
  validateSearch: (search: Record<string, unknown>): DirectorySearch => {
    const out: DirectorySearch = {};
    if (typeof search.q === 'string' && search.q.trim()) out.q = search.q.slice(0, 80);
    const codec = typeof search.codec === 'string' ? search.codec.toUpperCase() : '';
    if ((CODECS as readonly string[]).includes(codec))
      out.codec = codec as DirectorySearch['codec'];
    const min = Number(search.min);
    if (Number.isFinite(min) && min > 0) out.min = Math.min(2000, Math.round(min));
    if (typeof search.country === 'string' && /^[A-Za-z]{2}$/.test(search.country)) {
      out.country = search.country.toUpperCase();
    }
    return out;
  },
  component: DirectoryPage,
});
