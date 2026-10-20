-- SoulSync 2.0 (d6fd206efa91bbeccf091f3b82931e94b63f5a86) music database as that release creates it,
-- plus the representative rows listed in manifest.json.
-- Regenerate with: python tests/fixtures/old_databases/generate.py 2.0
PRAGMA user_version=0;
BEGIN TRANSACTION;
CREATE TABLE _genius_search_fix_applied (applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "albums" (
                    id TEXT PRIMARY KEY,
                    artist_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    year INTEGER,
                    thumb_url TEXT,
                    genres TEXT,
                    track_count INTEGER,
                    duration INTEGER,
                    server_source TEXT DEFAULT 'plex',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, musicbrainz_release_id TEXT, musicbrainz_last_attempted TIMESTAMP, musicbrainz_match_status TEXT, spotify_album_id TEXT, itunes_album_id TEXT, audiodb_id TEXT, audiodb_match_status TEXT, audiodb_last_attempted TIMESTAMP, style TEXT, mood TEXT, deezer_id TEXT, deezer_match_status TEXT, deezer_last_attempted TIMESTAMP, label TEXT, explicit INTEGER, record_type TEXT, spotify_match_status TEXT, spotify_last_attempted TIMESTAMP, itunes_match_status TEXT, itunes_last_attempted TIMESTAMP, lastfm_match_status TEXT, lastfm_last_attempted TIMESTAMP, lastfm_listeners INTEGER, lastfm_playcount INTEGER, lastfm_tags TEXT, lastfm_wiki TEXT, lastfm_url TEXT, tidal_id TEXT, tidal_match_status TEXT, tidal_last_attempted TIMESTAMP, qobuz_id TEXT, qobuz_match_status TEXT, qobuz_last_attempted TIMESTAMP, upc TEXT, copyright TEXT,
                    FOREIGN KEY (artist_id) REFERENCES "artists" (id) ON DELETE CASCADE
                );
INSERT INTO "albums" VALUES('9101','9001','Fixture Album (Deluxe Edition)',2019,'/library/metadata/9101/thumb/1700000000','["Rock", "Indie Rock"]',2,431000,'plex','2026-10-20 21:38:31','2026-10-20 21:38:31',NULL,NULL,NULL,'2noRn2Aes5aoNVsU6iWThc',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
CREATE TABLE "artists" (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    thumb_url TEXT,
                    genres TEXT,
                    summary TEXT,
                    server_source TEXT DEFAULT 'plex',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                , musicbrainz_id TEXT, musicbrainz_last_attempted TIMESTAMP, musicbrainz_match_status TEXT, spotify_artist_id TEXT, itunes_artist_id TEXT, audiodb_id TEXT, audiodb_match_status TEXT, audiodb_last_attempted TIMESTAMP, style TEXT, mood TEXT, label TEXT, banner_url TEXT, deezer_id TEXT, deezer_match_status TEXT, deezer_last_attempted TIMESTAMP, spotify_match_status TEXT, spotify_last_attempted TIMESTAMP, itunes_match_status TEXT, itunes_last_attempted TIMESTAMP, lastfm_match_status TEXT, lastfm_last_attempted TIMESTAMP, lastfm_listeners INTEGER, lastfm_playcount INTEGER, lastfm_tags TEXT, lastfm_similar TEXT, lastfm_bio TEXT, lastfm_url TEXT, genius_id TEXT, genius_match_status TEXT, genius_last_attempted TIMESTAMP, genius_description TEXT, genius_alt_names TEXT, genius_url TEXT, tidal_id TEXT, tidal_match_status TEXT, tidal_last_attempted TIMESTAMP, qobuz_id TEXT, qobuz_match_status TEXT, qobuz_last_attempted TIMESTAMP);
INSERT INTO "artists" VALUES('9001','Fixture Artist','/library/metadata/9001/thumb/1700000000','Rock, Indie Rock','Artist row written by the upgrade-test fixture generator.','plex','2026-10-20 21:38:31','2026-10-20 21:38:31','f1d1c2a0-0000-4000-8000-000000009001',NULL,NULL,'0OdUWJ0sBjDrqHygGUXeCF',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
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
                , notify_type TEXT DEFAULT NULL, notify_config TEXT DEFAULT '{}', last_result TEXT DEFAULT NULL, is_system INTEGER DEFAULT 0, then_actions TEXT DEFAULT '[]');
CREATE TABLE "bubble_snapshots" (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            type TEXT NOT NULL,
                            data TEXT NOT NULL,
                            timestamp TEXT NOT NULL,
                            snapshot_id TEXT NOT NULL,
                            profile_id INTEGER DEFAULT 1,
                            UNIQUE(profile_id, type)
                        );
CREATE TABLE "discovery_curated_playlists" (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            playlist_type TEXT NOT NULL,
                            track_ids_json TEXT NOT NULL,
                            curated_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            profile_id INTEGER DEFAULT 1,
                            UNIQUE(profile_id, playlist_type)
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
INSERT INTO "discovery_pool" VALUES(461,'7fixtureDiscovery0000','5fixtureDiscAlbum0000','4Z8W4fKeB5YxbusRsdQVPb',NULL,NULL,NULL,'spotify','Discovered Tune','Similar Fixture Band','Found Sounds','https://i.scdn.co/image/fixture-found',198000,37,'2025-11-01',0,'{"id": "7fixtureDiscovery0000", "name": "Discovered Tune"}',NULL,'2026-10-20 21:38:31',1);
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
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
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
INSERT INTO "listenbrainz_playlists" VALUES(501,'c0ffee00-0000-4000-8000-000000000501','Weekly Jams for fixture','troi-bot','weekly-jams',1,NULL,1,'2026-10-20 21:38:31','2026-10-20 21:38:31');
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
CREATE TABLE metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
INSERT INTO "metadata" VALUES('id_columns_migrated','true','2026-10-20 21:38:31');
INSERT INTO "metadata" VALUES('profiles_migration_v1','true','2026-10-20 21:38:31');
INSERT INTO "metadata" VALUES('profiles_migration_v2','true','2026-10-20 21:38:31');
INSERT INTO "metadata" VALUES('profiles_migration_v3','true','2026-10-20 21:38:31');
INSERT INTO "metadata" VALUES('profiles_migration_v4','1','2026-10-20 21:38:31');
INSERT INTO "metadata" VALUES('profiles_migration_settings','1','2026-10-20 21:38:31');
INSERT INTO "metadata" VALUES('profiles_listenbrainz_v1','1','2026-10-20 21:38:31');
INSERT INTO "metadata" VALUES('spotify_library_cache_v1','1','2026-10-20 21:38:31');
INSERT INTO "metadata" VALUES('metadata_cache_v1','1','2026-10-20 21:38:31');
INSERT INTO "metadata" VALUES('repair_worker_v2','1','2026-10-20 21:38:31');
INSERT INTO "metadata" VALUES('last_full_refresh','2026-01-01T12:00:00','2026-10-20 21:38:31');
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
                    mirrored_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(source, source_playlist_id, profile_id)
                );
INSERT INTO "mirrored_playlists" VALUES(601,'spotify','37i9dQZF1DXcBWIGoYBM5M','Fixture Mix','Mirrored by the fixture generator','fixture','https://i.scdn.co/image/fixture-mix',2,1,'2026-10-20 21:38:31','2026-10-20 21:38:31');
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
CREATE TABLE profiles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    avatar_color TEXT DEFAULT '#6366f1',
                    pin_hash TEXT,
                    is_admin INTEGER NOT NULL DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                , avatar_url TEXT DEFAULT NULL, home_page TEXT DEFAULT NULL, allowed_pages TEXT DEFAULT NULL, can_download INTEGER DEFAULT 1, listenbrainz_token TEXT DEFAULT NULL, listenbrainz_base_url TEXT DEFAULT NULL, listenbrainz_username TEXT DEFAULT NULL);
INSERT INTO "profiles" VALUES(1,'Admin','#6366f1',NULL,1,'2026-10-20 21:38:31','2026-10-20 21:38:31',NULL,NULL,NULL,1,NULL,NULL,NULL);
INSERT INTO "profiles" VALUES(2,'Fixture Listener','#22c55e',NULL,0,'2026-10-20 21:38:31','2026-10-20 21:38:31',NULL,NULL,NULL,1,NULL,NULL,NULL);
CREATE TABLE "recent_releases" (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            watchlist_artist_id INTEGER NOT NULL,
                            album_spotify_id TEXT,
                            album_itunes_id TEXT,
                            source TEXT NOT NULL DEFAULT 'spotify',
                            album_name TEXT NOT NULL,
                            release_date TEXT NOT NULL,
                            album_cover_url TEXT,
                            track_count INTEGER DEFAULT 0,
                            added_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            profile_id INTEGER DEFAULT 1,
                            UNIQUE(profile_id, watchlist_artist_id, album_spotify_id, album_itunes_id)
                        );
INSERT INTO "recent_releases" VALUES(471,401,'1fixtureNewAlbum00000',NULL,'spotify','Fixture Comeback','2026-01-10','https://i.scdn.co/image/fixture-comeback',10,'2026-10-20 21:38:31',1);
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
                );
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
                );
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
CREATE TABLE "similar_artists" (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            source_artist_id TEXT NOT NULL,
                            similar_artist_spotify_id TEXT,
                            similar_artist_itunes_id TEXT,
                            similar_artist_name TEXT NOT NULL,
                            similarity_rank INTEGER DEFAULT 1,
                            occurrence_count INTEGER DEFAULT 1,
                            last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                            last_featured TIMESTAMP,
                            profile_id INTEGER DEFAULT 1,
                            UNIQUE(profile_id, source_artist_id, similar_artist_name)
                        );
INSERT INTO "similar_artists" VALUES(451,'0OdUWJ0sBjDrqHygGUXeCF','4Z8W4fKeB5YxbusRsdQVPb',NULL,'Similar Fixture Band',1,3,'2026-10-20 21:38:31',NULL,1);
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
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, musicbrainz_recording_id TEXT, musicbrainz_last_attempted TIMESTAMP, musicbrainz_match_status TEXT, spotify_track_id TEXT, itunes_track_id TEXT, audiodb_id TEXT, audiodb_match_status TEXT, audiodb_last_attempted TIMESTAMP, style TEXT, mood TEXT, deezer_id TEXT, deezer_match_status TEXT, deezer_last_attempted TIMESTAMP, bpm REAL, explicit INTEGER, repair_status TEXT, repair_last_checked TIMESTAMP, spotify_match_status TEXT, spotify_last_attempted TIMESTAMP, itunes_match_status TEXT, itunes_last_attempted TIMESTAMP, lastfm_match_status TEXT, lastfm_last_attempted TIMESTAMP, lastfm_listeners INTEGER, lastfm_playcount INTEGER, lastfm_tags TEXT, lastfm_url TEXT, genius_id TEXT, genius_match_status TEXT, genius_last_attempted TIMESTAMP, genius_lyrics TEXT, genius_description TEXT, genius_url TEXT, tidal_id TEXT, tidal_match_status TEXT, tidal_last_attempted TIMESTAMP, qobuz_id TEXT, qobuz_match_status TEXT, qobuz_last_attempted TIMESTAMP, isrc TEXT, copyright TEXT,
                    FOREIGN KEY (album_id) REFERENCES "albums" (id) ON DELETE CASCADE,
                    FOREIGN KEY (artist_id) REFERENCES "artists" (id) ON DELETE CASCADE
                );
INSERT INTO "tracks" VALUES('9201','9101','9001','Opening Song',1,215000,'/music/Fixture Artist/Fixture Album (Deluxe Edition) (2019)/01 - Opening Song.flac',1411,'plex','2026-10-20 21:38:31','2026-10-20 21:38:31',NULL,NULL,NULL,'3n3Ppam7vgaVa1iaRUc9Lp',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "tracks" VALUES('9202','9101','9001','Café Été',2,216000,'/music/Fixture Artist/Fixture Album (Deluxe Edition) (2019)/02 - Café Été.mp3',320,'plex','2026-10-20 21:38:31','2026-10-20 21:38:31',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
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
                            itunes_artist_id TEXT,
                            profile_id INTEGER DEFAULT 1,
                            UNIQUE(profile_id, spotify_artist_id),
                            UNIQUE(profile_id, itunes_artist_id)
                        );
INSERT INTO "watchlist_artists" VALUES(401,'0OdUWJ0sBjDrqHygGUXeCF','Fixture Artist','2026-01-01 09:00:00','2026-01-03 08:00:00','2026-10-20 21:38:31','2026-10-20 21:38:31','https://i.scdn.co/image/fixture-artist',1,1,0,0,0,0,0,NULL,1);
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
                            profile_id INTEGER DEFAULT 1,
                            UNIQUE(profile_id, spotify_track_id)
                        );
INSERT INTO "wishlist_tracks" VALUES(301,'3n3Ppam7vgaVa1iaRUc9Lp','{"id": "3n3Ppam7vgaVa1iaRUc9Lp", "name": "Opening Song", "artists": [{"id": "0OdUWJ0sBjDrqHygGUXeCF", "name": "Fixture Artist"}], "album": {"id": "2noRn2Aes5aoNVsU6iWThc", "name": "Fixture Album (Deluxe Edition)", "release_date": "2019-05-17", "album_type": "album", "images": [{"url": "https://i.scdn.co/image/fixture-cover", "height": 640, "width": 640}]}, "duration_ms": 215000, "track_number": 1, "disc_number": 1, "popularity": 42, "external_urls": {"spotify": "https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp"}}','No suitable Soulseek results',2,'2026-01-02 10:00:00','2026-01-01 09:00:00','playlist','{"playlist_name": "Fixture Mix", "playlist_id": "37i9dQZF1DXcBWIGoYBM5M"}',1);
INSERT INTO "wishlist_tracks" VALUES(302,'6rqhFgbbKwnb9MLmUQDhG6','{"id": "6rqhFgbbKwnb9MLmUQDhG6", "name": "Caf\u00e9 \u00c9t\u00e9", "artists": [{"id": "0OdUWJ0sBjDrqHygGUXeCF", "name": "Fixture Artist"}], "album": {"id": "2noRn2Aes5aoNVsU6iWThc", "name": "Fixture Album (Deluxe Edition)", "release_date": "2019-05-17", "album_type": "album", "images": [{"url": "https://i.scdn.co/image/fixture-cover", "height": 640, "width": 640}]}, "duration_ms": 216000, "track_number": 2, "disc_number": 1, "popularity": 42, "external_urls": {"spotify": "https://open.spotify.com/track/6rqhFgbbKwnb9MLmUQDhG6"}}','Download failed',0,NULL,'2026-01-01 09:05:00','manual','{}',2);
CREATE INDEX idx_albums_artist_id ON albums (artist_id);
CREATE INDEX idx_tracks_album_id ON tracks (album_id);
CREATE INDEX idx_tracks_artist_id ON tracks (artist_id);
CREATE INDEX idx_artists_server_source ON artists (server_source);
CREATE INDEX idx_albums_server_source ON albums (server_source);
CREATE INDEX idx_tracks_server_source ON tracks (server_source);
CREATE INDEX idx_artists_name ON artists (name);
CREATE INDEX idx_albums_title ON albums (title);
CREATE INDEX idx_tracks_title ON tracks (title);
CREATE INDEX idx_listenbrainz_tracks_playlist ON listenbrainz_tracks (playlist_id);
CREATE INDEX idx_listenbrainz_tracks_position ON listenbrainz_tracks (playlist_id, position);
CREATE INDEX idx_discovery_cache_lookup ON discovery_match_cache (normalized_title, normalized_artist, provider);
CREATE INDEX idx_sync_cache_lookup ON sync_match_cache (spotify_track_id, server_source);
CREATE INDEX idx_artists_mbid ON artists (musicbrainz_id);
CREATE INDEX idx_artists_mb_status ON artists (musicbrainz_match_status);
CREATE INDEX idx_albums_mbid ON albums (musicbrainz_release_id);
CREATE INDEX idx_albums_mb_status ON albums (musicbrainz_match_status);
CREATE INDEX idx_tracks_mbid ON tracks (musicbrainz_recording_id);
CREATE INDEX idx_tracks_mb_status ON tracks (musicbrainz_match_status);
CREATE INDEX idx_mb_cache_entity ON musicbrainz_cache (entity_type, entity_name);
CREATE INDEX idx_mb_cache_mbid ON musicbrainz_cache (musicbrainz_id);
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
CREATE INDEX idx_spotify_library_album_id ON spotify_library_cache (spotify_album_id);
CREATE INDEX idx_spotify_library_profile ON spotify_library_cache (profile_id);
CREATE INDEX idx_mce_lookup ON metadata_cache_entities (source, entity_type, entity_id);
CREATE INDEX idx_mce_name ON metadata_cache_entities (entity_type, name COLLATE NOCASE);
CREATE INDEX idx_mce_artist ON metadata_cache_entities (artist_name COLLATE NOCASE);
CREATE INDEX idx_mce_accessed ON metadata_cache_entities (last_accessed_at);
CREATE INDEX idx_mce_source ON metadata_cache_entities (source);
CREATE INDEX idx_mcs_lookup ON metadata_cache_searches (source, search_type, query_normalized);
CREATE INDEX idx_rf_job ON repair_findings (job_id);
CREATE INDEX idx_rf_status ON repair_findings (status);
CREATE INDEX idx_rf_type ON repair_findings (finding_type);
CREATE INDEX idx_rf_created ON repair_findings (created_at);
CREATE INDEX idx_rjr_job ON repair_job_runs (job_id);
CREATE INDEX idx_mirrored_playlists_profile ON mirrored_playlists (profile_id);
CREATE INDEX idx_mirrored_playlists_source ON mirrored_playlists (source, source_playlist_id);
CREATE INDEX idx_mirrored_tracks_playlist ON mirrored_playlist_tracks (playlist_id);
CREATE INDEX idx_automations_profile ON automations (profile_id);
CREATE INDEX idx_automations_enabled ON automations (enabled);
CREATE INDEX idx_arh_automation_id ON automation_run_history(automation_id);
CREATE INDEX idx_library_issues_profile ON library_issues (profile_id);
CREATE INDEX idx_library_issues_status ON library_issues (status);
CREATE INDEX idx_library_issues_entity ON library_issues (entity_type, entity_id);
CREATE INDEX idx_library_issues_created ON library_issues (created_at);
CREATE INDEX idx_lh_event_type ON library_history (event_type);
CREATE INDEX idx_lh_created_at ON library_history (created_at DESC);
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
COMMIT;
