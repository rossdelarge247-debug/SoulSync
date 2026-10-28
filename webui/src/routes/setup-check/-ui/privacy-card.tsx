import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';

import { Button, FormField, LabelledSwitch, TextInput } from '@/components/form';
import { Skeleton } from '@/components/primitives';

import type { CheckStatus } from '../-setup-check.types';

import {
  PRIVACY_QUERY_KEY,
  PrivacySettingsError,
  privacyQueryOptions,
  savePrivacySettings,
  type PrivacyReport,
  type PrivacySettings,
  type PrivacySettingsInput,
} from '../-setup-check.privacy';
import { CheckRow, StatusTag } from './check-groups';
import { StatusIcon } from './icons';
import styles from './setup-check-page.module.css';

/** Where the guide lives in the repository, for the "how to set it up" text. */
export const VPN_GUIDE = 'Support/VPN.md';

function toast(message: string, type: 'success' | 'info' | 'error' = 'success') {
  window.showToast?.(message, type);
}

function headlineTone(report: PrivacyReport): CheckStatus {
  return report.state === 'not_set_up' ? 'skipped' : report.tone;
}

function Addresses({ report }: { report: PrivacyReport }) {
  const { addresses, vpn } = report;
  if (!vpn?.up || !addresses.vpn) return null;
  const where = [vpn.city, vpn.country].filter(Boolean).join(', ');
  return (
    <dl className={styles.privacyAddresses} data-testid="privacy-addresses">
      <div>
        <dt>Peers see</dt>
        <dd>
          <code className={styles.inlineCode}>{addresses.vpn}</code>
          {where ? ` (${vpn.name}, ${where})` : ` (${vpn.name})`}
        </dd>
      </div>
      <div>
        <dt>Your home connection</dt>
        <dd>
          {addresses.home ? (
            <code className={styles.inlineCode}>{addresses.home}</code>
          ) : addresses.homeLookup ? (
            'couldn’t be looked up just now'
          ) : (
            'not looked up (the comparison is off)'
          )}
        </dd>
      </div>
    </dl>
  );
}

function SettingsForm({ settings, open }: { settings: PrivacySettings; open: boolean }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState(settings.gluetunUrl);
  const [key, setKey] = useState('');
  const [lookup, setLookup] = useState(settings.homeIpLookup);
  const [error, setError] = useState<{ field: string | null; message: string } | null>(null);

  useEffect(() => {
    setUrl(settings.gluetunUrl);
    setLookup(settings.homeIpLookup);
  }, [settings.gluetunUrl, settings.homeIpLookup]);

  const save = useMutation({
    mutationFn: (body: PrivacySettingsInput) => savePrivacySettings(body),
    onSuccess: () => {
      setKey('');
      setError(null);
      toast('Privacy check settings saved');
      void queryClient.invalidateQueries({ queryKey: PRIVACY_QUERY_KEY });
    },
    onError: (err) => {
      if (err instanceof PrivacySettingsError) setError({ field: err.field, message: err.message });
      else setError({ field: null, message: err instanceof Error ? err.message : 'Not saved' });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body: PrivacySettingsInput = { gluetun_url: url.trim(), home_ip_lookup: lookup };
    if (key.trim()) body.api_key = key.trim();
    save.mutate(body);
  };

  return (
    <details className={styles.privacySettings} open={open}>
      <summary className={styles.privacySettingsSummary}>Privacy check settings</summary>
      <form className={styles.privacyForm} onSubmit={submit} aria-label="Privacy check settings">
        <FormField
          label="Gluetun’s control address"
          htmlFor="privacy-gluetun-url"
          helperText="The VPN container’s control server, on the Docker network. With the VPN file it’s http://gluetun:8000."
          error={error?.field === 'gluetun_url' ? error.message : undefined}
        >
          <TextInput
            id="privacy-gluetun-url"
            value={url}
            placeholder="http://gluetun:8000"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
          />
        </FormField>
        <FormField
          label="Gluetun key"
          htmlFor="privacy-gluetun-key"
          helperText={
            settings.apiKeySet
              ? 'A key is saved. Type a new one to replace it.'
              : 'GLUETUN_API_KEY from the .env file next to docker-compose.yml.'
          }
          error={error?.field === 'api_key' ? error.message : undefined}
        >
          <TextInput
            id="privacy-gluetun-key"
            type="password"
            value={key}
            placeholder={settings.apiKeySet ? '••••••••' : 'GLUETUN_API_KEY'}
            autoComplete="off"
            onChange={(e) => setKey(e.target.value)}
          />
        </FormField>
        <div className={styles.privacySwitchRow}>
          <div className={styles.privacySwitchText}>
            <span id="privacy-home-label" className={styles.rowTitle}>
              Compare with my home IP
            </span>
            <span id="privacy-home-help" className={styles.compactDetail}>
              To check the VPN’s address differs from your home’s, SYNCHRO.S asks{' '}
              <code className={styles.inlineCode}>api.ipify.org</code> for your home address: one
              request, at most once an hour. Nothing else is sent. Off unless you turn it on.
            </span>
          </div>
          <LabelledSwitch
            checked={lookup}
            onCheckedChange={setLookup}
            aria-labelledby="privacy-home-label"
            aria-describedby="privacy-home-help"
          />
        </div>
        {error && error.field !== 'gluetun_url' && error.field !== 'api_key' ? (
          <p className={styles.privacyError} role="alert">
            {error.message}
          </p>
        ) : null}
        <div className={styles.fixActions}>
          <Button type="submit" size="lg" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </details>
  );
}

/**
 * Setup check's Privacy card: do Soulseek and torrents go through the VPN?
 * Its own request (GET /api/setup/privacy), so it can be run again alone and
 * shows the addresses, which the setup check's rows leave out.
 */
export function PrivacyCard() {
  const query = useQuery(privacyQueryOptions(true));
  const report = query.data;
  const running = query.isFetching;

  if (!report) {
    return (
      <section className={styles.privacyCard} aria-labelledby="privacy-title" aria-busy={running}>
        <h2 id="privacy-title" className={styles.privacyTitle}>
          Privacy
        </h2>
        {query.isError ? (
          <>
            <p className={styles.panelText} role="alert">
              The privacy check couldn’t run
              {query.error instanceof Error && query.error.message
                ? `: ${query.error.message.replace(/[.\s]+$/, '')}`
                : ''}
              .
            </p>
            <div>
              <Button size="lg" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </div>
          </>
        ) : (
          <Skeleton className={styles.groupSkeleton} />
        )}
      </section>
    );
  }

  const tone = headlineTone(report);
  const notSetUp = report.state === 'not_set_up';
  if (notSetUp && !report.servicesConfigured) {
    // nothing goes peer to peer: one quiet line, the settings folded away
    return (
      <section
        className={styles.privacyCard}
        aria-labelledby="privacy-title"
        data-testid="privacy-card"
        data-state="nothing_to_check"
      >
        <div className={styles.privacyHead}>
          <h2 id="privacy-title" className={styles.privacyTitle}>
            Privacy
          </h2>
          <span className={styles.privacyHeadNote}>
            Soulseek and torrents aren’t set up, so there’s nothing to check.
          </span>
        </div>
        <SettingsForm settings={report.settings} open={false} />
      </section>
    );
  }
  return (
    <section
      className={styles.privacyCard}
      aria-labelledby="privacy-title"
      aria-busy={running}
      data-testid="privacy-card"
      data-state={report.state}
    >
      <div className={styles.privacyHead}>
        <h2 id="privacy-title" className={styles.privacyTitle}>
          Privacy
        </h2>
        <span className={styles.privacyHeadNote}>Soulseek and torrents through the VPN</span>
      </div>

      <div className={styles.privacyHeadline} data-tone={tone} role="status">
        <StatusIcon className={styles.rowIcon} status={tone} />
        <p className={styles.privacyHeadlineText}>{report.headline}</p>
        {notSetUp ? null : <StatusTag status={tone} />}
      </div>

      {notSetUp ? (
        <div className={styles.privacyIntro}>
          <p className={styles.panelText}>
            Soulseek and torrents connect straight to other people, so without a VPN everyone they
            connect to sees your home IP. The VPN file runs them through Proton VPN with a kill
            switch: if the VPN drops, they stop.
          </p>
          <ol className={styles.privacySteps}>
            <li>
              Follow <code className={styles.inlineCode}>{VPN_GUIDE}</code>: add your Proton
              WireGuard key and a Gluetun key to <code className={styles.inlineCode}>.env</code>,
              then <code className={styles.inlineCode}>docker compose up -d</code>.
            </li>
            <li>Set Gluetun’s control address and key below, then run the check.</li>
          </ol>
        </div>
      ) : (
        <>
          <Addresses report={report} />
          <ul className={styles.checkList}>
            {report.rows.map((row) => (
              <CheckRow
                key={row.id}
                check={row}
                onRerun={() => void query.refetch()}
                rerunning={running}
              />
            ))}
          </ul>
        </>
      )}

      <SettingsForm settings={report.settings} open={notSetUp} />

      {notSetUp ? null : (
        <div className={styles.fixActions}>
          <Button
            variant="secondary"
            size="lg"
            onClick={() => void query.refetch()}
            disabled={running}
          >
            {running ? 'Checking…' : 'Check privacy again'}
          </Button>
        </div>
      )}
    </section>
  );
}
