// GET /api/setup/privacy and PUT /api/setup/privacy/settings
// (api/setup_check.py, core/privacy_check.py). Admin-only: the answer holds
// the VPN's and the home connection's IP addresses.

import { queryOptions } from '@tanstack/react-query';
import { HTTPError } from 'ky';

import { apiClient } from '@/app/api-client';

import type { CheckStatus, SetupCheckResult } from './-setup-check.types';

import { SetupCheckForbiddenError } from './-setup-check.api';
import { toStatus } from './-setup-check.helpers';

export type PrivacyState =
  | 'not_set_up'
  | 'unreachable'
  | 'refused'
  | 'vpn_down'
  | 'leak'
  | 'not_using_vpn'
  | 'no_port'
  | 'port_mismatch'
  | 'service_unreachable'
  | 'not_confirmed'
  | 'protected';

export interface PrivacySettings {
  gluetunUrl: string;
  apiKeySet: boolean;
  homeIpLookup: boolean;
  homeIpService: string;
}

export interface PrivacyReport {
  state: PrivacyState;
  tone: CheckStatus;
  headline: string;
  configured: boolean;
  /** Soulseek or a torrent client is set up, so there's something to check */
  servicesConfigured: boolean;
  rows: SetupCheckResult[];
  settings: PrivacySettings;
  vpn: {
    up: boolean;
    status: string | null;
    name: string;
    country: string | null;
    city: string | null;
    forwardedPort: number | null;
  } | null;
  addresses: {
    vpn: string | null;
    home: string | null;
    homeLookup: boolean;
    homeCheckedAt: number | null;
    homeError: string | null;
  };
  ranAt: number;
}

interface RawSettings {
  gluetun_url?: string;
  api_key_set?: boolean;
  home_ip_lookup?: boolean;
  home_ip_service?: string;
}

interface RawReport {
  success?: boolean;
  error?: string;
  state?: string;
  tone?: string;
  headline?: string;
  configured?: boolean;
  services_configured?: boolean;
  rows?: Array<Partial<SetupCheckResult>>;
  settings?: RawSettings;
  vpn?: {
    up?: boolean;
    status?: string | null;
    name?: string;
    country?: string | null;
    city?: string | null;
    forwarded_port?: number | null;
  } | null;
  addresses?: {
    vpn?: string | null;
    home?: string | null;
    home_lookup?: boolean;
    home_checked_at?: number | null;
    home_error?: string | null;
  };
  ran_at?: number;
}

export const PRIVACY_QUERY_KEY = ['setup-check', 'privacy'] as const;

const STATES: readonly PrivacyState[] = [
  'not_set_up',
  'unreachable',
  'refused',
  'vpn_down',
  'leak',
  'not_using_vpn',
  'no_port',
  'port_mismatch',
  'service_unreachable',
  'not_confirmed',
  'protected',
];

export const DEFAULT_HOME_IP_SERVICE = 'https://api.ipify.org?format=json';

export function normalizeSettings(raw: RawSettings | undefined): PrivacySettings {
  return {
    gluetunUrl: String(raw?.gluetun_url ?? ''),
    apiKeySet: raw?.api_key_set === true,
    homeIpLookup: raw?.home_ip_lookup === true,
    homeIpService: String(raw?.home_ip_service || DEFAULT_HOME_IP_SERVICE),
  };
}

export function normalizePrivacy(raw: RawReport): PrivacyReport {
  const state = STATES.includes(raw.state as PrivacyState)
    ? (raw.state as PrivacyState)
    : 'not_set_up';
  const port = Number(raw.vpn?.forwarded_port);
  return {
    state,
    tone: toStatus(raw.tone),
    headline: String(raw.headline ?? ''),
    configured: raw.configured === true,
    servicesConfigured: raw.services_configured !== false,
    rows: (raw.rows ?? []).map((row, index) => ({
      id: String(row.id ?? `privacy-${index}`),
      title: String(row.title ?? 'Privacy'),
      status: toStatus(row.status),
      detail: String(row.detail ?? ''),
      fix: String(row.fix ?? ''),
      category: 'privacy',
    })),
    settings: normalizeSettings(raw.settings),
    vpn: raw.vpn
      ? {
          up: raw.vpn.up === true,
          status: raw.vpn.status ?? null,
          name: String(raw.vpn.name || 'the VPN'),
          country: raw.vpn.country ?? null,
          city: raw.vpn.city ?? null,
          forwardedPort: Number.isInteger(port) && port > 0 ? port : null,
        }
      : null,
    addresses: {
      vpn: raw.addresses?.vpn ?? null,
      home: raw.addresses?.home ?? null,
      homeLookup: raw.addresses?.home_lookup === true,
      homeCheckedAt: raw.addresses?.home_checked_at ?? null,
      homeError: raw.addresses?.home_error ?? null,
    },
    ranAt: Number(raw.ran_at) || Date.now() / 1000,
  };
}

export async function fetchPrivacy(): Promise<PrivacyReport> {
  let payload: RawReport;
  try {
    // the check waits on Gluetun, slskd and the torrent client (15 s at most server-side)
    payload = await apiClient.get('setup/privacy', { timeout: 30_000 }).json<RawReport>();
  } catch (error) {
    if (error instanceof HTTPError && error.response.status === 403) {
      throw new SetupCheckForbiddenError();
    }
    throw error;
  }
  if (!payload.success) throw new Error(payload.error || 'The privacy check failed');
  return normalizePrivacy(payload);
}

export function privacyQueryOptions(enabled: boolean) {
  return queryOptions({
    queryKey: PRIVACY_QUERY_KEY,
    queryFn: fetchPrivacy,
    enabled,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export interface PrivacySettingsInput {
  gluetun_url?: string;
  /** omitted: keep the stored key; '' removes it */
  api_key?: string;
  home_ip_lookup?: boolean;
}

export class PrivacySettingsError extends Error {
  field: string | null;
  constructor(message: string, field: string | null) {
    super(message);
    this.name = 'PrivacySettingsError';
    this.field = field;
  }
}

export async function savePrivacySettings(body: PrivacySettingsInput): Promise<PrivacySettings> {
  const response = await apiClient.put('setup/privacy/settings', {
    json: body,
    throwHttpErrors: false,
  });
  let payload: { success?: boolean; error?: string; field?: string; settings?: RawSettings } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    payload = {};
  }
  if (response.status === 403) throw new SetupCheckForbiddenError();
  if (!response.ok || !payload.success) {
    throw new PrivacySettingsError(
      payload.error || 'The settings weren’t saved',
      typeof payload.field === 'string' ? payload.field : null,
    );
  }
  return normalizeSettings(payload.settings);
}
