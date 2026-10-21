/**
 * "Library and system": everything today's dashboard had that the Home boards
 * don't draw, kept below the design's content until Design places it (see
 * docs/design/HANDOFF.md, "Dev, Home page"). Each part is the existing
 * component with its behaviour, ids and tour anchors unchanged; the evolved
 * look comes from the "Home" section at the end of static/dashboard-premier.css.
 *
 * - Library: size, scan and the library actions menu (Deep scan, Browse,
 *   Verify matches, Repair, Back up now, Review downloads).
 * - Enrichment workers: the worker orbs and Manage Workers.
 * - Downloading now: only while something downloads (painted by vanilla).
 * - Listening and new music: this week, recently added and new releases,
 *   recently played, Library Radio and Mixes.
 * - Playlists and automations: playlist sync, what runs next, followed
 *   artists and Wanted counts.
 * - Quick settings: effects switches and the accent colour.
 */

import { useSyncExternalStore } from 'react';

import type { useDashboardHeader } from '../../-dash.header';

import { heroNumbers } from '../../-dash.hello';
import { lastDbStats, subscribeDbStats } from '../../-dash.library';
import { ActiveDownloadsShell } from '../active-downloads-shell';
import { AutomationsCard, QuickSettings } from '../automations-card';
import { ContentBand } from '../content-rails';
import { EnrichmentWorkers, QuickNavTiles } from '../dashboard-header';
import { LibraryCard } from '../library-card';
import { ListenBand } from '../listen-band';
import { ListeningHistoryBand } from '../listening-history-band';
import { SyncRail } from '../sync-band';
import { WeeklyDigest } from '../weekly-digest';
import { HrefLink } from './home-nav';

type DashboardHeaderState = ReturnType<typeof useDashboardHeader>;

/** The library's size, from the db stats the library card publishes; each
 *  number opens the library, as the old hero's did. */
function LibraryNumbers() {
  const stats = useSyncExternalStore(subscribeDbStats, lastDbStats);
  const numbers = heroNumbers(stats);
  if (numbers.length === 0) return null;
  return (
    <ul className="home-more-numbers">
      {numbers.map((n) => (
        <li key={n.id}>
          <HrefLink href="/library" className="home-more-number">
            <span className="home-more-number-value">{n.value}</span>
            <span className="home-more-number-label">{n.label}</span>
          </HrefLink>
        </li>
      ))}
    </ul>
  );
}

export function HomeMore({ header }: { header: DashboardHeaderState }) {
  return (
    <section className="home-more" aria-labelledby="home-more-title" data-testid="home-more">
      <div className="home-more-head">
        <h2 className="home-more-title" id="home-more-title">
          Library and system
        </h2>
        <p className="home-more-sub">
          Your library, listening, playlists and automations, and the workers that fill in your
          library’s details.
        </p>
      </div>

      <div className="home-more-top">
        <section className="home-more-card home-more-library" aria-labelledby="home-library-title">
          <h3 className="home-more-card-title" id="home-library-title">
            Library
          </h3>
          <LibraryNumbers />
          <LibraryCard />
        </section>
        <EnrichmentWorkers header={header} />
      </div>

      {/* Only while something is downloading; the vanilla paints the cards. */}
      <ActiveDownloadsShell />

      <div className="dash-layout">
        <div className="dash-main">
          {/* Each renders nothing until it has something to show. */}
          <WeeklyDigest />
          <ContentBand />
          <ListeningHistoryBand />
          <ListenBand />
        </div>
        <aside className="dash-side" aria-label="Playlists and automations">
          <SyncRail />
          <AutomationsCard compact />
          <QuickNavTiles header={header} />
        </aside>
      </div>

      <footer className="dash-footer">
        <QuickSettings />
      </footer>
    </section>
  );
}
