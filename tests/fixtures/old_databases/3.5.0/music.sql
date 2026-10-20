-- SoulSync 3.5.0 (dabb7b0ef5fbb5bac142802e8e84f48585237572) music database as that release creates it,
-- plus the representative rows listed in manifest.json.
-- Regenerate with: python tests/fixtures/old_databases/generate.py 3.5.0
PRAGMA user_version=1;
BEGIN TRANSACTION;
CREATE TABLE _cache_junk_artist_purged (applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE _deezer_cache_v2_migrated (applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE _discovery_cache_v2_migrated (applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE _genius_search_fix_applied (applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE _source_id_dedupe_v2 (applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE _tidal_search_fix_applied (applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE album_artist_credits (
            album_id TEXT NOT NULL,
            source TEXT NOT NULL,
            position INTEGER NOT NULL,
            name TEXT NOT NULL,
            source_artist_id TEXT,
            PRIMARY KEY (album_id, source, position)
        ) WITHOUT ROWID
    ;
CREATE TABLE album_artist_credits_pending (
            album_id TEXT NOT NULL,
            source TEXT NOT NULL,
            PRIMARY KEY (source, album_id)
        ) WITHOUT ROWID
    ;
CREATE TABLE "albums" (
                    id TEXT PRIMARY KEY,
                    artist_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    year INTEGER,
                    release_date TEXT,
                    thumb_url TEXT,
                    genres TEXT,
                    track_count INTEGER,
                    duration INTEGER,
                    server_source TEXT DEFAULT 'plex',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, musicbrainz_release_id TEXT, musicbrainz_last_attempted TIMESTAMP, musicbrainz_match_status TEXT, spotify_album_id TEXT, itunes_album_id TEXT, audiodb_id TEXT, audiodb_match_status TEXT, audiodb_last_attempted TIMESTAMP, style TEXT, mood TEXT, deezer_id TEXT, deezer_match_status TEXT, deezer_last_attempted TIMESTAMP, label TEXT, explicit INTEGER, record_type TEXT, jiosaavn_id TEXT, jiosaavn_match_status TEXT, jiosaavn_last_attempted TIMESTAMP, spotify_match_status TEXT, spotify_last_attempted TIMESTAMP, itunes_match_status TEXT, itunes_last_attempted TIMESTAMP, lastfm_match_status TEXT, lastfm_last_attempted TIMESTAMP, lastfm_listeners INTEGER, lastfm_playcount INTEGER, lastfm_tags TEXT, lastfm_wiki TEXT, lastfm_url TEXT, tidal_id TEXT, tidal_match_status TEXT, tidal_last_attempted TIMESTAMP, qobuz_id TEXT, qobuz_match_status TEXT, qobuz_last_attempted TIMESTAMP, upc TEXT, copyright TEXT, discogs_id TEXT, discogs_match_status TEXT, discogs_genres TEXT, discogs_styles TEXT, discogs_label TEXT, discogs_catno TEXT, discogs_country TEXT, discogs_last_attempted TIMESTAMP, discogs_rating REAL, discogs_rating_count INTEGER, amazon_id TEXT, amazon_match_status TEXT, amazon_last_attempted TIMESTAMP, bandcamp_id TEXT, bandcamp_match_status TEXT, bandcamp_last_attempted TIMESTAMP, bandcamp_url TEXT, bandcamp_tags TEXT, bandcamp_label TEXT, owner_profile_id INTEGER DEFAULT NULL, soul_id TEXT DEFAULT NULL, api_track_count INTEGER DEFAULT NULL, title_norm TEXT, canonical_source TEXT DEFAULT NULL, canonical_album_id TEXT DEFAULT NULL, canonical_score REAL DEFAULT NULL, canonical_resolved_at TIMESTAMP DEFAULT NULL, canonical_locked INTEGER DEFAULT 0, canonical_track_count INTEGER DEFAULT NULL, art_locked INTEGER DEFAULT 0, genres_locked INTEGER DEFAULT 0, metadata_locked INTEGER DEFAULT 0,
                    FOREIGN KEY (artist_id) REFERENCES "artists" (id) ON DELETE CASCADE
                );
INSERT INTO "albums" VALUES('9101','9001','Fixture Album (Deluxe Edition)',2019,NULL,'/library/metadata/9101/thumb/1700000000','["Rock", "Indie Rock"]',2,431000,'plex','2026-10-20 21:38:54','2026-10-20 21:38:54',NULL,NULL,NULL,'2noRn2Aes5aoNVsU6iWThc',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,0,0,0);
PRAGMA writable_schema=ON;
INSERT INTO sqlite_master(type,name,tbl_name,rootpage,sql)VALUES('table','albums_fts','albums_fts',0,'CREATE VIRTUAL TABLE albums_fts USING fts5(
                    title_norm, content=''albums'', content_rowid=''rowid'', tokenize=''trigram''
                )');
CREATE TABLE 'albums_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
INSERT INTO "albums_fts_config" VALUES('version',4);
CREATE TABLE 'albums_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
INSERT INTO "albums_fts_data" VALUES(1,X'0100');
INSERT INTO "albums_fts_data" VALUES(10,X'00000000000000');
CREATE TABLE 'albums_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
INSERT INTO "albums_fts_docsize" VALUES(1,X'00');
CREATE TABLE 'albums_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
CREATE TABLE arcade_bank (
                    profile_id INTEGER PRIMARY KEY,
                    balance INTEGER NOT NULL DEFAULT 0,
                    refilled_on TEXT NOT NULL DEFAULT '',
                    lifetime_won INTEGER NOT NULL DEFAULT 0,
                    lifetime_lost INTEGER NOT NULL DEFAULT 0,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
CREATE TABLE "artists" (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    thumb_url TEXT,
                    genres TEXT,
                    summary TEXT,
                    server_source TEXT DEFAULT 'plex',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                , musicbrainz_id TEXT, musicbrainz_last_attempted TIMESTAMP, musicbrainz_match_status TEXT, aliases TEXT, spotify_artist_id TEXT, itunes_artist_id TEXT, audiodb_id TEXT, audiodb_match_status TEXT, audiodb_last_attempted TIMESTAMP, style TEXT, mood TEXT, label TEXT, banner_url TEXT, deezer_id TEXT, deezer_match_status TEXT, deezer_last_attempted TIMESTAMP, jiosaavn_id TEXT, jiosaavn_match_status TEXT, jiosaavn_last_attempted TIMESTAMP, spotify_match_status TEXT, spotify_last_attempted TIMESTAMP, itunes_match_status TEXT, itunes_last_attempted TIMESTAMP, lastfm_match_status TEXT, lastfm_last_attempted TIMESTAMP, lastfm_listeners INTEGER, lastfm_playcount INTEGER, lastfm_tags TEXT, lastfm_similar TEXT, lastfm_bio TEXT, lastfm_url TEXT, genius_id TEXT, genius_match_status TEXT, genius_last_attempted TIMESTAMP, genius_description TEXT, genius_alt_names TEXT, genius_url TEXT, tidal_id TEXT, tidal_match_status TEXT, tidal_last_attempted TIMESTAMP, qobuz_id TEXT, qobuz_match_status TEXT, qobuz_last_attempted TIMESTAMP, discogs_id TEXT, discogs_match_status TEXT, discogs_bio TEXT, discogs_members TEXT, discogs_urls TEXT, discogs_last_attempted TIMESTAMP, amazon_id TEXT, amazon_match_status TEXT, amazon_last_attempted TIMESTAMP, similar_artists_match_status TEXT, similar_artists_last_attempted TIMESTAMP, owner_profile_id INTEGER DEFAULT NULL, soul_id TEXT DEFAULT NULL, soul_id_path TEXT DEFAULT NULL, name_norm TEXT, name_key TEXT, art_locked INTEGER DEFAULT 0, genres_locked INTEGER DEFAULT 0);
INSERT INTO "artists" VALUES('9001','Fixture Artist','/library/metadata/9001/thumb/1700000000','Rock, Indie Rock','Artist row written by the upgrade-test fixture generator.','plex','2026-10-20 21:38:54','2026-10-20 21:38:54','f1d1c2a0-0000-4000-8000-000000009001',NULL,NULL,NULL,'0OdUWJ0sBjDrqHygGUXeCF',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,0);
CREATE TABLE auto_import_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    folder_name TEXT NOT NULL,
                    folder_path TEXT NOT NULL,
                    folder_hash TEXT,
                    status TEXT NOT NULL DEFAULT 'scanning',
                    confidence REAL DEFAULT 0.0,
                    album_id TEXT,
                    album_name TEXT,
                    artist_name TEXT,
                    image_url TEXT,
                    total_files INTEGER DEFAULT 0,
                    matched_files INTEGER DEFAULT 0,
                    match_data TEXT,
                    identification_method TEXT,
                    error_message TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    processed_at TIMESTAMP
                );
CREATE TABLE automation_run_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    automation_id INTEGER NOT NULL,
                    started_at TIMESTAMP,
                    finished_at TIMESTAMP,
                    duration_seconds REAL,
                    status TEXT NOT NULL,
                    summary TEXT,
                    result_json TEXT,
                    log_lines TEXT,
                    FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE
                );
CREATE TABLE automations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    enabled INTEGER DEFAULT 1,
                    trigger_type TEXT NOT NULL,
                    trigger_config TEXT DEFAULT '{}',
                    action_type TEXT NOT NULL,
                    action_config TEXT DEFAULT '{}',
                    last_run TIMESTAMP,
                    next_run TIMESTAMP,
                    run_count INTEGER DEFAULT 0,
                    last_error TEXT,
                    profile_id INTEGER DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                , notify_type TEXT DEFAULT NULL, notify_config TEXT DEFAULT '{}', last_result TEXT DEFAULT NULL, is_system INTEGER DEFAULT 0, then_actions TEXT DEFAULT '[]', group_name TEXT DEFAULT NULL, owned_by TEXT DEFAULT NULL);
CREATE TABLE blocklist (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile_id INTEGER NOT NULL DEFAULT 1,
                    entity_type TEXT NOT NULL,        -- 'artist' | 'album' | 'track'
                    name TEXT NOT NULL COLLATE NOCASE,
                    spotify_id TEXT,
                    itunes_id TEXT,
                    deezer_id TEXT,
                    musicbrainz_id TEXT,
                    parent_name TEXT,                 -- display only (album's/track's artist)
                    match_status TEXT DEFAULT 'pending',  -- pending | matched (cross-source backfill)
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
CREATE TABLE "bubble_snapshots" (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            type TEXT NOT NULL,
                            data TEXT NOT NULL,
                            timestamp TEXT NOT NULL,
                            snapshot_id TEXT NOT NULL,
                            profile_id INTEGER DEFAULT 1,
                            UNIQUE(profile_id, type)
                        );
CREATE TABLE chat_game_carriers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    room TEXT NOT NULL,
                    game_id TEXT NOT NULL,
                    username TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(room, username, timestamp, payload) ON CONFLICT IGNORE
                );
CREATE TABLE chat_room_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    room TEXT NOT NULL,
                    username TEXT NOT NULL,
                    message TEXT NOT NULL,
                    rich INTEGER NOT NULL DEFAULT 0,
                    timestamp TEXT NOT NULL,
                    reply TEXT,
                    file TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, chan TEXT, thread TEXT, thread_name TEXT, av INTEGER, edit_target TEXT, overlay TEXT, np TEXT, want TEXT, badge TEXT,
                    UNIQUE(room, username, timestamp, message) ON CONFLICT IGNORE
                );
CREATE TABLE chat_room_reactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    room TEXT NOT NULL,
                    target_key TEXT NOT NULL,
                    emoji TEXT NOT NULL,
                    username TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(room, target_key, emoji, username) ON CONFLICT IGNORE
                );
CREATE TABLE chat_user_notes (
                    username TEXT PRIMARY KEY,
                    note TEXT NOT NULL DEFAULT '',
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
CREATE TABLE curation_signals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    server TEXT NOT NULL,
                    user_key TEXT NOT NULL,
                    track_key TEXT NOT NULL,
                    favorite INTEGER DEFAULT 0,
                    rating REAL,
                    in_playlist INTEGER DEFAULT 0,
                    source_path TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(server, user_key, track_key)
                );
CREATE TABLE discovery_artist_blacklist (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    artist_name TEXT NOT NULL COLLATE NOCASE,
                    spotify_artist_id TEXT,
                    itunes_artist_id TEXT,
                    deezer_artist_id TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(artist_name)
                );
CREATE TABLE "discovery_curated_playlists" (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            playlist_type TEXT NOT NULL,
                            track_ids_json TEXT NOT NULL,
                            curated_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            profile_id INTEGER DEFAULT 1,
                            UNIQUE(profile_id, playlist_type)
                        );
CREATE TABLE discovery_feedback (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile_id INTEGER NOT NULL DEFAULT 1,
                    entity_type TEXT NOT NULL,        -- artist | album | track
                    entity_key TEXT NOT NULL,         -- normalised artist[, title]
                    name TEXT NOT NULL,
                    artist_name TEXT,
                    ids_json TEXT,                    -- {source: id}
                    kind TEXT NOT NULL,               -- more | less | not_now
                    seed_context_json TEXT,           -- the explanation it was shown with
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    expires_at TIMESTAMP              -- not_now only
                );
CREATE TABLE discovery_inbox (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile_id INTEGER NOT NULL DEFAULT 1,
                    kind TEXT NOT NULL,               -- new_release | upcoming | saved_rec | concert | artist_news
                    entity_key TEXT NOT NULL,
                    title TEXT NOT NULL,
                    artist_name TEXT,
                    image_url TEXT,
                    item_date TEXT,                   -- release or event date, YYYY-MM-DD
                    payload_json TEXT,
                    state TEXT NOT NULL DEFAULT 'unread',  -- unread | saved | dismissed | added
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (profile_id, kind, entity_key)
                );
CREATE TABLE discovery_layout (
                    profile_id INTEGER NOT NULL,
                    section_id TEXT NOT NULL,
                    zone TEXT NOT NULL,
                    position INTEGER NOT NULL DEFAULT 0,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    PRIMARY KEY (profile_id, section_id)
                );
CREATE TABLE discovery_match_cache (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    normalized_title TEXT NOT NULL,
                    normalized_artist TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    match_confidence REAL NOT NULL,
                    matched_data_json TEXT NOT NULL,
                    original_title TEXT,
                    original_artist TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    use_count INTEGER DEFAULT 1,
                    UNIQUE(normalized_title, normalized_artist, provider)
                );
CREATE TABLE "discovery_pool" (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            spotify_track_id TEXT,
                            spotify_album_id TEXT,
                            spotify_artist_id TEXT,
                            itunes_track_id TEXT,
                            itunes_album_id TEXT,
                            itunes_artist_id TEXT,
                            deezer_track_id TEXT,
                            deezer_album_id TEXT,
                            deezer_artist_id TEXT,
                            source TEXT NOT NULL DEFAULT 'spotify',
                            track_name TEXT NOT NULL,
                            artist_name TEXT NOT NULL,
                            album_name TEXT NOT NULL,
                            album_cover_url TEXT,
                            duration_ms INTEGER,
                            popularity INTEGER DEFAULT 0,
                            release_date TEXT,
                            is_new_release BOOLEAN DEFAULT 0,
                            track_data_json TEXT NOT NULL,
                            artist_genres TEXT,
                            added_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            profile_id INTEGER DEFAULT 1,
                            UNIQUE(profile_id, spotify_track_id, itunes_track_id, source)
                        );
INSERT INTO "discovery_pool" VALUES(461,'7fixtureDiscovery0000','5fixtureDiscAlbum0000','4Z8W4fKeB5YxbusRsdQVPb',NULL,NULL,NULL,NULL,NULL,NULL,'spotify','Discovered Tune','Similar Fixture Band','Found Sounds','https://i.scdn.co/image/fixture-found',198000,37,'2025-11-01',0,'{"id": "7fixtureDiscovery0000", "name": "Discovered Tune"}',NULL,'2026-10-20 21:38:54',1);
CREATE TABLE "discovery_pool_metadata" (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            profile_id INTEGER NOT NULL DEFAULT 1 UNIQUE,
                            last_populated_timestamp TIMESTAMP NOT NULL,
                            track_count INTEGER DEFAULT 0,
                            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                        );
CREATE TABLE "discovery_recent_albums" (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            album_spotify_id TEXT,
                            album_itunes_id TEXT,
                            album_deezer_id TEXT,
                            artist_spotify_id TEXT,
                            artist_itunes_id TEXT,
                            artist_deezer_id TEXT,
                            source TEXT NOT NULL DEFAULT 'spotify',
                            album_name TEXT NOT NULL,
                            artist_name TEXT NOT NULL,
                            album_cover_url TEXT,
                            release_date TEXT NOT NULL,
                            album_type TEXT DEFAULT 'album',
                            cached_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            profile_id INTEGER DEFAULT 1,
                            UNIQUE(profile_id, album_spotify_id, album_itunes_id, album_deezer_id, source)
                        );
CREATE TABLE download_blacklist (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    track_title TEXT,
                    track_artist TEXT,
                    blocked_filename TEXT,
                    blocked_username TEXT,
                    reason TEXT DEFAULT 'user_rejected',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(blocked_username, blocked_filename)
                );
CREATE TABLE download_decisions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    track_download_id INTEGER,
                    task_key TEXT NOT NULL,
                    track_title TEXT,
                    track_artist TEXT,
                    quality_profile_id INTEGER,
                    outcome TEXT NOT NULL,
                    chosen_json TEXT,
                    alternatives_json TEXT,
                    search_mode TEXT,
                    searched_at TEXT,
                    policy_run_id TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
CREATE TABLE downloaded_podcast_episodes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    feed_url TEXT NOT NULL,
                    guid TEXT,
                    enclosure_url TEXT NOT NULL,
                    title TEXT,
                    pub_date TIMESTAMP,
                    file_path TEXT,
                    downloaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    pruned_at TIMESTAMP,
                    UNIQUE(feed_url, enclosure_url)
                );
CREATE TABLE failed_download_blocklist (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    fingerprint TEXT NOT NULL UNIQUE,
                    service TEXT NOT NULL DEFAULT '',
                    artist TEXT NOT NULL DEFAULT '',
                    title TEXT NOT NULL DEFAULT '',
                    size_bytes INTEGER NOT NULL DEFAULT 0,
                    reason TEXT NOT NULL DEFAULT '',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    expires_at TIMESTAMP NOT NULL
                );
CREATE TABLE genre_translation_cache (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    whitelist_hash TEXT NOT NULL,
                    source_genre TEXT NOT NULL,
                    normalized_source_genre TEXT NOT NULL,
                    status TEXT NOT NULL,
                    matched_genre TEXT,
                    score REAL,
                    margin REAL,
                    candidates_json TEXT NOT NULL DEFAULT '[]',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    access_count INTEGER DEFAULT 1,
                    UNIQUE(whitelist_hash, normalized_source_genre)
                );
CREATE TABLE hifi_instances (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    url TEXT NOT NULL UNIQUE,
                    priority INTEGER NOT NULL DEFAULT 0,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
CREATE TABLE library_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    artist_name TEXT,
                    album_name TEXT,
                    quality TEXT,
                    server_source TEXT,
                    file_path TEXT,
                    thumb_url TEXT,
                    download_source TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                , source_track_id TEXT, source_track_title TEXT, source_filename TEXT, acoustid_result TEXT, source_artist TEXT, verification_status TEXT, origin TEXT, origin_context TEXT);
CREATE TABLE library_issues (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile_id INTEGER NOT NULL DEFAULT 1,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    category TEXT NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT,
                    snapshot_data TEXT DEFAULT '{}',
                    status TEXT NOT NULL DEFAULT 'open',
                    priority TEXT NOT NULL DEFAULT 'normal',
                    admin_response TEXT,
                    resolved_by INTEGER,
                    resolved_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (profile_id) REFERENCES profiles (id) ON DELETE CASCADE
                );
CREATE TABLE liked_albums_pool (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    album_name TEXT NOT NULL,
                    artist_name TEXT NOT NULL,
                    normalized_key TEXT NOT NULL,
                    spotify_album_id TEXT,
                    tidal_album_id TEXT,
                    deezer_album_id TEXT,
                    discogs_release_id TEXT,
                    image_url TEXT,
                    release_date TEXT,
                    total_tracks INTEGER DEFAULT 0,
                    source_services TEXT DEFAULT '[]',
                    profile_id INTEGER DEFAULT 1,
                    last_fetched_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(profile_id, normalized_key)
                );
CREATE TABLE liked_artists_pool (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    artist_name TEXT NOT NULL,
                    normalized_name TEXT NOT NULL,
                    spotify_artist_id TEXT,
                    itunes_artist_id TEXT,
                    deezer_artist_id TEXT,
                    discogs_artist_id TEXT,
                    musicbrainz_artist_id TEXT,
                    image_url TEXT,
                    genres TEXT,
                    source_services TEXT DEFAULT '[]',
                    active_source_id TEXT,
                    active_source TEXT,
                    match_status TEXT DEFAULT 'pending',
                    on_watchlist INTEGER DEFAULT 0,
                    profile_id INTEGER DEFAULT 1,
                    last_fetched_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(profile_id, normalized_name)
                );
CREATE TABLE "listenbrainz_playlists" (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        playlist_mbid TEXT NOT NULL,
                        title TEXT NOT NULL,
                        creator TEXT,
                        playlist_type TEXT NOT NULL,
                        track_count INTEGER DEFAULT 0,
                        annotation_data TEXT,
                        profile_id INTEGER DEFAULT 1,
                        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        cached_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE(playlist_mbid, profile_id)
                    );
INSERT INTO "listenbrainz_playlists" VALUES(501,'c0ffee00-0000-4000-8000-000000000501','Weekly Jams for fixture','troi-bot','weekly-jams',1,NULL,1,'2026-10-20 21:38:54','2026-10-20 21:38:54');
CREATE TABLE listenbrainz_tracks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    playlist_id INTEGER NOT NULL,
                    position INTEGER NOT NULL,
                    track_name TEXT NOT NULL,
                    artist_name TEXT NOT NULL,
                    album_name TEXT NOT NULL,
                    duration_ms INTEGER DEFAULT 0,
                    recording_mbid TEXT,
                    release_mbid TEXT,
                    album_cover_url TEXT,
                    additional_metadata TEXT,
                    FOREIGN KEY (playlist_id) REFERENCES listenbrainz_playlists (id) ON DELETE CASCADE,
                    UNIQUE(playlist_id, position)
                );
INSERT INTO "listenbrainz_tracks" VALUES(511,501,0,'Opening Song','Fixture Artist','Fixture Album (Deluxe Edition)',215000,'c0ffee00-0000-4000-8000-000000000511',NULL,NULL,NULL);
CREATE TABLE listening_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    track_id TEXT,
                    title TEXT NOT NULL,
                    artist TEXT,
                    album TEXT,
                    played_at TIMESTAMP NOT NULL,
                    duration_ms INTEGER DEFAULT 0,
                    server_source TEXT,
                    db_track_id INTEGER,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                , profile_id INTEGER NOT NULL DEFAULT 1, scrobbled_lastfm INTEGER DEFAULT 0, scrobbled_listenbrainz INTEGER DEFAULT 0);
CREATE TABLE listening_import_events (
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        listened_at INTEGER NOT NULL,
        history_id INTEGER NOT NULL REFERENCES listening_history(id) ON DELETE CASCADE,
        profile_id INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (profile_id, source, title, artist, listened_at),
        UNIQUE (history_id, source)
    );
CREATE TABLE manual_library_track_matches (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        profile_id INTEGER DEFAULT 1,
                        source TEXT NOT NULL,
                        source_track_id TEXT NOT NULL,
                        source_title TEXT,
                        source_artist TEXT,
                        source_album TEXT,
                        source_context_json TEXT,
                        server_source TEXT DEFAULT '',
                        library_track_id INTEGER NOT NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, library_file_path TEXT,
                        UNIQUE(profile_id, source, source_track_id, server_source)
                    );
CREATE TABLE manual_metadata_files (
                    path_key TEXT PRIMARY KEY,
                    file_path TEXT,
                    album_title TEXT,
                    album_artist TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
CREATE TABLE mb_album_release_cache (
                    normalized_album_key TEXT NOT NULL,
                    artist_key TEXT NOT NULL,
                    release_mbid TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (normalized_album_key, artist_key)
                );
CREATE TABLE mb_recording_cache (
                    track_key TEXT PRIMARY KEY,
                    recording_mbid TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
CREATE TABLE metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
INSERT INTO "metadata" VALUES('id_columns_migrated','true','2026-10-20 21:38:52');
INSERT INTO "metadata" VALUES('discovery_blacklist_migrated_v1','1','2026-10-20 21:38:52');
INSERT INTO "metadata" VALUES('profiles_migration_v1','true','2026-10-20 21:38:53');
INSERT INTO "metadata" VALUES('profiles_migration_v2','true','2026-10-20 21:38:53');
INSERT INTO "metadata" VALUES('profiles_migration_v3','true','2026-10-20 21:38:53');
INSERT INTO "metadata" VALUES('profiles_migration_v4','1','2026-10-20 21:38:53');
INSERT INTO "metadata" VALUES('profiles_migration_settings','1','2026-10-20 21:38:53');
INSERT INTO "metadata" VALUES('profiles_migration_sides','1','2026-10-20 21:38:53');
INSERT INTO "metadata" VALUES('profiles_listenbrainz_v1','1','2026-10-20 21:38:53');
INSERT INTO "metadata" VALUES('profiles_password_v1','1','2026-10-20 21:38:53');
INSERT INTO "metadata" VALUES('profiles_recovery_v1','1','2026-10-20 21:38:53');
INSERT INTO "metadata" VALUES('profiles_services_v1','1','2026-10-20 21:38:53');
INSERT INTO "metadata" VALUES('service_credentials_v1','1','2026-10-20 21:38:53');
INSERT INTO "metadata" VALUES('soulid_v2_migration','1','2026-10-20 21:38:53');
INSERT INTO "metadata" VALUES('spotify_library_cache_v1','1','2026-10-20 21:38:53');
INSERT INTO "metadata" VALUES('metadata_cache_v1','1','2026-10-20 21:38:53');
INSERT INTO "metadata" VALUES('repair_worker_v2','1','2026-10-20 21:38:53');
INSERT INTO "metadata" VALUES('quality_profiles_migrated_v1','true','2026-10-20 21:38:53');
INSERT INTO "metadata" VALUES('genres_json_normalized','true','2026-10-20 21:38:53');
INSERT INTO "metadata" VALUES('last_full_refresh','2026-01-01T12:00:00','2026-10-20 21:38:54');
CREATE TABLE metadata_cache_entities (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source TEXT NOT NULL,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    image_url TEXT,
                    external_urls TEXT,
                    genres TEXT,
                    popularity INTEGER,
                    followers INTEGER,
                    artist_name TEXT,
                    artist_id TEXT,
                    release_date TEXT,
                    total_tracks INTEGER,
                    album_type TEXT,
                    label TEXT,
                    album_name TEXT,
                    album_id TEXT,
                    duration_ms INTEGER,
                    track_number INTEGER,
                    disc_number INTEGER,
                    explicit INTEGER,
                    isrc TEXT,
                    preview_url TEXT,
                    raw_json TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    access_count INTEGER DEFAULT 1,
                    ttl_days INTEGER DEFAULT 30,
                    UNIQUE(source, entity_type, entity_id)
                );
CREATE TABLE metadata_cache_searches (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source TEXT NOT NULL,
                    search_type TEXT NOT NULL,
                    query_normalized TEXT NOT NULL,
                    query_original TEXT NOT NULL,
                    result_ids TEXT NOT NULL,
                    result_count INTEGER NOT NULL,
                    search_limit INTEGER,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    access_count INTEGER DEFAULT 1,
                    ttl_days INTEGER DEFAULT 7,
                    UNIQUE(source, search_type, query_normalized, search_limit)
                );
CREATE TABLE mirrored_playlist_tracks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    playlist_id INTEGER NOT NULL,
                    position INTEGER NOT NULL,
                    track_name TEXT NOT NULL,
                    artist_name TEXT NOT NULL,
                    album_name TEXT DEFAULT '',
                    duration_ms INTEGER DEFAULT 0,
                    image_url TEXT,
                    source_track_id TEXT,
                    extra_data TEXT,
                    FOREIGN KEY (playlist_id) REFERENCES mirrored_playlists(id) ON DELETE CASCADE,
                    UNIQUE(playlist_id, position)
                );
INSERT INTO "mirrored_playlist_tracks" VALUES(611,601,0,'Opening Song','Fixture Artist','Fixture Album (Deluxe Edition)',215000,NULL,'3n3Ppam7vgaVa1iaRUc9Lp',NULL);
INSERT INTO "mirrored_playlist_tracks" VALUES(612,601,1,'Imported From A File','Fixture Artist','Fixture Album (Deluxe Edition)',201000,NULL,NULL,NULL);
CREATE TABLE mirrored_playlists (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source TEXT NOT NULL,
                    source_playlist_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT,
                    owner TEXT,
                    image_url TEXT,
                    track_count INTEGER DEFAULT 0,
                    profile_id INTEGER DEFAULT 1,
                    quality_profile_id INTEGER DEFAULT NULL,
                    mirrored_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, explored_at TIMESTAMP DEFAULT NULL, cover_tiles TEXT DEFAULT NULL, server_playlist_id TEXT DEFAULT NULL, server_type TEXT DEFAULT NULL, server_linked_at TIMESTAMP DEFAULT NULL, organize_by_playlist INTEGER NOT NULL DEFAULT 0, custom_name TEXT DEFAULT NULL,
                    UNIQUE(source, source_playlist_id, profile_id)
                );
INSERT INTO "mirrored_playlists" VALUES(601,'spotify','37i9dQZF1DXcBWIGoYBM5M','Fixture Mix','Mirrored by the fixture generator','fixture','https://i.scdn.co/image/fixture-mix',2,1,NULL,'2026-10-20 21:38:54','2026-10-20 21:38:54',NULL,NULL,NULL,NULL,NULL,0,NULL);
CREATE TABLE mix_recipes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile_id INTEGER NOT NULL DEFAULT 1,
                    recipe_json TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
CREATE TABLE musicbrainz_cache (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    entity_type TEXT NOT NULL,
                    entity_name TEXT NOT NULL,
                    artist_name TEXT,
                    musicbrainz_id TEXT,
                    spotify_id TEXT,
                    itunes_id TEXT,
                    metadata_json TEXT,
                    match_confidence INTEGER,
                    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(entity_type, entity_name, artist_name)
                );
CREATE TABLE notification_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile_id INTEGER NOT NULL DEFAULT 1,
                    type TEXT NOT NULL DEFAULT 'info',
                    message TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
CREATE TABLE personalized_playlist_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    spotify_track_id TEXT,
    itunes_track_id TEXT,
    deezer_track_id TEXT,
    track_name TEXT,
    artist_name TEXT,
    album_name TEXT,
    album_cover_url TEXT,
    duration_ms INTEGER,
    popularity INTEGER,
    track_data_json TEXT,
    FOREIGN KEY (playlist_id) REFERENCES personalized_playlists(id) ON DELETE CASCADE,
    UNIQUE (playlist_id, position)
);
CREATE TABLE personalized_playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL DEFAULT 1,
    kind TEXT NOT NULL,
    variant TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    track_count INTEGER NOT NULL DEFAULT 0,
    last_generated_at TIMESTAMP,
    last_synced_at TIMESTAMP,
    last_generation_source TEXT,
    last_generation_error TEXT,
    is_stale INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (profile_id, kind, variant)
);
CREATE TABLE personalized_track_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL DEFAULT 1,
    kind TEXT NOT NULL,
    track_id TEXT NOT NULL,
    served_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE playlist_export_targets (
                    mirrored_playlist_id INTEGER NOT NULL,
                    target TEXT NOT NULL,
                    target_playlist_mbid TEXT NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (mirrored_playlist_id, target)
                );
CREATE TABLE playlist_pipeline_run_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    playlist_id INTEGER,
                    playlist_name TEXT,
                    source TEXT,
                    profile_id INTEGER DEFAULT 1,
                    trigger_source TEXT DEFAULT 'pipeline',
                    started_at TIMESTAMP,
                    finished_at TIMESTAMP,
                    duration_seconds REAL,
                    status TEXT NOT NULL,
                    summary TEXT,
                    before_json TEXT,
                    after_json TEXT,
                    result_json TEXT,
                    log_lines TEXT,
                    FOREIGN KEY (playlist_id) REFERENCES mirrored_playlists(id) ON DELETE SET NULL
                );
CREATE TABLE profile_audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    actor_id INTEGER,
                    actor_name TEXT,
                    action TEXT NOT NULL,
                    target_id INTEGER,
                    target_name TEXT,
                    detail TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
CREATE TABLE profile_devices (
                    id TEXT PRIMARY KEY,
                    owner_id INTEGER NOT NULL,
                    label TEXT,
                    ip TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    revoked_at TIMESTAMP
                );
CREATE TABLE profile_invites (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    token_hash TEXT NOT NULL UNIQUE,
                    created_by INTEGER,
                    preset TEXT NOT NULL DEFAULT '{}',
                    note TEXT,
                    expires_at TIMESTAMP NOT NULL,
                    used_at TIMESTAMP,
                    used_by INTEGER,
                    revoked_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
CREATE TABLE profile_service_credentials (
                    profile_id INTEGER NOT NULL,
                    service TEXT NOT NULL,
                    credential_id INTEGER,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (profile_id, service)
                );
CREATE TABLE profiles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    avatar_color TEXT DEFAULT '#6366f1',
                    pin_hash TEXT,
                    is_admin INTEGER NOT NULL DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                , avatar_url TEXT DEFAULT NULL, home_page TEXT DEFAULT NULL, allowed_pages TEXT DEFAULT NULL, can_download INTEGER DEFAULT 1, allowed_sides TEXT DEFAULT NULL, listenbrainz_token TEXT DEFAULT NULL, listenbrainz_base_url TEXT DEFAULT NULL, listenbrainz_username TEXT DEFAULT NULL, password_hash TEXT DEFAULT NULL, recovery_question TEXT DEFAULT NULL, recovery_answer_hash TEXT DEFAULT NULL, spotify_client_id TEXT DEFAULT NULL, spotify_client_secret TEXT DEFAULT NULL, spotify_redirect_uri TEXT DEFAULT NULL, spotify_access_token TEXT DEFAULT NULL, spotify_refresh_token TEXT DEFAULT NULL, tidal_access_token TEXT DEFAULT NULL, tidal_refresh_token TEXT DEFAULT NULL, plex_library_id TEXT DEFAULT NULL, jellyfin_user_id TEXT DEFAULT NULL, jellyfin_library_id TEXT DEFAULT NULL, navidrome_library_id TEXT DEFAULT NULL, navidrome_username TEXT DEFAULT NULL, navidrome_password TEXT DEFAULT NULL, lastfm_username TEXT DEFAULT NULL, plex_home_user_id TEXT DEFAULT NULL, plex_home_user_title TEXT DEFAULT NULL, plex_home_user_token TEXT DEFAULT NULL, request_limit INTEGER DEFAULT 0, request_limit_days INTEGER DEFAULT 7, hide_explicit INTEGER DEFAULT 0, max_rating TEXT DEFAULT NULL, session_epoch INTEGER DEFAULT 0, disabled INTEGER DEFAULT 0, library_mode TEXT DEFAULT 'shared', library_root TEXT DEFAULT NULL);
INSERT INTO "profiles" VALUES(1,'Admin','#6366f1',NULL,1,'2026-10-20 21:38:53','2026-10-20 21:38:53',NULL,NULL,NULL,1,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,7,0,NULL,0,0,'shared',NULL);
INSERT INTO "profiles" VALUES(2,'Fixture Listener','#22c55e',NULL,0,'2026-10-20 21:38:54','2026-10-20 21:38:54',NULL,NULL,NULL,1,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,7,0,NULL,0,0,'shared',NULL);
CREATE TABLE quality_profiles (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    ranked_targets TEXT NOT NULL DEFAULT '[]',
    fallback_enabled INTEGER NOT NULL DEFAULT 1,
    search_mode TEXT NOT NULL DEFAULT 'priority',
    rank_candidates_by_quality INTEGER NOT NULL DEFAULT 0,
    upgrade_policy TEXT NOT NULL DEFAULT 'acceptable', -- 'acceptable'|'until_cutoff'|'until_top'
    upgrade_cutoff_index INTEGER NOT NULL DEFAULT 0,
    acoustid_required INTEGER NOT NULL DEFAULT 0,
    downsample_enabled INTEGER NOT NULL DEFAULT 0,
    deep_audio_verify INTEGER NOT NULL DEFAULT 0,
    replace_lower_quality INTEGER NOT NULL DEFAULT 0,
    lossy_copy_enabled INTEGER NOT NULL DEFAULT 0,
    lossy_copy_codec TEXT NOT NULL DEFAULT 'mp3',
    lossy_copy_bitrate TEXT NOT NULL DEFAULT '320',
    lossy_copy_delete_original INTEGER NOT NULL DEFAULT 0,
    repair_job_id TEXT NOT NULL DEFAULT 'quality_upgrade',
    repair_settings TEXT NOT NULL DEFAULT '{}',
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "quality_profiles" VALUES(1,'Default','Migrated from your previous global Quality settings','[{"label": "FLAC 24-bit/192kHz", "format": "flac", "bit_depth": 24, "min_sample_rate": 192000}, {"label": "FLAC 24-bit/96kHz", "format": "flac", "bit_depth": 24, "min_sample_rate": 96000}, {"label": "FLAC 24-bit/48kHz", "format": "flac", "bit_depth": 24, "min_sample_rate": 48000}, {"label": "FLAC 24-bit/44.1kHz", "format": "flac", "bit_depth": 24, "min_sample_rate": 44100}, {"label": "FLAC 16-bit", "format": "flac", "bit_depth": 16}, {"label": "MP3 320kbps", "format": "mp3", "min_bitrate": 320}, {"label": "MP3 256kbps", "format": "mp3", "min_bitrate": 256}, {"label": "MP3 192kbps", "format": "mp3", "min_bitrate": 192}]',1,'priority',0,'acceptable',0,0,0,0,0,0,'mp3','320',0,'quality_upgrade','{}',1,'2026-10-20 21:38:53','2026-10-20 21:38:53');
INSERT INTO "quality_profiles" VALUES(2,'Upgrade until top quality','Keep proposing upgrades until the first ranked target is reached.','[
  {"label":"FLAC 24-bit/192kHz","format":"flac","bit_depth":24,"min_sample_rate":192000},
  {"label":"FLAC 24-bit/96kHz","format":"flac","bit_depth":24,"min_sample_rate":96000},
  {"label":"FLAC 24-bit/48kHz","format":"flac","bit_depth":24,"min_sample_rate":48000},
  {"label":"FLAC 24-bit/44.1kHz","format":"flac","bit_depth":24,"min_sample_rate":44100},
  {"label":"FLAC 16-bit","format":"flac","bit_depth":16}
]',1,'best_quality',1,'until_cutoff',0,0,0,0,0,0,'mp3','320',0,'quality_upgrade','{"require_top_target": true}',0,'2026-10-20 21:38:53','2026-10-20 21:38:53');
CREATE TABLE quarantine_source_blocks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    trigger TEXT DEFAULT 'unknown',
                    expected_artist TEXT DEFAULT '',
                    expected_track TEXT DEFAULT '',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(username, filename)
                );
CREATE TABLE "recent_releases" (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            watchlist_artist_id INTEGER NOT NULL,
                            album_spotify_id TEXT,
                            album_itunes_id TEXT,
                            album_deezer_id TEXT,
                            source TEXT NOT NULL DEFAULT 'spotify',
                            album_name TEXT NOT NULL,
                            release_date TEXT NOT NULL,
                            album_cover_url TEXT,
                            track_count INTEGER DEFAULT 0,
                            added_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            profile_id INTEGER DEFAULT 1,
                            UNIQUE(profile_id, watchlist_artist_id, album_spotify_id, album_itunes_id)
                        );
INSERT INTO "recent_releases" VALUES(471,401,'1fixtureNewAlbum00000',NULL,NULL,'spotify','Fixture Comeback','2026-01-10','https://i.scdn.co/image/fixture-comeback',10,'2026-10-20 21:38:54',1);
CREATE TABLE rematch_hints (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    staged_path TEXT NOT NULL,
                    content_hash TEXT,
                    source TEXT NOT NULL,
                    isrc TEXT,
                    track_id TEXT,
                    album_id TEXT,
                    artist_id TEXT,
                    track_title TEXT,
                    album_name TEXT,
                    artist_name TEXT,
                    album_type TEXT,
                    track_number INTEGER,
                    disc_number INTEGER,
                    replace_track_id INTEGER,
                    exempt_dedup INTEGER NOT NULL DEFAULT 1,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    consumed_at TIMESTAMP
                );
CREATE TABLE reorganize_queue (
                    queue_id TEXT PRIMARY KEY,
                    album_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    enqueued_at REAL NOT NULL,
                    payload TEXT NOT NULL          -- json snapshot of the QueueItem
                );
CREATE TABLE repair_findings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL,
                    finding_type TEXT NOT NULL,
                    severity TEXT NOT NULL DEFAULT 'info',
                    status TEXT NOT NULL DEFAULT 'pending',
                    entity_type TEXT,
                    entity_id TEXT,
                    file_path TEXT,
                    title TEXT NOT NULL,
                    description TEXT,
                    details_json TEXT DEFAULT '{}',
                    user_action TEXT,
                    resolved_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                , last_error TEXT);
CREATE TABLE repair_job_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL,
                    started_at TIMESTAMP NOT NULL,
                    finished_at TIMESTAMP,
                    duration_seconds REAL,
                    items_scanned INTEGER DEFAULT 0,
                    findings_created INTEGER DEFAULT 0,
                    auto_fixed INTEGER DEFAULT 0,
                    errors INTEGER DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'running'
                , error_text TEXT);
CREATE TABLE retag_groups (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    group_type TEXT NOT NULL DEFAULT 'album',
                    artist_name TEXT NOT NULL,
                    album_name TEXT NOT NULL,
                    image_url TEXT,
                    spotify_album_id TEXT,
                    itunes_album_id TEXT,
                    total_tracks INTEGER DEFAULT 1,
                    release_date TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
CREATE TABLE retag_tracks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    group_id INTEGER NOT NULL,
                    track_number INTEGER,
                    disc_number INTEGER DEFAULT 1,
                    title TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    file_format TEXT,
                    spotify_track_id TEXT,
                    itunes_track_id TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (group_id) REFERENCES retag_groups (id) ON DELETE CASCADE
                );
CREATE TABLE sample_analysis (
                    track_id INTEGER PRIMARY KEY,
                    bpm REAL,
                    onsets_json TEXT,  -- JSON array of onset times in seconds
                    duration_s REAL,
                    analyzed_at REAL,
                    analyzer_version INTEGER DEFAULT 1
                , key_name TEXT, key_confidence REAL, source_sig TEXT);
CREATE TABLE sample_stash (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    tags_json TEXT,  -- JSON array of tag strings
                    track_id INTEGER NOT NULL,
                    start_s REAL NOT NULL,
                    end_s REAL NOT NULL,
                    pitch_st REAL DEFAULT 0,
                    target_bpm REAL,
                    format TEXT DEFAULT 'wav16',
                    file_path TEXT NOT NULL,
                    created_at REAL
                , stem TEXT, folder TEXT, normalize TEXT, fade_ms REAL, reverse INTEGER, space REAL, delay_json TEXT);
CREATE TABLE sample_stems (
                    track_id INTEGER NOT NULL,
                    stem TEXT NOT NULL,  -- drums | vocals | bass | other
                    file_path TEXT NOT NULL,
                    status TEXT DEFAULT 'done',
                    backend TEXT,  -- demucs-htdemucs | stub
                    separator_version INTEGER DEFAULT 1,
                    created_at REAL, source_sig TEXT,
                    PRIMARY KEY (track_id, stem)
                );
CREATE TABLE schema_migrations (
                    name TEXT PRIMARY KEY,
                    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
INSERT INTO "schema_migrations" VALUES('quality_profiles_schema','2026-10-20 21:38:53');
INSERT INTO "schema_migrations" VALUES('genres_json','2026-10-20 21:38:53');
INSERT INTO "schema_migrations" VALUES('id_columns_to_text','2026-10-20 21:38:53');
INSERT INTO "schema_migrations" VALUES('metadata_cache_v1','2026-10-20 21:38:53');
INSERT INTO "schema_migrations" VALUES('repair_worker_v2','2026-10-20 21:38:53');
INSERT INTO "schema_migrations" VALUES('spotify_library_cache_v1','2026-10-20 21:38:53');
INSERT INTO "schema_migrations" VALUES('profiles_v1','2026-10-20 21:38:53');
INSERT INTO "schema_migrations" VALUES('profiles_v2','2026-10-20 21:38:53');
INSERT INTO "schema_migrations" VALUES('profiles_v3','2026-10-20 21:38:53');
INSERT INTO "schema_migrations" VALUES('profiles_v4','2026-10-20 21:38:53');
INSERT INTO "schema_migrations" VALUES('discovery_cache_v2','2026-10-20 21:38:53');
INSERT INTO "schema_migrations" VALUES('deezer_cache_v2','2026-10-20 21:38:53');
INSERT INTO "schema_migrations" VALUES('cache_junk_artist_purged','2026-10-20 21:38:53');
INSERT INTO "schema_migrations" VALUES('genius_search_fix','2026-10-20 21:38:53');
INSERT INTO "schema_migrations" VALUES('tidal_search_fix','2026-10-20 21:38:53');
INSERT INTO "schema_migrations" VALUES('sample_analysis_v1','2026-10-20 21:38:53');
INSERT INTO "schema_migrations" VALUES('sample_stash_v1','2026-10-20 21:38:53');
INSERT INTO "schema_migrations" VALUES('sample_stems_v1','2026-10-20 21:38:53');
CREATE TABLE service_credentials (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    service TEXT NOT NULL,
                    label TEXT NOT NULL,
                    payload TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(service, label)
                );
CREATE TABLE "similar_artists" (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            source_artist_id TEXT NOT NULL,
                            similar_artist_spotify_id TEXT,
                            similar_artist_itunes_id TEXT,
                            similar_artist_deezer_id TEXT,
                            similar_artist_musicbrainz_id TEXT,
                            similar_artist_name TEXT NOT NULL,
                            similarity_rank INTEGER DEFAULT 1,
                            occurrence_count INTEGER DEFAULT 1,
                            last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            image_url TEXT,
                            genres TEXT,
                            popularity INTEGER DEFAULT 0,
                            metadata_updated_at TIMESTAMP,
                            last_featured TIMESTAMP,
                            profile_id INTEGER DEFAULT 1,
                            source_provider TEXT,
                            UNIQUE(profile_id, source_artist_id, similar_artist_name)
                        );
INSERT INTO "similar_artists" VALUES(451,'0OdUWJ0sBjDrqHygGUXeCF','4Z8W4fKeB5YxbusRsdQVPb',NULL,NULL,NULL,'Similar Fixture Band',1,3,'2026-10-20 21:38:54',NULL,NULL,0,NULL,NULL,1,NULL);
CREATE TABLE spotify_library_cache (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    spotify_album_id TEXT NOT NULL,
                    album_name TEXT NOT NULL,
                    artist_name TEXT NOT NULL,
                    artist_id TEXT,
                    release_date TEXT,
                    total_tracks INTEGER DEFAULT 0,
                    album_type TEXT DEFAULT 'album',
                    image_url TEXT,
                    date_saved TEXT,
                    cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    profile_id INTEGER DEFAULT 1,
                    UNIQUE(spotify_album_id, profile_id)
                );
CREATE TABLE sync_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    batch_id TEXT NOT NULL,
                    playlist_id TEXT,
                    playlist_name TEXT NOT NULL,
                    source TEXT NOT NULL,
                    sync_type TEXT NOT NULL,
                    artist_context TEXT,
                    album_context TEXT,
                    tracks_json TEXT NOT NULL,
                    total_tracks INTEGER DEFAULT 0,
                    tracks_found INTEGER DEFAULT 0,
                    tracks_downloaded INTEGER DEFAULT 0,
                    tracks_failed INTEGER DEFAULT 0,
                    thumb_url TEXT,
                    is_album_download INTEGER DEFAULT 0,
                    playlist_folder_mode INTEGER DEFAULT 0,
                    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    completed_at TIMESTAMP,
                    track_results TEXT,
                    profile_id INTEGER,
                    quality_profile_id INTEGER
                , source_page TEXT);
INSERT INTO "sync_history" VALUES(701,'fixture-batch-1','37i9dQZF1DXcBWIGoYBM5M','Fixture Mix','spotify','playlist',NULL,NULL,'[{"id": "3n3Ppam7vgaVa1iaRUc9Lp", "name": "Opening Song"}]',2,1,1,0,NULL,0,0,'2026-01-04 18:00:00','2026-01-04 18:05:00',NULL,NULL,NULL,NULL);
CREATE TABLE sync_match_cache (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    spotify_track_id TEXT NOT NULL,
                    normalized_title TEXT NOT NULL,
                    normalized_artist TEXT NOT NULL,
                    server_source TEXT NOT NULL,
                    server_track_id INTEGER NOT NULL,
                    server_track_title TEXT,
                    confidence REAL NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    use_count INTEGER DEFAULT 1,
                    UNIQUE(spotify_track_id, server_source)
                );
CREATE TABLE torrent_seed_grabs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    torrent_hash TEXT NOT NULL UNIQUE,
                    title TEXT,
                    category TEXT,
                    completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    seed_released INTEGER DEFAULT 0
                );
CREATE TABLE track_artist_credits (
            track_id TEXT NOT NULL,
            source TEXT NOT NULL,
            position INTEGER NOT NULL,
            name TEXT NOT NULL,
            source_artist_id TEXT,
            PRIMARY KEY (track_id, source, position)
        ) WITHOUT ROWID
    ;
CREATE TABLE track_artist_credits_pending (
            track_id TEXT NOT NULL,
            source TEXT NOT NULL,
            PRIMARY KEY (source, track_id)
        ) WITHOUT ROWID
    ;
CREATE TABLE track_credits (
                    track_id TEXT NOT NULL,
                    name_norm TEXT NOT NULL,
                    PRIMARY KEY (track_id, name_norm)
                ) WITHOUT ROWID
            ;
CREATE TABLE track_downloads (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    track_id TEXT,
                    file_path TEXT,
                    source_service TEXT NOT NULL,
                    source_username TEXT,
                    source_filename TEXT,
                    source_size INTEGER,
                    audio_quality TEXT,
                    track_title TEXT,
                    track_artist TEXT,
                    track_album TEXT,
                    acquired_quality_json TEXT,
                    retention_json TEXT,
                    status TEXT DEFAULT 'completed',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                , bit_depth INTEGER, sample_rate INTEGER, bitrate INTEGER, spotify_track_id TEXT, itunes_track_id TEXT, deezer_track_id TEXT, tidal_track_id TEXT, qobuz_track_id TEXT, musicbrainz_recording_id TEXT, audiodb_id TEXT, soul_id TEXT, isrc TEXT);
CREATE TABLE "tracks" (
                    id TEXT PRIMARY KEY,
                    album_id TEXT NOT NULL,
                    artist_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    track_number INTEGER,
                    duration INTEGER,
                    file_path TEXT,
                    bitrate INTEGER,
                    server_source TEXT DEFAULT 'plex',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, musicbrainz_recording_id TEXT, musicbrainz_last_attempted TIMESTAMP, musicbrainz_match_status TEXT, verification_status TEXT, spotify_track_id TEXT, itunes_track_id TEXT, audiodb_id TEXT, audiodb_match_status TEXT, audiodb_last_attempted TIMESTAMP, style TEXT, mood TEXT, deezer_id TEXT, deezer_match_status TEXT, deezer_last_attempted TIMESTAMP, bpm REAL, explicit INTEGER, repair_status TEXT, repair_last_checked TIMESTAMP, jiosaavn_id TEXT, jiosaavn_match_status TEXT, jiosaavn_last_attempted TIMESTAMP, spotify_match_status TEXT, spotify_last_attempted TIMESTAMP, itunes_match_status TEXT, itunes_last_attempted TIMESTAMP, lastfm_match_status TEXT, lastfm_last_attempted TIMESTAMP, lastfm_listeners INTEGER, lastfm_playcount INTEGER, lastfm_tags TEXT, lastfm_url TEXT, genius_id TEXT, genius_match_status TEXT, genius_last_attempted TIMESTAMP, genius_lyrics TEXT, genius_description TEXT, genius_url TEXT, tidal_id TEXT, tidal_match_status TEXT, tidal_last_attempted TIMESTAMP, qobuz_id TEXT, qobuz_match_status TEXT, qobuz_last_attempted TIMESTAMP, isrc TEXT, copyright TEXT, amazon_id TEXT, amazon_match_status TEXT, amazon_last_attempted TIMESTAMP, bandcamp_id TEXT, bandcamp_match_status TEXT, bandcamp_last_attempted TIMESTAMP, bandcamp_url TEXT, bandcamp_tags TEXT, bandcamp_label TEXT, owner_profile_id INTEGER DEFAULT NULL, soul_id TEXT DEFAULT NULL, album_soul_id TEXT DEFAULT NULL, play_count INTEGER DEFAULT 0, last_played TIMESTAMP, title_norm TEXT, track_artist_norm TEXT, track_artist TEXT, file_size INTEGER, quality_profile_id INTEGER DEFAULT NULL, acquired_quality_json TEXT DEFAULT NULL, retention_json TEXT DEFAULT NULL, year INTEGER, disc_number INTEGER DEFAULT 1, metadata_locked INTEGER DEFAULT 0,
                    FOREIGN KEY (album_id) REFERENCES "albums" (id) ON DELETE CASCADE,
                    FOREIGN KEY (artist_id) REFERENCES "artists" (id) ON DELETE CASCADE
                );
INSERT INTO "tracks" VALUES('9201','9101','9001','Opening Song',1,215000,'/music/Fixture Artist/Fixture Album (Deluxe Edition) (2019)/01 - Opening Song.flac',1411,'plex','2026-10-20 21:38:54','2026-10-20 21:38:54',NULL,NULL,NULL,NULL,'3n3Ppam7vgaVa1iaRUc9Lp',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1,0);
INSERT INTO "tracks" VALUES('9202','9101','9001','Café Été',2,216000,'/music/Fixture Artist/Fixture Album (Deluxe Edition) (2019)/02 - Café Été.mp3',320,'plex','2026-10-20 21:38:54','2026-10-20 21:38:54',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1,0);
CREATE TABLE "watchlist_artists" (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            spotify_artist_id TEXT,
                            artist_name TEXT NOT NULL,
                            date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            last_scan_timestamp TIMESTAMP,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            image_url TEXT,
                            include_albums INTEGER DEFAULT 1,
                            include_eps INTEGER DEFAULT 1,
                            include_singles INTEGER DEFAULT 1,
                            include_live INTEGER DEFAULT 0,
                            include_remixes INTEGER DEFAULT 0,
                            include_acoustic INTEGER DEFAULT 0,
                            include_compilations INTEGER DEFAULT 0,
                            include_instrumentals INTEGER DEFAULT 0,
                            lookback_days INTEGER DEFAULT NULL,
                            itunes_artist_id TEXT,
                            deezer_artist_id TEXT,
                            discogs_artist_id TEXT,
                            musicbrainz_artist_id TEXT,
                            amazon_artist_id TEXT,
                            preferred_metadata_source TEXT DEFAULT NULL,
                            auto_download INTEGER NOT NULL DEFAULT 1,
                            profile_id INTEGER DEFAULT 1, auto_download_pref INTEGER, quality_profile_id INTEGER DEFAULT NULL,
                            UNIQUE(profile_id, spotify_artist_id),
                            UNIQUE(profile_id, itunes_artist_id)
                        );
INSERT INTO "watchlist_artists" VALUES(401,'0OdUWJ0sBjDrqHygGUXeCF','Fixture Artist','2026-01-01 09:00:00','2026-01-03 08:00:00','2026-10-20 21:38:54','2026-10-20 21:38:54','https://i.scdn.co/image/fixture-artist',1,1,0,0,0,0,0,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1,1,NULL,NULL);
CREATE TABLE watchlist_labels (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    musicbrainz_label_id TEXT UNIQUE,
                    discogs_label_id TEXT,
                    label_name TEXT NOT NULL,
                    source TEXT NOT NULL DEFAULT 'musicbrainz',
                    backlog INTEGER NOT NULL DEFAULT 0,  -- 0 = new releases only, 1 = fill backlog too
                    date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_scan_timestamp TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
CREATE TABLE watchlist_podcasts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    feed_url TEXT NOT NULL,
                    itunes_id INTEGER,
                    title TEXT NOT NULL,
                    author TEXT,
                    description TEXT,
                    artwork_url TEXT,
                    website TEXT,
                    auto_download INTEGER NOT NULL DEFAULT 1,
                    retention_days INTEGER NOT NULL DEFAULT 14,
                    episode_count INTEGER,
                    date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_scan_timestamp TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    profile_id INTEGER DEFAULT 1,
                    UNIQUE(feed_url, profile_id)
                );
CREATE TABLE watchlist_scan_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL UNIQUE,
                    profile_id INTEGER DEFAULT 1,
                    status TEXT NOT NULL,
                    started_at TIMESTAMP,
                    completed_at TIMESTAMP,
                    total_artists INTEGER DEFAULT 0,
                    artists_scanned INTEGER DEFAULT 0,
                    tracks_found INTEGER DEFAULT 0,
                    tracks_added INTEGER DEFAULT 0,
                    track_events TEXT
                );
CREATE TABLE wishlist_ignore (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile_id INTEGER NOT NULL DEFAULT 1,
                    track_id TEXT NOT NULL,
                    track_name TEXT DEFAULT '',
                    artist_name TEXT DEFAULT '',
                    reason TEXT DEFAULT 'removed',  -- 'removed' | 'cancelled'
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(profile_id, track_id)
                );
CREATE TABLE wishlist_removals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    spotify_track_id TEXT NOT NULL,
                    profile_ids TEXT,          -- JSON list, or NULL for an all-profile sweep
                    rows_removed INTEGER DEFAULT 0,
                    reason TEXT,               -- download_complete / atomic_published / already_owned / ...
                    final_path TEXT,
                    batch_id TEXT,
                    source TEXT,
                    removed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
CREATE TABLE "wishlist_tracks" (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            spotify_track_id TEXT NOT NULL,
                            spotify_data TEXT NOT NULL,
                            failure_reason TEXT,
                            retry_count INTEGER DEFAULT 0,
                            last_attempted TIMESTAMP,
                            date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            source_type TEXT DEFAULT 'unknown',
                            source_info TEXT,
                            profile_id INTEGER DEFAULT 1, quality_profile_id INTEGER DEFAULT NULL,
                            UNIQUE(profile_id, spotify_track_id)
                        );
INSERT INTO "wishlist_tracks" VALUES(301,'3n3Ppam7vgaVa1iaRUc9Lp','{"id": "3n3Ppam7vgaVa1iaRUc9Lp", "name": "Opening Song", "artists": [{"id": "0OdUWJ0sBjDrqHygGUXeCF", "name": "Fixture Artist"}], "album": {"id": "2noRn2Aes5aoNVsU6iWThc", "name": "Fixture Album (Deluxe Edition)", "release_date": "2019-05-17", "album_type": "album", "images": [{"url": "https://i.scdn.co/image/fixture-cover", "height": 640, "width": 640}]}, "duration_ms": 215000, "track_number": 1, "disc_number": 1, "popularity": 42, "external_urls": {"spotify": "https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp"}}','No suitable Soulseek results',2,'2026-01-02 10:00:00','2026-01-01 09:00:00','playlist','{"playlist_name": "Fixture Mix", "playlist_id": "37i9dQZF1DXcBWIGoYBM5M"}',1,NULL);
INSERT INTO "wishlist_tracks" VALUES(302,'6rqhFgbbKwnb9MLmUQDhG6','{"id": "6rqhFgbbKwnb9MLmUQDhG6", "name": "Caf\u00e9 \u00c9t\u00e9", "artists": [{"id": "0OdUWJ0sBjDrqHygGUXeCF", "name": "Fixture Artist"}], "album": {"id": "2noRn2Aes5aoNVsU6iWThc", "name": "Fixture Album (Deluxe Edition)", "release_date": "2019-05-17", "album_type": "album", "images": [{"url": "https://i.scdn.co/image/fixture-cover", "height": 640, "width": 640}]}, "duration_ms": 216000, "track_number": 2, "disc_number": 1, "popularity": 42, "external_urls": {"spotify": "https://open.spotify.com/track/6rqhFgbbKwnb9MLmUQDhG6"}}','Download failed',0,NULL,'2026-01-01 09:05:00','manual','{}',2,NULL);
CREATE INDEX idx_curation_track_key ON curation_signals (track_key);
CREATE INDEX idx_reorg_queue_status
                    ON reorganize_queue(status, enqueued_at)
            ;
CREATE INDEX idx_wishlist_removals_track ON wishlist_removals (spotify_track_id);
CREATE INDEX idx_wishlist_removals_at ON wishlist_removals (removed_at);
CREATE INDEX idx_wishlist_ignore_profile ON wishlist_ignore (profile_id, track_id);
CREATE INDEX idx_qsb_source ON quarantine_source_blocks (username, filename);
CREATE INDEX idx_notification_history_profile ON notification_history (profile_id, id);
CREATE INDEX idx_chat_room_messages_room ON chat_room_messages (room, timestamp);
CREATE INDEX idx_chat_room_reactions_room ON chat_room_reactions (room, target_key);
CREATE INDEX idx_chat_game_carriers_room ON chat_game_carriers (room, timestamp);
CREATE INDEX idx_watchlist_labels_mbid ON watchlist_labels (musicbrainz_label_id);
CREATE INDEX idx_watchlist_podcasts_feed ON watchlist_podcasts (feed_url);
CREATE INDEX idx_watchlist_podcasts_itunes ON watchlist_podcasts (itunes_id);
CREATE INDEX idx_downloaded_podcasts_feed ON downloaded_podcast_episodes (feed_url);
CREATE INDEX idx_downloaded_podcasts_guid ON downloaded_podcast_episodes (guid);
CREATE INDEX idx_albums_artist_id ON albums (artist_id);
CREATE INDEX idx_tracks_album_id ON tracks (album_id);
CREATE INDEX idx_tracks_artist_id ON tracks (artist_id);
CREATE INDEX idx_artists_server_source ON artists (server_source);
CREATE INDEX idx_artists_source_name_id ON artists (server_source, name, id);
CREATE INDEX idx_tracks_source_updated ON tracks (server_source, updated_at);
CREATE INDEX idx_albums_source_updated ON albums (server_source, updated_at);
CREATE INDEX idx_artists_source_updated ON artists (server_source, updated_at);
CREATE INDEX idx_albums_server_source ON albums (server_source);
CREATE INDEX idx_tracks_server_source ON tracks (server_source);
CREATE INDEX idx_artists_name ON artists (name);
CREATE INDEX idx_albums_title ON albums (title);
CREATE INDEX idx_tracks_title ON tracks (title);
CREATE INDEX idx_listenbrainz_tracks_playlist ON listenbrainz_tracks (playlist_id);
CREATE INDEX idx_listenbrainz_tracks_position ON listenbrainz_tracks (playlist_id, position);
CREATE INDEX idx_discovery_cache_lookup ON discovery_match_cache (normalized_title, normalized_artist, provider);
CREATE INDEX idx_sync_cache_lookup ON sync_match_cache (spotify_track_id, server_source);
CREATE INDEX idx_blacklist_user_file ON download_blacklist (blocked_username, blocked_filename);
CREATE INDEX idx_td_track_id ON track_downloads (track_id);
CREATE INDEX idx_td_file_path ON track_downloads (file_path);
CREATE INDEX idx_td_source ON track_downloads (source_username, source_filename);
CREATE INDEX idx_td_spotify_id ON track_downloads (spotify_track_id);
CREATE INDEX idx_td_itunes_id ON track_downloads (itunes_track_id);
CREATE INDEX idx_td_deezer_id ON track_downloads (deezer_track_id);
CREATE INDEX idx_td_tidal_id ON track_downloads (tidal_track_id);
CREATE INDEX idx_td_qobuz_id ON track_downloads (qobuz_track_id);
CREATE INDEX idx_td_mbid ON track_downloads (musicbrainz_recording_id);
CREATE INDEX idx_td_audiodb_id ON track_downloads (audiodb_id);
CREATE INDEX idx_td_soul_id ON track_downloads (soul_id);
CREATE INDEX idx_td_isrc ON track_downloads (isrc);
CREATE INDEX idx_dd_task_key ON download_decisions (task_key);
CREATE INDEX idx_dd_track_download ON download_decisions (track_download_id);
CREATE INDEX idx_tsg_released ON torrent_seed_grabs (seed_released);
CREATE INDEX idx_mb_album_release_mbid ON mb_album_release_cache (release_mbid);
CREATE INDEX idx_dab_name ON discovery_artist_blacklist (artist_name COLLATE NOCASE);
CREATE INDEX idx_dab_spotify ON discovery_artist_blacklist (spotify_artist_id);
CREATE INDEX idx_blocklist_profile_type ON blocklist (profile_id, entity_type);
CREATE INDEX idx_blocklist_spotify ON blocklist (spotify_id);
CREATE INDEX idx_blocklist_name ON blocklist (name COLLATE NOCASE);
CREATE UNIQUE INDEX idx_discovery_feedback_entity ON discovery_feedback (profile_id, entity_type, entity_key, kind);
CREATE INDEX idx_discovery_inbox_state ON discovery_inbox (profile_id, state);
CREATE INDEX idx_failed_blocklist_expires ON failed_download_blocklist (expires_at);
CREATE INDEX idx_mix_recipes_profile ON mix_recipes (profile_id);
CREATE INDEX idx_lap_profile ON liked_artists_pool (profile_id);
CREATE INDEX idx_lap_status ON liked_artists_pool (profile_id, match_status);
CREATE INDEX idx_lalp_profile ON liked_albums_pool (profile_id);
CREATE INDEX idx_lalp_spotify ON liked_albums_pool (spotify_album_id);
CREATE INDEX idx_artists_mbid ON artists (musicbrainz_id);
CREATE INDEX idx_artists_mb_status ON artists (musicbrainz_match_status);
CREATE INDEX idx_albums_mbid ON albums (musicbrainz_release_id);
CREATE INDEX idx_albums_mb_status ON albums (musicbrainz_match_status);
CREATE INDEX idx_tracks_mbid ON tracks (musicbrainz_recording_id);
CREATE INDEX idx_tracks_mb_status ON tracks (musicbrainz_match_status);
CREATE INDEX idx_mb_cache_entity ON musicbrainz_cache (entity_type, entity_name);
CREATE INDEX idx_mb_cache_mbid ON musicbrainz_cache (musicbrainz_id);
CREATE INDEX idx_mb_cache_failed ON musicbrainz_cache (entity_type, last_updated) WHERE musicbrainz_id IS NULL;
CREATE INDEX idx_artists_spotify_id ON artists (spotify_artist_id);
CREATE INDEX idx_artists_itunes_id ON artists (itunes_artist_id);
CREATE INDEX idx_albums_spotify_id ON albums (spotify_album_id);
CREATE INDEX idx_albums_itunes_id ON albums (itunes_album_id);
CREATE INDEX idx_tracks_spotify_id ON tracks (spotify_track_id);
CREATE INDEX idx_tracks_itunes_id ON tracks (itunes_track_id);
CREATE INDEX idx_artists_audiodb_id ON artists (audiodb_id);
CREATE INDEX idx_artists_audiodb_status ON artists (audiodb_match_status);
CREATE INDEX idx_albums_audiodb_id ON albums (audiodb_id);
CREATE INDEX idx_albums_audiodb_status ON albums (audiodb_match_status);
CREATE INDEX idx_tracks_audiodb_id ON tracks (audiodb_id);
CREATE INDEX idx_tracks_audiodb_status ON tracks (audiodb_match_status);
CREATE INDEX idx_artists_deezer_id ON artists (deezer_id);
CREATE INDEX idx_artists_deezer_status ON artists (deezer_match_status);
CREATE INDEX idx_albums_deezer_id ON albums (deezer_id);
CREATE INDEX idx_albums_deezer_status ON albums (deezer_match_status);
CREATE INDEX idx_tracks_deezer_id ON tracks (deezer_id);
CREATE INDEX idx_tracks_deezer_status ON tracks (deezer_match_status);
CREATE INDEX idx_tracks_repair_status ON tracks (repair_status);
CREATE INDEX idx_artists_jiosaavn_id ON artists (jiosaavn_id);
CREATE INDEX idx_artists_jiosaavn_status ON artists (jiosaavn_match_status);
CREATE INDEX idx_albums_jiosaavn_id ON albums (jiosaavn_id);
CREATE INDEX idx_albums_jiosaavn_status ON albums (jiosaavn_match_status);
CREATE INDEX idx_tracks_jiosaavn_id ON tracks (jiosaavn_id);
CREATE INDEX idx_tracks_jiosaavn_status ON tracks (jiosaavn_match_status);
CREATE INDEX idx_artists_spotify_match_status ON artists (spotify_match_status);
CREATE INDEX idx_artists_itunes_match_status ON artists (itunes_match_status);
CREATE INDEX idx_albums_spotify_match_status ON albums (spotify_match_status);
CREATE INDEX idx_albums_itunes_match_status ON albums (itunes_match_status);
CREATE INDEX idx_tracks_spotify_match_status ON tracks (spotify_match_status);
CREATE INDEX idx_tracks_itunes_match_status ON tracks (itunes_match_status);
CREATE INDEX idx_artists_lastfm_status ON artists (lastfm_match_status);
CREATE INDEX idx_artists_genius_id ON artists (genius_id);
CREATE INDEX idx_artists_genius_status ON artists (genius_match_status);
CREATE INDEX idx_albums_lastfm_status ON albums (lastfm_match_status);
CREATE INDEX idx_tracks_lastfm_status ON tracks (lastfm_match_status);
CREATE INDEX idx_tracks_genius_id ON tracks (genius_id);
CREATE INDEX idx_tracks_genius_status ON tracks (genius_match_status);
CREATE INDEX idx_artists_tidal_id ON artists (tidal_id);
CREATE INDEX idx_artists_tidal_status ON artists (tidal_match_status);
CREATE INDEX idx_artists_qobuz_id ON artists (qobuz_id);
CREATE INDEX idx_artists_qobuz_status ON artists (qobuz_match_status);
CREATE INDEX idx_albums_tidal_id ON albums (tidal_id);
CREATE INDEX idx_albums_tidal_status ON albums (tidal_match_status);
CREATE INDEX idx_albums_qobuz_id ON albums (qobuz_id);
CREATE INDEX idx_albums_qobuz_status ON albums (qobuz_match_status);
CREATE INDEX idx_tracks_tidal_id ON tracks (tidal_id);
CREATE INDEX idx_tracks_tidal_status ON tracks (tidal_match_status);
CREATE INDEX idx_tracks_qobuz_id ON tracks (qobuz_id);
CREATE INDEX idx_tracks_qobuz_status ON tracks (qobuz_match_status);
CREATE INDEX idx_tracks_isrc ON tracks (isrc);
CREATE INDEX idx_artists_discogs_id ON artists (discogs_id);
CREATE INDEX idx_artists_discogs_status ON artists (discogs_match_status);
CREATE INDEX idx_albums_discogs_id ON albums (discogs_id);
CREATE INDEX idx_albums_discogs_status ON albums (discogs_match_status);
CREATE INDEX idx_artists_amazon_id ON artists (amazon_id);
CREATE INDEX idx_artists_amazon_status ON artists (amazon_match_status);
CREATE INDEX idx_albums_amazon_id ON albums (amazon_id);
CREATE INDEX idx_albums_amazon_status ON albums (amazon_match_status);
CREATE INDEX idx_tracks_amazon_id ON tracks (amazon_id);
CREATE INDEX idx_tracks_amazon_status ON tracks (amazon_match_status);
CREATE INDEX idx_artists_similarartists_status ON artists (similar_artists_match_status);
CREATE INDEX idx_albums_bandcamp_id ON albums (bandcamp_id);
CREATE INDEX idx_albums_bandcamp_status ON albums (bandcamp_match_status);
CREATE INDEX idx_tracks_bandcamp_id ON tracks (bandcamp_id);
CREATE INDEX idx_tracks_bandcamp_status ON tracks (bandcamp_match_status);
CREATE INDEX idx_retag_groups_artist ON retag_groups (artist_name);
CREATE INDEX idx_retag_tracks_group ON retag_tracks (group_id);
CREATE INDEX idx_retag_tracks_path ON retag_tracks (file_path);
CREATE INDEX idx_watchlist_spotify_id ON watchlist_artists (spotify_artist_id);
CREATE INDEX idx_watchlist_profile ON watchlist_artists (profile_id);
CREATE INDEX idx_wishlist_spotify_id ON wishlist_tracks (spotify_track_id);
CREATE INDEX idx_wishlist_profile ON wishlist_tracks (profile_id);
CREATE INDEX idx_discovery_pool_profile ON discovery_pool (profile_id);
CREATE INDEX idx_discovery_recent_albums_profile ON discovery_recent_albums (profile_id);
CREATE INDEX idx_recent_releases_profile ON recent_releases (profile_id);
CREATE INDEX idx_similar_artists_profile ON similar_artists (profile_id);
CREATE INDEX idx_lb_playlists_profile ON listenbrainz_playlists (profile_id);
CREATE INDEX idx_profile_audit_created ON profile_audit (created_at);
CREATE INDEX idx_profile_devices_by_profile ON profile_devices (owner_id);
CREATE INDEX idx_tracks_source_owner ON tracks (server_source, owner_profile_id, id);
CREATE INDEX idx_albums_source_owner ON albums (server_source, owner_profile_id, id);
CREATE INDEX idx_artists_source_owner ON artists (server_source, owner_profile_id, id);
CREATE INDEX idx_service_credentials_service ON service_credentials (service);
CREATE INDEX idx_artists_soul_id ON artists (soul_id);
CREATE INDEX idx_albums_soul_id ON albums (soul_id);
CREATE INDEX idx_tracks_soul_id ON tracks (soul_id);
CREATE INDEX idx_tracks_album_soul_id ON tracks (album_soul_id);
CREATE INDEX idx_listening_played_at ON listening_history (played_at);
CREATE INDEX idx_listening_weekday_hour_played_at
                ON listening_history (
                    CAST(strftime('%w', played_at) AS INTEGER),
                    CAST(strftime('%H', played_at) AS INTEGER),
                    played_at DESC
                )
            ;
CREATE INDEX idx_listening_artist ON listening_history (artist);
CREATE UNIQUE INDEX idx_listening_dedup_pile ON listening_history (track_id, played_at, server_source, profile_id);
CREATE INDEX idx_listening_import_source_time ON listening_import_events(source, listened_at);
CREATE INDEX idx_spotify_library_album_id ON spotify_library_cache (spotify_album_id);
CREATE INDEX idx_spotify_library_profile ON spotify_library_cache (profile_id);
CREATE INDEX idx_mce_lookup ON metadata_cache_entities (source, entity_type, entity_id);
CREATE INDEX idx_mce_name ON metadata_cache_entities (entity_type, name COLLATE NOCASE);
CREATE INDEX idx_mce_artist ON metadata_cache_entities (artist_name COLLATE NOCASE);
CREATE INDEX idx_mce_accessed ON metadata_cache_entities (last_accessed_at);
CREATE INDEX idx_mce_source ON metadata_cache_entities (source);
CREATE INDEX idx_mce_browse ON metadata_cache_entities (entity_type, source, last_accessed_at DESC);
CREATE INDEX idx_mce_browse_name ON metadata_cache_entities (entity_type, source, name COLLATE NOCASE);
CREATE INDEX idx_mce_browse_pop ON metadata_cache_entities (entity_type, source, popularity DESC);
CREATE INDEX idx_mce_stats ON metadata_cache_entities (entity_type, source, access_count);
CREATE INDEX idx_mcs_lookup ON metadata_cache_searches (source, search_type, query_normalized);
CREATE INDEX idx_rf_job ON repair_findings (job_id);
CREATE INDEX idx_rf_status ON repair_findings (status);
CREATE INDEX idx_rf_type ON repair_findings (finding_type);
CREATE INDEX idx_rf_created ON repair_findings (created_at);
CREATE INDEX idx_rjr_job ON repair_job_runs (job_id);
CREATE INDEX idx_rf_entity ON repair_findings (entity_type, entity_id);
CREATE INDEX idx_rf_path ON repair_findings (file_path);
CREATE INDEX idx_rf_type_status ON repair_findings (finding_type, status);
CREATE INDEX idx_artists_name_norm ON artists (name_norm);
CREATE TRIGGER trg_artists_name_norm_stale
                    AFTER UPDATE OF name ON artists
                    WHEN NEW.name IS NOT OLD.name AND NEW.name_norm IS OLD.name_norm
                    BEGIN
                        UPDATE artists SET name_norm = NULL WHERE rowid = NEW.rowid;
                    END;
CREATE INDEX idx_artists_name_key ON artists (name_key);
CREATE TRIGGER trg_artists_name_key_stale
                    AFTER UPDATE OF name ON artists
                    WHEN NEW.name IS NOT OLD.name AND NEW.name_key IS OLD.name_key
                    BEGIN
                        UPDATE artists SET name_key = NULL WHERE rowid = NEW.rowid;
                    END;
CREATE INDEX idx_albums_title_norm ON albums (title_norm);
CREATE TRIGGER trg_albums_title_norm_stale
                    AFTER UPDATE OF title ON albums
                    WHEN NEW.title IS NOT OLD.title AND NEW.title_norm IS OLD.title_norm
                    BEGIN
                        UPDATE albums SET title_norm = NULL WHERE rowid = NEW.rowid;
                    END;
CREATE INDEX idx_tracks_title_norm ON tracks (title_norm);
CREATE TRIGGER trg_tracks_title_norm_stale
                    AFTER UPDATE OF title ON tracks
                    WHEN NEW.title IS NOT OLD.title AND NEW.title_norm IS OLD.title_norm
                    BEGIN
                        UPDATE tracks SET title_norm = NULL WHERE rowid = NEW.rowid;
                    END;
CREATE INDEX idx_tracks_track_artist_norm ON tracks (track_artist_norm);
CREATE TRIGGER trg_tracks_track_artist_norm_stale
                    AFTER UPDATE OF track_artist ON tracks
                    WHEN NEW.track_artist IS NOT OLD.track_artist AND NEW.track_artist_norm IS OLD.track_artist_norm
                    BEGIN
                        UPDATE tracks SET track_artist_norm = NULL WHERE rowid = NEW.rowid;
                    END;
CREATE INDEX idx_track_credits_name ON track_credits (name_norm);
CREATE TRIGGER trg_track_credits_stale
                AFTER UPDATE OF track_artist_norm ON tracks
                WHEN NEW.track_artist_norm IS NULL
                BEGIN
                    DELETE FROM track_credits WHERE track_id = NEW.id;
                END;
CREATE TRIGGER trg_track_credits_gone
                AFTER DELETE ON tracks
                BEGIN
                    DELETE FROM track_credits WHERE track_id = OLD.id;
                END;
CREATE TRIGGER trg_albums_fts_ai AFTER INSERT ON albums BEGIN
                    INSERT INTO albums_fts(rowid, title_norm) VALUES (NEW.rowid, NEW.title_norm);
                END;
CREATE TRIGGER trg_albums_fts_ad AFTER DELETE ON albums BEGIN
                    INSERT INTO albums_fts(albums_fts, rowid, title_norm) VALUES ('delete', OLD.rowid, OLD.title_norm);
                END;
CREATE TRIGGER trg_albums_fts_au AFTER UPDATE OF title_norm ON albums BEGIN
                    INSERT INTO albums_fts(albums_fts, rowid, title_norm) VALUES ('delete', OLD.rowid, OLD.title_norm);
                    INSERT INTO albums_fts(rowid, title_norm) VALUES (NEW.rowid, NEW.title_norm);
                END;
CREATE INDEX idx_gtc_hash ON genre_translation_cache (whitelist_hash);
CREATE INDEX idx_mirrored_playlists_profile ON mirrored_playlists (profile_id);
CREATE INDEX idx_mirrored_playlists_source ON mirrored_playlists (source, source_playlist_id);
CREATE INDEX idx_mirrored_tracks_playlist ON mirrored_playlist_tracks (playlist_id);
CREATE INDEX idx_automations_profile ON automations (profile_id);
CREATE INDEX idx_automations_enabled ON automations (enabled);
CREATE INDEX idx_arh_automation_id ON automation_run_history(automation_id);
CREATE INDEX idx_pprh_playlist_id ON playlist_pipeline_run_history(playlist_id);
CREATE INDEX idx_pprh_profile_id ON playlist_pipeline_run_history(profile_id);
CREATE INDEX idx_library_issues_profile ON library_issues (profile_id);
CREATE INDEX idx_library_issues_status ON library_issues (status);
CREATE INDEX idx_library_issues_entity ON library_issues (entity_type, entity_id);
CREATE INDEX idx_library_issues_created ON library_issues (created_at);
CREATE INDEX idx_lh_event_type ON library_history (event_type);
CREATE INDEX idx_lh_created_at ON library_history (created_at DESC);
CREATE INDEX idx_lh_verification_status ON library_history (verification_status);
CREATE INDEX idx_lh_origin ON library_history (origin, created_at DESC);
CREATE INDEX idx_wsr_completed ON watchlist_scan_runs (completed_at DESC);
CREATE INDEX idx_aih_status ON auto_import_history (status);
CREATE INDEX idx_aih_folder_hash ON auto_import_history (folder_hash);
CREATE INDEX idx_rmh_staged_path ON rematch_hints (staged_path);
CREATE INDEX idx_rmh_content_hash ON rematch_hints (content_hash);
CREATE INDEX idx_rmh_status ON rematch_hints (status);
CREATE INDEX idx_sh_started_at ON sync_history (started_at DESC);
CREATE INDEX idx_sh_source ON sync_history (source);
CREATE INDEX idx_personalized_tracks_playlist
    ON personalized_playlist_tracks(playlist_id)
;
CREATE INDEX idx_personalized_history_lookup
    ON personalized_track_history(profile_id, kind, track_id, served_at)
;
CREATE INDEX idx_quality_profiles_default ON quality_profiles(is_default);
CREATE INDEX idx_track_artist_credits_artist ON track_artist_credits (source, source_artist_id);
CREATE TRIGGER trg_track_artist_credits_gone
        AFTER DELETE ON tracks
        BEGIN
            DELETE FROM track_artist_credits WHERE track_id = OLD.id;
            DELETE FROM track_artist_credits_pending WHERE track_id = OLD.id;
        END;
CREATE TRIGGER trg_track_artist_credits_spotify_rematch
            AFTER UPDATE OF spotify_track_id ON tracks
            WHEN NEW.spotify_track_id IS NOT OLD.spotify_track_id
            BEGIN
                DELETE FROM track_artist_credits
                WHERE track_id = NEW.id AND source = 'spotify';
                INSERT OR IGNORE INTO track_artist_credits_pending (track_id, source)
                SELECT NEW.id, 'spotify'
                WHERE NEW.spotify_track_id IS NOT NULL AND NEW.spotify_track_id != '';
            END;
CREATE TRIGGER trg_track_artist_credits_deezer_rematch
            AFTER UPDATE OF deezer_id ON tracks
            WHEN NEW.deezer_id IS NOT OLD.deezer_id
            BEGIN
                DELETE FROM track_artist_credits
                WHERE track_id = NEW.id AND source = 'deezer';
                INSERT OR IGNORE INTO track_artist_credits_pending (track_id, source)
                SELECT NEW.id, 'deezer'
                WHERE NEW.deezer_id IS NOT NULL AND NEW.deezer_id != '';
            END;
CREATE INDEX idx_album_artist_credits_artist ON album_artist_credits (source, source_artist_id);
CREATE TRIGGER trg_album_artist_credits_gone
        AFTER DELETE ON albums
        BEGIN
            DELETE FROM album_artist_credits WHERE album_id = OLD.id;
            DELETE FROM album_artist_credits_pending WHERE album_id = OLD.id;
        END;
CREATE TRIGGER trg_album_artist_credits_spotify_rematch
            AFTER UPDATE OF spotify_album_id ON albums
            WHEN NEW.spotify_album_id IS NOT OLD.spotify_album_id
            BEGIN
                DELETE FROM album_artist_credits
                WHERE album_id = NEW.id AND source = 'spotify';
                INSERT OR IGNORE INTO album_artist_credits_pending (album_id, source)
                SELECT NEW.id, 'spotify'
                WHERE NEW.spotify_album_id IS NOT NULL AND NEW.spotify_album_id != '';
            END;
CREATE TRIGGER trg_album_artist_credits_deezer_rematch
            AFTER UPDATE OF deezer_id ON albums
            WHEN NEW.deezer_id IS NOT OLD.deezer_id
            BEGIN
                DELETE FROM album_artist_credits
                WHERE album_id = NEW.id AND source = 'deezer';
                INSERT OR IGNORE INTO album_artist_credits_pending (album_id, source)
                SELECT NEW.id, 'deezer'
                WHERE NEW.deezer_id IS NOT NULL AND NEW.deezer_id != '';
            END;
CREATE INDEX idx_mltm_lookup
                    ON manual_library_track_matches (profile_id, source, source_track_id, server_source)
                ;
CREATE INDEX idx_mltm_lib_track
                    ON manual_library_track_matches (library_track_id)
                ;
PRAGMA writable_schema=OFF;
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('profiles',2);
INSERT INTO "sqlite_sequence" VALUES('watchlist_artists',401);
INSERT INTO "sqlite_sequence" VALUES('wishlist_tracks',302);
INSERT INTO "sqlite_sequence" VALUES('bubble_snapshots',0);
INSERT INTO "sqlite_sequence" VALUES('discovery_curated_playlists',0);
INSERT INTO "sqlite_sequence" VALUES('discovery_pool',461);
INSERT INTO "sqlite_sequence" VALUES('discovery_recent_albums',0);
INSERT INTO "sqlite_sequence" VALUES('recent_releases',471);
INSERT INTO "sqlite_sequence" VALUES('similar_artists',451);
INSERT INTO "sqlite_sequence" VALUES('discovery_pool_metadata',0);
INSERT INTO "sqlite_sequence" VALUES('listenbrainz_playlists',501);
INSERT INTO "sqlite_sequence" VALUES('listenbrainz_tracks',511);
INSERT INTO "sqlite_sequence" VALUES('mirrored_playlists',601);
INSERT INTO "sqlite_sequence" VALUES('mirrored_playlist_tracks',612);
INSERT INTO "sqlite_sequence" VALUES('sync_history',701);
COMMIT;
