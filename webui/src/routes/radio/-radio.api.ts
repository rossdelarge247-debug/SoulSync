/**
 * The Radio page's reads and writes (api/radio.py; docs/design/CONTRACTS.md,
 * "Internet radio").
 */

import { queryOptions } from '@tanstack/react-query';

import type {
  AutoAddNumbers,
  DirectoryResponse,
  HeardResponse,
  LinkCheck,
  RadioLink,
  ShowSummary,
  StationKind,
  StationResponse,
  StationsResponse,
  TracklistResponse,
} from '@/features/radio/radio.types';

import { apiClient, readJson } from '@/app/api-client';

export const RADIO_KEY = ['radio'] as const;

async function ok<T extends { success?: boolean; message?: string; error?: string }>(
  promise: Promise<T>,
): Promise<T> {
  const body = await promise;
  if (body && body.success === false)
    throw new Error(body.message || body.error || 'Something went wrong');
  return body;
}

export const stationsQueryOptions = () =>
  queryOptions({
    queryKey: [...RADIO_KEY, 'stations'],
    queryFn: () => ok(readJson<StationsResponse>(apiClient.get('radio/stations'))),
    staleTime: 30_000,
  });

export const stationQueryOptions = (id: string) =>
  queryOptions({
    queryKey: [...RADIO_KEY, 'station', id],
    queryFn: () =>
      ok(readJson<StationResponse>(apiClient.get(`radio/stations/${encodeURIComponent(id)}`))),
    staleTime: 10_000,
  });

export const heardQueryOptions = (stationId?: string, days?: number) =>
  queryOptions({
    queryKey: [...RADIO_KEY, 'heard', stationId ?? 'all', days ?? 0],
    queryFn: () => {
      const searchParams: Record<string, string> = {};
      if (stationId) searchParams.station_id = stationId;
      if (days) searchParams.days = String(days);
      return ok(readJson<HeardResponse>(apiClient.get('radio/heard', { searchParams })));
    },
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

export const autoAddQueryOptions = (id: string) =>
  queryOptions({
    queryKey: [...RADIO_KEY, 'auto-add', id],
    queryFn: () =>
      ok(
        readJson<AutoAddNumbers & { success: boolean }>(
          apiClient.get(`radio/stations/${encodeURIComponent(id)}/auto-add`),
        ),
      ),
  });

export const showsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: [...RADIO_KEY, 'shows', id],
    queryFn: () =>
      ok(
        readJson<{ success: boolean; shows: ShowSummary[]; publishes: boolean }>(
          apiClient.get(`radio/stations/${encodeURIComponent(id)}/shows`, { timeout: 30_000 }),
        ),
      ),
    staleTime: 5 * 60_000,
  });

export const tracklistQueryOptions = (showId: string) =>
  queryOptions({
    queryKey: [...RADIO_KEY, 'tracklist', showId],
    queryFn: () =>
      ok(
        readJson<TracklistResponse>(
          apiClient.get(`radio/shows/${showId.split('/').map(encodeURIComponent).join('/')}`, {
            timeout: 30_000,
          }),
        ),
      ),
  });

export interface DirectoryQuery {
  q: string;
  codec: string;
  min_bitrate: number;
  country: string;
}

export const directoryQueryOptions = (query: DirectoryQuery, page: number) =>
  queryOptions({
    queryKey: [...RADIO_KEY, 'directory', query, page],
    queryFn: () => {
      const searchParams: Record<string, string> = { page: String(page) };
      if (query.q) searchParams.q = query.q;
      if (query.codec) searchParams.codec = query.codec;
      if (query.min_bitrate) searchParams.min_bitrate = String(query.min_bitrate);
      if (query.country) searchParams.country = query.country;
      return ok(
        readJson<DirectoryResponse>(
          apiClient.get('radio/directory', { searchParams, timeout: 20_000 }),
        ),
      );
    },
    staleTime: 5 * 60_000,
  });

export const countriesQueryOptions = () =>
  queryOptions({
    queryKey: [...RADIO_KEY, 'countries'],
    queryFn: () =>
      ok(
        readJson<{
          success: boolean;
          countries: { code: string; name: string; stations: number }[];
        }>(apiClient.get('radio/directory/countries')),
      ),
    staleTime: 24 * 3600_000,
  });

export async function setFavourite(id: string, on: boolean): Promise<void> {
  const path = `radio/favourites/${encodeURIComponent(id)}`;
  await ok(readJson<{ success: boolean }>(on ? apiClient.post(path) : apiClient.delete(path)));
}

export async function setAutoAdd(id: string, enabled: boolean): Promise<AutoAddNumbers> {
  return ok(
    readJson<AutoAddNumbers & { success: boolean }>(
      apiClient.put(`radio/stations/${encodeURIComponent(id)}/auto-add`, { json: { enabled } }),
    ),
  );
}

export async function wantHeard(id: number): Promise<{ message: string; skipped: boolean }> {
  return ok(
    readJson<{ success: boolean; message: string; skipped: boolean }>(
      apiClient.post(`radio/heard/${id}/want`, { timeout: 30_000 }),
    ),
  );
}

export async function wantMissing(showId: string): Promise<{ added: number; skipped: number }> {
  return ok(
    readJson<{ success: boolean; added: number; skipped: number }>(
      apiClient.post(
        `radio/shows/${showId.split('/').map(encodeURIComponent).join('/')}/want-missing`,
        {
          timeout: 120_000,
        },
      ),
    ),
  );
}

export async function checkLink(url: string): Promise<LinkCheck> {
  // a link that didn't pass is an answer (ok: false with the reason), not an error
  return readJson<LinkCheck & { success: boolean }>(
    apiClient.post('radio/links/check', { json: { url }, timeout: 30_000 }),
  );
}

export async function addLink(
  url: string,
  name: string,
  kind: StationKind,
  logoUrl = '',
): Promise<RadioLink> {
  const json: Record<string, string> = { url, name, kind };
  if (logoUrl) json.logo_url = logoUrl;
  const body = await ok(
    readJson<{ success: boolean; link: RadioLink }>(
      apiClient.post('radio/links', { json, timeout: 30_000 }),
    ),
  );
  return body.link;
}

export async function wantTrack(
  showId: string,
  position: number,
): Promise<{ message: string; skipped: boolean }> {
  return ok(
    readJson<{ success: boolean; message: string; skipped: boolean }>(
      apiClient.post(`radio/shows/${showId.split('/').map(encodeURIComponent).join('/')}/want`, {
        json: { position },
        timeout: 30_000,
      }),
    ),
  );
}
