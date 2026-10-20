-- SoulSync 3.5.0 (dabb7b0ef5fbb5bac142802e8e84f48585237572) video database as that release creates it,
-- plus the representative rows listed in manifest.json.
-- Regenerate with: python tests/fixtures/old_databases/generate.py 3.5.0
PRAGMA user_version=48;
BEGIN TRANSACTION;
CREATE TABLE activity (
    id         INTEGER PRIMARY KEY,
    event_type TEXT NOT NULL,        -- added | grabbed | imported | failed | renamed
    message    TEXT NOT NULL,
    movie_id   INTEGER REFERENCES movies(id)         ON DELETE SET NULL,
    episode_id INTEGER REFERENCES episodes(id)       ON DELETE SET NULL,
    video_id   INTEGER REFERENCES channel_videos(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE channel_videos (
    id               INTEGER PRIMARY KEY,
    channel_id       INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    youtube_id       TEXT NOT NULL UNIQUE,      -- video id
    title            TEXT NOT NULL,
    description      TEXT,
    published_at     TEXT,             -- ISO datetime — drives feed/Calendar
    duration_seconds INTEGER,
    thumbnail_url    TEXT,
    monitored        INTEGER NOT NULL DEFAULT 1,
    has_file         INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE channels (
    id                 INTEGER PRIMARY KEY,
    youtube_id         TEXT NOT NULL UNIQUE,    -- channel id
    title              TEXT NOT NULL,
    handle             TEXT,                    -- @handle
    description        TEXT,
    avatar_url         TEXT,
    banner_url         TEXT,
    monitored          INTEGER NOT NULL DEFAULT 1,   -- "subscribed" (watchlist)
    quality_profile_id INTEGER REFERENCES quality_profiles(id) ON DELETE SET NULL,
    root_folder_id     INTEGER REFERENCES root_folders(id)     ON DELETE SET NULL,
    path               TEXT,
    added_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE collection_definitions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL,
    kind             TEXT NOT NULL DEFAULT 'smart',   -- 'smart' | 'list'
    media_type       TEXT NOT NULL DEFAULT 'movie',   -- 'movie' | 'show'
    definition       TEXT NOT NULL DEFAULT '{}',      -- JSON: smart rules OR list source
    poster_url       TEXT,                            -- collection art (server path or URL)
    summary          TEXT,
    sort_order       TEXT NOT NULL DEFAULT 'release', -- release | alpha | rating | added | custom
    sync_mode        TEXT NOT NULL DEFAULT 'sync',    -- 'sync' (add+remove) | 'append' (add only)
    pinned           INTEGER NOT NULL DEFAULT 0,      -- promote to home/library
    wishlist_missing INTEGER NOT NULL DEFAULT 0,      -- 'list' kind: wishlist unowned members
    enabled          INTEGER NOT NULL DEFAULT 1,      -- included in the daily sync
    window_start     TEXT,                            -- seasonal window 'MM-DD' (with window_end):
    window_end       TEXT,                            --   in-window syncs; out-of-window removes ours
    collection_mode  TEXT,                            -- Plex library behavior: default|hide|hideItems|showItems (NULL = leave alone)
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE collection_sync (
    definition_id  INTEGER PRIMARY KEY REFERENCES collection_definitions(id) ON DELETE CASCADE,
    server_source  TEXT,                             -- 'plex' | 'jellyfin' the collection lives on
    server_id      TEXT,                             -- native collection / BoxSet id we manage
    members_sig    TEXT,                             -- signature of resolved members + settings
    member_count   INTEGER NOT NULL DEFAULT 0,
    synced_at      TEXT
);
CREATE TABLE credits (
    id         INTEGER PRIMARY KEY,
    person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    movie_id   INTEGER REFERENCES movies(id) ON DELETE CASCADE,
    show_id    INTEGER REFERENCES shows(id)  ON DELETE CASCADE,
    department TEXT NOT NULL,        -- 'cast' | 'crew'
    job        TEXT,                 -- Director | Writer | Creator (crew); 'Actor' (cast)
    character  TEXT,                 -- the role played (cast)
    sort_order INTEGER NOT NULL DEFAULT 0,
    CHECK ((movie_id IS NOT NULL) + (show_id IS NOT NULL) = 1)
);
CREATE TABLE downloads (
    id                 INTEGER PRIMARY KEY,
    movie_id           INTEGER REFERENCES movies(id)         ON DELETE SET NULL,
    episode_id         INTEGER REFERENCES episodes(id)       ON DELETE SET NULL,
    season_id          INTEGER REFERENCES seasons(id)        ON DELETE SET NULL,
    video_id           INTEGER REFERENCES channel_videos(id) ON DELETE SET NULL,
    title              TEXT NOT NULL,        -- display label
    release_title      TEXT,                 -- actual release / nzb / torrent name
    source             TEXT,                 -- torrent | usenet | youtube
    client             TEXT,                 -- qbittorrent | sabnzbd | yt-dlp ...
    client_download_id TEXT,                 -- hash / nzo_id to poll the client
    indexer            TEXT,
    status             TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','downloading','importing',
                                         'completed','failed','paused')),
    quality            TEXT,
    size_bytes         INTEGER,
    downloaded_bytes   INTEGER NOT NULL DEFAULT 0,
    progress           REAL    NOT NULL DEFAULT 0,   -- 0..100
    download_speed_bps INTEGER NOT NULL DEFAULT 0,
    eta_seconds        INTEGER,
    error_message      TEXT,
    added_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at         TEXT,
    completed_at       TEXT,
    CHECK ((movie_id IS NOT NULL) + (episode_id IS NOT NULL)
         + (season_id IS NOT NULL) + (video_id IS NOT NULL) = 1)
);
CREATE TABLE episodes (
    id              INTEGER PRIMARY KEY,
    show_id         INTEGER NOT NULL REFERENCES shows(id)   ON DELETE CASCADE,
    season_id       INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    server_source   TEXT,             -- 'plex' | 'jellyfin'
    server_id       TEXT,             -- media server native id
    season_number   INTEGER NOT NULL,
    episode_number  INTEGER NOT NULL,
    title           TEXT,
    overview        TEXT,
    air_date        TEXT,             -- ISO date — drives the Calendar
    runtime_minutes INTEGER,
    still_url       TEXT,             -- per-episode thumbnail (server image path)
    rating          REAL,             -- audience score (0-10)
    tvdb_id         INTEGER,
    monitored       INTEGER NOT NULL DEFAULT 1,
    has_file        INTEGER NOT NULL DEFAULT 0,
    play_count      INTEGER,          -- server watch state (Plex viewCount / JF UserData.PlayCount)
    last_viewed_at  TEXT,             -- server last-watched stamp
    view_offset_ms  INTEGER, added_at TEXT,          -- resume position (Plex viewOffset / JF PlaybackPositionTicks→ms)
    UNIQUE (show_id, season_number, episode_number)
);
INSERT INTO "episodes" VALUES(1,1,1,'plex','6012',1,1,'Pilot',NULL,'2020-03-01',NULL,NULL,NULL,NULL,1,1,NULL,NULL,NULL,NULL);
CREATE TABLE genres (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE imdb_tmdb_map (
    imdb_id      TEXT PRIMARY KEY,
    movie_tmdb   INTEGER,
    show_tmdb    INTEGER,
    movie_poster TEXT,             -- TMDB poster URL (missing-browser art)
    show_poster  TEXT,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE media_files (
    id             INTEGER PRIMARY KEY,
    movie_id       INTEGER REFERENCES movies(id)         ON DELETE CASCADE,
    episode_id     INTEGER REFERENCES episodes(id)       ON DELETE CASCADE,
    video_id       INTEGER REFERENCES channel_videos(id) ON DELETE CASCADE,
    relative_path  TEXT NOT NULL,
    size_bytes     INTEGER,
    resolution     TEXT,             -- 480p | 720p | 1080p | 2160p
    video_codec    TEXT,
    audio_codec    TEXT,
    release_source TEXT,             -- bluray | web-dl | webrip | hdtv | youtube
    quality        TEXT,             -- resolved quality name
    runtime_seconds INTEGER,
    audio_channels INTEGER,          -- 2 | 6 (5.1) | 8 (7.1)
    dynamic_range  TEXT,             -- HDR10 | HDR10+ | DV | HLG (NULL = SDR)
    atmos          INTEGER,          -- Dolby Atmos audio present
    added_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, aspect TEXT,
    CHECK ((movie_id IS NOT NULL) + (episode_id IS NOT NULL) + (video_id IS NOT NULL) = 1)
);
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE movie_genres (
    movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
    genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (movie_id, genre_id)
);
CREATE TABLE movie_studios (
    movie_id  INTEGER NOT NULL REFERENCES movies(id)  ON DELETE CASCADE,
    studio_id INTEGER NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    PRIMARY KEY (movie_id, studio_id)
);
CREATE TABLE movies (
    id                   INTEGER PRIMARY KEY,
    server_source        TEXT,            -- 'plex' | 'jellyfin' (NULL = not on a server yet, e.g. wishlist)
    server_id            TEXT,            -- media server native id (Plex ratingKey / Jellyfin Item Id)
    tmdb_id              INTEGER,         -- not unique: same film can sit in >1 library
    imdb_id              TEXT,
    tmdb_match_status    TEXT,            -- enrichment: NULL=pending | matched | not_found | error
    tmdb_last_attempted  TEXT,
    title                TEXT NOT NULL,
    sort_title           TEXT,
    year                 INTEGER,
    overview             TEXT,
    runtime_minutes      INTEGER,
    status               TEXT,            -- announced | in_production | released
    release_date         TEXT,            -- primary/theatrical (ISO date)
    digital_release_date TEXT,
    studio               TEXT,
    content_rating       TEXT,            -- e.g. PG-13
    tagline              TEXT,
    tmdb_collection_id   INTEGER,         -- TMDB belongs_to_collection id (franchise); for "complete your collections" gaps
    tmdb_collection_name TEXT,            -- collection display name (e.g. "The Matrix Collection")
    rating               REAL,            -- TMDB audience score (0-10)
    rating_critic        REAL,            -- critic score (0-100) when offered
    imdb_rating          REAL,            -- IMDb (0-10, via OMDb)
    rt_rating            INTEGER,         -- Rotten Tomatoes (0-100)
    metacritic           INTEGER,         -- Metacritic (0-100)
    ratings_synced       INTEGER NOT NULL DEFAULT 0,   -- OMDb ratings fetched?
    poster_url           TEXT,
    backdrop_url         TEXT,
    logo_url             TEXT,            -- transparent title logo (clearlogo)
    monitored            INTEGER NOT NULL DEFAULT 1,   -- tracked for acquisition
    has_file             INTEGER NOT NULL DEFAULT 0,   -- owned? (denormalized)
    quality_profile_id   INTEGER REFERENCES quality_profiles(id) ON DELETE SET NULL,
    root_folder_id       INTEGER REFERENCES root_folders(id)     ON DELETE SET NULL,
    path                 TEXT,            -- folder on disk once owned
    added_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    play_count       INTEGER,                         -- server watch state (viewCount)
    last_viewed_at   TEXT,                             -- server last-watched stamp (Plex lastViewedAt / JF LastPlayedDate)
    view_offset_ms   INTEGER,                         -- resume position (Continue Watching)
    locked_fields    TEXT                             -- JSON list of user-edited (scan/enrichment-immune) fields
, manual_aliases TEXT, preferred_sources TEXT, release_group_allow TEXT, release_group_block TEXT, clearart_url TEXT, banner_url TEXT, fanart_status TEXT, fanart_attempted TEXT, subtitle_langs TEXT, subs_status TEXT, subs_attempted TEXT, trakt_rating REAL, trakt_votes INTEGER, trakt_status TEXT, trakt_attempted TEXT, wikidata_url TEXT, wikidata_status TEXT, wikidata_attempted TEXT, streaming TEXT, streaming_status TEXT, streaming_attempted TEXT, mediastinger INTEGER, mediastinger_status TEXT, mediastinger_attempted TEXT, awards TEXT, awards_status TEXT, awards_attempted TEXT, details_synced INTEGER NOT NULL DEFAULT 0);
INSERT INTO "movies" VALUES(1,'plex','5001',900001,'tt9000001','matched',NULL,'Fixture Movie',NULL,2021,NULL,NULL,'Released',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,1,1,NULL,NULL,'/media/movies/Fixture Movie (2021)/Fixture Movie (2021).mkv','2026-10-20 21:38:54','2026-10-20 21:38:54',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1);
CREATE TABLE networks (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE overlay_apply (
    kind        TEXT NOT NULL,                    -- 'movie' | 'show'
    item_id     INTEGER NOT NULL,
    template_id INTEGER,
    base_sha    TEXT,                             -- sha1 of the clean base we composited
    values_sig  TEXT,                             -- signature of the data that drove the badges
    applied_at  TEXT NOT NULL DEFAULT (datetime('now')), plex_poster_key TEXT,
    PRIMARY KEY (kind, item_id)
);
CREATE TABLE overlay_assignment (
    scope       TEXT PRIMARY KEY,                -- 'movie' | 'show' | 'season' | 'episode'
    template_id INTEGER,                          -- overlay_templates.id (NULL = none)
    enabled     INTEGER NOT NULL DEFAULT 0,
    filter      TEXT,                             -- optional smart-rule JSON: only matching items
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE overlay_templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    definition  TEXT NOT NULL DEFAULT '{}',       -- JSON: {version, canvas:{...}, layers:[...]}
    thumbnail   TEXT,                              -- optional data-URL preview for the gallery card
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE people (
    id        INTEGER PRIMARY KEY,
    name      TEXT NOT NULL,
    tmdb_id   INTEGER UNIQUE,
    photo_url TEXT
);
CREATE TABLE quality_profiles (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    cutoff     TEXT,
    items      TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE root_folders (
    id           INTEGER PRIMARY KEY,
    path         TEXT NOT NULL UNIQUE,
    content_kind TEXT NOT NULL CHECK (content_kind IN ('movie', 'show', 'youtube')),
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "root_folders" VALUES(1,'/media/movies','movie','2026-10-20 21:38:54');
CREATE TABLE seasons (
    id            INTEGER PRIMARY KEY,
    show_id       INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
    server_id     TEXT,             -- media server native id (for reference/refresh)
    season_number INTEGER NOT NULL,
    title         TEXT,
    overview      TEXT,
    poster_url    TEXT,
    monitored     INTEGER NOT NULL DEFAULT 1,
    UNIQUE (show_id, season_number)
);
INSERT INTO "seasons" VALUES(1,1,'6011',1,'Season 1',NULL,NULL,1);
CREATE TABLE show_genres (
    show_id  INTEGER NOT NULL REFERENCES shows(id)  ON DELETE CASCADE,
    genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    PRIMARY KEY (show_id, genre_id)
);
CREATE TABLE show_networks (
    show_id    INTEGER NOT NULL REFERENCES shows(id)    ON DELETE CASCADE,
    network_id INTEGER NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
    PRIMARY KEY (show_id, network_id)
);
CREATE TABLE shows (
    id                 INTEGER PRIMARY KEY,
    server_source      TEXT,             -- 'plex' | 'jellyfin' (NULL = not on a server yet)
    server_id          TEXT,             -- media server native id
    tvdb_id            INTEGER,          -- not unique (same series can sit in >1 library)
    tmdb_id            INTEGER,
    imdb_id            TEXT,
    tmdb_match_status  TEXT,             -- enrichment match state per source
    tmdb_last_attempted TEXT,
    tvdb_match_status  TEXT,
    tvdb_last_attempted TEXT,
    title              TEXT NOT NULL,
    sort_title         TEXT,
    year               INTEGER,
    overview           TEXT,
    status             TEXT,             -- continuing | ended | upcoming
    network            TEXT,
    airs_time          TEXT,             -- TVDB show air time, e.g. "21:00" (network local)
    runtime_minutes    INTEGER,
    content_rating     TEXT,
    tagline            TEXT,
    rating             REAL,             -- TMDB audience score (0-10)
    imdb_rating        REAL,             -- IMDb (0-10, via OMDb)
    rt_rating          INTEGER,          -- Rotten Tomatoes (0-100)
    metacritic         INTEGER,          -- Metacritic (0-100)
    ratings_synced     INTEGER NOT NULL DEFAULT 0,   -- OMDb ratings fetched?
    first_air_date     TEXT,
    last_air_date      TEXT,
    poster_url         TEXT,
    backdrop_url       TEXT,
    logo_url           TEXT,             -- transparent title logo (clearlogo)
    episodes_synced    INTEGER NOT NULL DEFAULT 0,   -- full episode list pulled from metadata?
    monitored          INTEGER NOT NULL DEFAULT 1,   -- "following" (watchlist)
    series_type        TEXT,                -- standard | daily | anime (NULL = standard)
    quality_profile_id INTEGER REFERENCES quality_profiles(id) ON DELETE SET NULL,
    root_folder_id     INTEGER REFERENCES root_folders(id)     ON DELETE SET NULL,
    path               TEXT,
    added_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    watched_episodes INTEGER,                         -- server watch state (viewed leaf count)
    locked_fields    TEXT                             -- JSON list of user-edited (scan/enrichment-immune) fields
, manual_aliases TEXT, preferred_sources TEXT, release_group_allow TEXT, release_group_block TEXT, pack_preference TEXT, clearart_url TEXT, banner_url TEXT, fanart_status TEXT, fanart_attempted TEXT, subtitle_langs TEXT, subs_status TEXT, subs_attempted TEXT, trakt_rating REAL, trakt_votes INTEGER, trakt_status TEXT, trakt_attempted TEXT, tvmaze_rating REAL, tvmaze_status TEXT, tvmaze_attempted TEXT, anilist_score INTEGER, anilist_status TEXT, anilist_attempted TEXT, wikidata_url TEXT, wikidata_status TEXT, wikidata_attempted TEXT, streaming TEXT, streaming_status TEXT, streaming_attempted TEXT, mediastinger INTEGER, mediastinger_status TEXT, mediastinger_attempted TEXT, awards TEXT, awards_status TEXT, awards_attempted TEXT, details_synced INTEGER NOT NULL DEFAULT 0);
INSERT INTO "shows" VALUES(1,'plex','6001',NULL,900101,NULL,'matched',NULL,NULL,NULL,'Fixture Show',NULL,2020,NULL,'Returning Series',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,0,1,NULL,NULL,NULL,NULL,'2026-10-20 21:38:54','2026-10-20 21:38:54',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1);
CREATE TABLE studios (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE video_blocklist (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    kind           TEXT,                          -- movie | show (what the grab was for)
    title          TEXT,                          -- media title, for the management modal
    media_id       TEXT,
    media_source   TEXT,
    season_number  INTEGER,
    episode_number INTEGER,
    username       TEXT NOT NULL,                 -- slskd uploader
    filename       TEXT NOT NULL,                 -- full remote path = release identity
    release_title  TEXT,
    reason         TEXT,                          -- why it was blocked
    created_at     TEXT DEFAULT (datetime('now')),
    UNIQUE(username, filename)
);
CREATE TABLE video_download_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    download_id    INTEGER,                       -- original video_downloads.id (transient)
    kind           TEXT NOT NULL,                 -- movie | show
    media_type     TEXT,                          -- movie | show (normalized; the scan scope)
    title          TEXT,                          -- movie/show title
    year           INTEGER,
    season_number  INTEGER,                       -- episodes only
    episode_number INTEGER,
    episode_title  TEXT,
    release_title  TEXT,                          -- the release/file grabbed
    source         TEXT,                          -- soulseek | torrent | usenet
    username       TEXT,                          -- uploader (soulseek)
    filename       TEXT,                          -- remote filename grabbed
    dest_path      TEXT,                          -- final placed path
    size_bytes     INTEGER DEFAULT 0,
    quality_label  TEXT,                          -- e.g. "1080p", "2160p HDR"
    resolution     TEXT,                          -- parsed from the release name, best-effort
    video_codec    TEXT,
    media_id       TEXT,                          -- movie/show id for the detail deep-link
    media_source   TEXT,                          -- library | tmdb
    poster_url     TEXT,
    outcome        TEXT NOT NULL DEFAULT 'completed', -- completed | import_failed | failed | cancelled
    error          TEXT,                          -- failure reason (non-completed)
    grabbed_at     TEXT,                          -- when the download started
    completed_at   TEXT,                          -- terminal time
    created_at     TEXT DEFAULT (datetime('now'))
, channel_id TEXT, published_at TEXT, pruned_at TEXT, cleared_at TEXT);
CREATE TABLE video_downloads (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL,                 -- movie | show | youtube
    title         TEXT,                          -- human title (e.g. the movie name)
    release_title TEXT,                          -- the release/file being grabbed
    source        TEXT,                          -- soulseek | torrent | usenet
    username      TEXT,                          -- slskd uploader (for the grab + status)
    filename      TEXT,                          -- slskd remote filename (full path)
    size_bytes    INTEGER DEFAULT 0,
    quality_label TEXT,
    media_id      TEXT,                          -- the movie/show id (for the detail-page link)
    media_source  TEXT,                          -- library | tmdb
    year          INTEGER,
    poster_url    TEXT,                          -- poster for the Downloads card
    target_dir    TEXT,                          -- destination library folder
    dest_path     TEXT,                          -- final moved path (set on completion)
    status        TEXT NOT NULL DEFAULT 'downloading',
    progress      REAL DEFAULT 0,
    error         TEXT,
    candidates    TEXT,                          -- JSON: remaining best-first hits to retry
    search_ctx    TEXT,                          -- JSON: {scope,title,year,season,episode}
    tried_queries TEXT,                          -- JSON: slskd queries already searched
    tried_files   TEXT,                          -- JSON: release filenames already attempted
    attempts      INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    completed_at  TEXT
, import_phase TEXT, import_progress REAL DEFAULT 0, client_ref TEXT, progress_at TEXT, speed_bps INTEGER, eta_seconds INTEGER, quality_profile_id INTEGER, seed_released INTEGER, indexer_id INTEGER);
CREATE TABLE video_extto_cache (
    url        TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,                  -- parsed detail facts (JSON)
    fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE video_ignored (
    kind       TEXT    NOT NULL,           -- 'movie' | 'show'
    tmdb_id    INTEGER NOT NULL,
    title      TEXT,
    year       INTEGER,
    poster_url TEXT,
    added_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (kind, tmdb_id)
);
CREATE TABLE video_issues (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id     INTEGER NOT NULL DEFAULT 1,
    reporter_name  TEXT,
    entity_type    TEXT NOT NULL,                  -- movie | show | episode
    entity_id      TEXT NOT NULL,                  -- library row id (string)
    category       TEXT NOT NULL,
    title          TEXT NOT NULL,
    description    TEXT,
    snapshot_data  TEXT DEFAULT '{}',
    status         TEXT NOT NULL DEFAULT 'open',   -- open | in_progress | resolved | dismissed
    priority       TEXT NOT NULL DEFAULT 'normal', -- low | normal | high
    admin_response TEXT,
    resolved_by    INTEGER,
    resolved_at    TIMESTAMP,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE video_manual_matches (
    kind       TEXT NOT NULL CHECK (kind IN ('movie', 'show')),
    tmdb_id    INTEGER NOT NULL,
    library_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (kind, tmdb_id)
);
CREATE TABLE video_repair_findings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id        TEXT NOT NULL,
    finding_type  TEXT NOT NULL,
    severity      TEXT NOT NULL DEFAULT 'info',      -- info | warning | critical
    status        TEXT NOT NULL DEFAULT 'pending',   -- pending | resolved | dismissed
    entity_type   TEXT,                              -- 'show' | 'movie' | 'episode' | 'file'
    entity_id     TEXT,
    file_path     TEXT,
    title         TEXT NOT NULL,
    description   TEXT,
    details_json  TEXT DEFAULT '{}',                 -- per-finding-type payload (fix input)
    user_action   TEXT,                              -- what the fix did (badge label)
    resolved_at   TIMESTAMP,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE video_repair_job_runs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id            TEXT NOT NULL,
    started_at        TIMESTAMP NOT NULL,
    finished_at       TIMESTAMP,
    duration_seconds  REAL,
    items_scanned     INTEGER DEFAULT 0,
    findings_created  INTEGER DEFAULT 0,
    auto_fixed        INTEGER DEFAULT 0,
    errors            INTEGER DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'running'   -- running | completed
);
CREATE TABLE video_requests (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id     INTEGER NOT NULL DEFAULT 1,
    requester_name TEXT,
    kind           TEXT NOT NULL,                  -- movie | show
    tmdb_id        INTEGER NOT NULL,
    title          TEXT NOT NULL,
    year           INTEGER,
    poster_url     TEXT,
    note           TEXT,                           -- the requester's "why"
    monitor        TEXT DEFAULT 'future',          -- shows: P2 monitor policy applied on approve
    status         TEXT NOT NULL DEFAULT 'pending',-- pending | approved | denied
    admin_response TEXT,
    resolved_by    INTEGER,
    resolved_at    TIMESTAMP,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    available_at   TEXT,                           -- when the approved title reached the library
    quality_profile_id INTEGER                     -- asked-for quality profile (NULL = default)
);
CREATE TABLE video_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "video_settings" VALUES('studio_network_links_seeded','1','2026-10-20 21:38:54');
CREATE TABLE video_watchlist (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,             -- 'show' | 'person' | 'channel' (youtube)
    tmdb_id     INTEGER NOT NULL,          -- tmdb id; for non-tmdb sources a stable surrogate of source_id
    title       TEXT NOT NULL,             -- show title / person name / channel title
    poster_url  TEXT,                      -- poster (show) / photo (person) / avatar (channel)
    library_id  INTEGER,                   -- shows.id when owned (else NULL)
    -- generic source bridge: 'tmdb' (default) or 'youtube'; source_id = native id
    -- (channel youtube id) for non-tmdb rows. One table, both worlds.
    source      TEXT NOT NULL DEFAULT 'tmdb',
    source_id   TEXT,
    -- 'follow' = explicit user follow. 'mute' = a TOMBSTONE: the user
    -- un-followed something that is on the watchlist by default (an actively
    -- airing library show), so the default must not re-add it. Library shows
    -- that are still airing are watched by default WITHOUT a row here.
    state       TEXT NOT NULL DEFAULT 'follow',
    date_added  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, lookback_years INTEGER,
    UNIQUE(kind, tmdb_id)
);
INSERT INTO "video_watchlist" VALUES(1,'show',900101,'Fixture Show',NULL,1,'tmdb',NULL,'follow','2026-07-01 10:00:00',NULL);
CREATE TABLE video_wishlist (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    kind           TEXT NOT NULL,            -- 'movie' | 'episode' | 'video' (youtube)
    tmdb_id        INTEGER NOT NULL,         -- movie's tmdb id | the SHOW's tmdb id (episode) | channel surrogate (video)
    title          TEXT NOT NULL,            -- movie title | show title | channel title (video rows)
    poster_url     TEXT,                     -- movie/show poster | channel avatar (video rows)
    year           INTEGER,                  -- movie year (movie rows)
    season_number  INTEGER,                  -- episode rows
    episode_number INTEGER,                  -- episode rows
    episode_title  TEXT,                     -- episode rows | video title (video rows)
    still_url      TEXT,                     -- episode still | video thumbnail (video rows)
    episode_overview  TEXT,                  -- episode synopsis | video description (video rows)
    season_poster_url TEXT,                  -- the episode's SEASON poster (episode rows)
    air_date       TEXT,                     -- episode air date | video published_at (video rows)
    status         TEXT NOT NULL DEFAULT 'wanted',  -- wanted|searching|downloading|downloaded|failed
    library_id     INTEGER,                  -- owned movies.id/shows.id when re-downloading
    server_source  TEXT,                     -- server context that added it (informational)
    -- generic source bridge (mirrors video_watchlist). For 'video' rows:
    -- source='youtube', source_id=video youtube id, parent_source_id=channel youtube id.
    source         TEXT NOT NULL DEFAULT 'tmdb',
    source_id      TEXT,
    parent_source_id TEXT,                   -- owning channel's youtube id (video rows)
    date_added     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    search_attempts INTEGER DEFAULT 0,       -- consecutive fruitless drain searches (reset on grab)
    last_search_at  TEXT                     -- when the drain last searched this row
, last_refusal TEXT, last_refusal_quality TEXT, search_snapshot TEXT, release_date TEXT, quality_profile_id INTEGER, detail_json TEXT);
INSERT INTO "video_wishlist" VALUES(1,'movie',900002,'Wished Fixture Movie',NULL,2024,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'wanted',NULL,NULL,'tmdb',NULL,NULL,'2026-07-02 10:00:00',0,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "video_wishlist" VALUES(2,'episode',900101,'Fixture Show',NULL,NULL,1,2,'Second Episode',NULL,NULL,NULL,'2020-03-08','wanted',1,NULL,'tmdb',NULL,NULL,'2026-07-02 10:05:00',0,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
CREATE TABLE youtube_channel_enrichment (
    channel_id  TEXT PRIMARY KEY,
    enriched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    date_count  INTEGER NOT NULL DEFAULT 0,
    method      TEXT                        -- 'innertube' | 'fallback'; NULL = legacy → re-enrich once
);
CREATE TABLE youtube_channel_meta (
    channel_id       TEXT PRIMARY KEY,
    title            TEXT,
    handle           TEXT,
    description      TEXT,
    avatar_url       TEXT,
    banner_url       TEXT,
    subscriber_count INTEGER,
    view_count       INTEGER,
    tags             TEXT,                  -- JSON array
    cached_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE youtube_channel_videos (
    channel_id    TEXT NOT NULL,
    youtube_id    TEXT NOT NULL,
    title         TEXT,
    thumbnail_url TEXT,
    duration      TEXT,                  -- overlay badge, e.g. "12:34"
    view_count    INTEGER,               -- approximate (parsed from "2.6M views")
    cached_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channel_id, youtube_id)
);
CREATE TABLE youtube_video_dates (
    youtube_id   TEXT PRIMARY KEY,
    published_at TEXT,
    cached_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE youtube_video_segments (
    youtube_id TEXT NOT NULL,
    category   TEXT NOT NULL,           -- sponsor | intro | outro | selfpromo | interaction | music_offtopic | preview | filler | poi_highlight | chapter
    start_sec  REAL NOT NULL,
    end_sec    REAL NOT NULL,
    votes      INTEGER,
    uuid       TEXT NOT NULL,
    PRIMARY KEY (youtube_id, uuid)
);
CREATE TABLE youtube_video_stats (
    youtube_id      TEXT PRIMARY KEY,
    like_count      INTEGER,
    dislike_count   INTEGER,
    ryd_status      TEXT,
    ryd_attempted   TEXT,
    sb_status       TEXT,
    sb_attempted    TEXT,
    dearrow_title   TEXT,                  -- DeArrow crowd-sourced better title
    dearrow_status  TEXT,
    dearrow_attempted TEXT
);
CREATE INDEX idx_movies_tmdb       ON movies(tmdb_id);
CREATE INDEX idx_movies_monitored  ON movies(monitored, has_file);
CREATE INDEX idx_movies_release    ON movies(release_date);
CREATE UNIQUE INDEX ux_movies_server ON movies(server_source, server_id);
CREATE INDEX idx_shows_tvdb      ON shows(tvdb_id);
CREATE INDEX idx_shows_monitored ON shows(monitored);
CREATE UNIQUE INDEX ux_shows_server ON shows(server_source, server_id);
CREATE INDEX idx_seasons_show ON seasons(show_id);
CREATE INDEX idx_episodes_show     ON episodes(show_id);
CREATE INDEX idx_episodes_air      ON episodes(air_date);
CREATE INDEX idx_episodes_wanted   ON episodes(monitored, has_file);
CREATE INDEX idx_movie_genres_genre ON movie_genres(genre_id);
CREATE INDEX idx_show_genres_genre  ON show_genres(genre_id);
CREATE INDEX idx_movie_studios_studio  ON movie_studios(studio_id);
CREATE INDEX idx_show_networks_network ON show_networks(network_id);
CREATE INDEX idx_people_name ON people(name);
CREATE INDEX idx_credits_movie  ON credits(movie_id);
CREATE INDEX idx_credits_show   ON credits(show_id);
CREATE INDEX idx_credits_person ON credits(person_id);
CREATE INDEX idx_channels_monitored ON channels(monitored);
CREATE INDEX idx_channel_videos_channel   ON channel_videos(channel_id);
CREATE INDEX idx_channel_videos_published ON channel_videos(published_at);
CREATE INDEX idx_channel_videos_wanted    ON channel_videos(monitored, has_file);
CREATE INDEX idx_ycv_channel ON youtube_channel_videos(channel_id);
CREATE INDEX idx_yvseg_video ON youtube_video_segments(youtube_id);
CREATE INDEX idx_media_files_movie   ON media_files(movie_id);
CREATE INDEX idx_media_files_episode ON media_files(episode_id);
CREATE INDEX idx_media_files_video   ON media_files(video_id);
CREATE INDEX idx_downloads_status    ON downloads(status);
CREATE INDEX idx_downloads_completed ON downloads(completed_at);
CREATE INDEX idx_activity_created ON activity(created_at);
CREATE INDEX idx_video_watchlist_kind ON video_watchlist(kind);
CREATE UNIQUE INDEX idx_video_wishlist_movie
    ON video_wishlist(tmdb_id) WHERE kind = 'movie';
CREATE UNIQUE INDEX idx_video_wishlist_episode
    ON video_wishlist(tmdb_id, season_number, episode_number) WHERE kind = 'episode';
CREATE INDEX idx_video_wishlist_show ON video_wishlist(tmdb_id) WHERE kind = 'episode';
CREATE VIEW v_watchlist AS
    SELECT 'show'    AS kind, id, title, status, poster_url, monitored
      FROM shows    WHERE monitored = 1
    UNION ALL
    SELECT 'channel' AS kind, id, title, NULL AS status, avatar_url AS poster_url, monitored
      FROM channels WHERE monitored = 1;
CREATE VIEW v_wishlist AS
    SELECT 'movie'   AS kind, m.id AS ref_id, m.title AS title,
           NULL AS parent_title, m.release_date AS due_date
      FROM movies m
     WHERE m.monitored = 1 AND m.has_file = 0
    UNION ALL
    SELECT 'episode' AS kind, e.id AS ref_id,
           e.title AS title, s.title AS parent_title, e.air_date AS due_date
      FROM episodes e
      JOIN shows s ON s.id = e.show_id
     WHERE e.monitored = 1 AND e.has_file = 0
       AND e.air_date IS NOT NULL AND e.air_date <= date('now');
CREATE VIEW v_calendar AS
    SELECT 'episode' AS kind, e.id AS ref_id, e.air_date AS date,
           e.title AS title, s.title AS parent_title
      FROM episodes e JOIN shows s ON s.id = e.show_id
     WHERE e.air_date IS NOT NULL
    UNION ALL
    SELECT 'movie' AS kind, m.id AS ref_id, m.release_date AS date,
           m.title AS title, NULL AS parent_title
      FROM movies m WHERE m.release_date IS NOT NULL
    UNION ALL
    SELECT 'video' AS kind, v.id AS ref_id, v.published_at AS date,
           v.title AS title, c.title AS parent_title
      FROM channel_videos v JOIN channels c ON c.id = v.channel_id
     WHERE v.published_at IS NOT NULL;
CREATE INDEX idx_video_downloads_status ON video_downloads(status);
CREATE INDEX idx_video_blocklist_file ON video_blocklist(filename);
CREATE INDEX idx_vdl_history_kind ON video_download_history(kind);
CREATE INDEX idx_vdl_history_completed ON video_download_history(completed_at);
CREATE UNIQUE INDEX idx_vdl_history_dedup
    ON video_download_history(download_id, outcome, dest_path);
CREATE INDEX idx_overlay_templates_updated ON overlay_templates(updated_at DESC);
CREATE INDEX idx_collection_defs_updated ON collection_definitions(updated_at DESC);
CREATE INDEX idx_vrf_job     ON video_repair_findings(job_id);
CREATE INDEX idx_vrf_status  ON video_repair_findings(status);
CREATE INDEX idx_vrf_type    ON video_repair_findings(finding_type);
CREATE INDEX idx_vrf_created ON video_repair_findings(created_at);
CREATE INDEX idx_vrjr_job ON video_repair_job_runs(job_id);
CREATE INDEX idx_vreq_profile ON video_requests(profile_id);
CREATE INDEX idx_vreq_status  ON video_requests(status);
CREATE INDEX idx_vreq_title   ON video_requests(kind, tmdb_id);
CREATE INDEX idx_vissues_profile ON video_issues(profile_id);
CREATE INDEX idx_vissues_status  ON video_issues(status);
CREATE INDEX idx_vissues_entity  ON video_issues(entity_type, entity_id);
CREATE INDEX idx_vissues_created ON video_issues(created_at);
CREATE INDEX idx_extto_cache_at ON video_extto_cache(fetched_at);
CREATE INDEX idx_manual_matches_library ON video_manual_matches(library_id);
CREATE UNIQUE INDEX idx_video_wishlist_video ON video_wishlist(source_id) WHERE kind = 'video';
CREATE INDEX idx_video_wishlist_channel ON video_wishlist(parent_source_id) WHERE kind = 'video';
CREATE INDEX idx_movies_collection ON movies(tmdb_collection_id);
CREATE INDEX idx_episodes_show_added ON episodes(show_id, added_at);
CREATE INDEX idx_shows_tmdb ON shows(tmdb_id);
CREATE INDEX idx_episodes_show_file ON episodes(show_id, has_file);
CREATE INDEX idx_episodes_show_season_ep ON episodes(show_id, season_number, episode_number);
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('video_watchlist',1);
INSERT INTO "sqlite_sequence" VALUES('video_wishlist',2);
COMMIT;
