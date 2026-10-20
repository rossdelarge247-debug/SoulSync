-- SoulSync 1.3 (d4f1b3ed9a740aafba3762d572eb02c3fb0553ab) music database as that release creates it,
-- plus the representative rows listed in manifest.json.
-- Regenerate with: python tests/fixtures/old_databases/generate.py 1.3
PRAGMA user_version=0;
BEGIN TRANSACTION;
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
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (artist_id) REFERENCES "artists" (id) ON DELETE CASCADE
                );
INSERT INTO "albums" VALUES('9101','9001','Fixture Album (Deluxe Edition)',2019,'/library/metadata/9101/thumb/1700000000','["Rock", "Indie Rock"]',2,431000,'plex','2026-10-20 21:38:28','2026-10-20 21:38:28');
CREATE TABLE "artists" (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    thumb_url TEXT,
                    genres TEXT,
                    summary TEXT,
                    server_source TEXT DEFAULT 'plex',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
INSERT INTO "artists" VALUES('9001','Fixture Artist','/library/metadata/9001/thumb/1700000000','Rock, Indie Rock','Artist row written by the upgrade-test fixture generator.','plex','2026-10-20 21:38:28','2026-10-20 21:38:28');
CREATE TABLE discovery_curated_playlists (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    playlist_type TEXT NOT NULL UNIQUE,
                    track_ids_json TEXT NOT NULL,
                    curated_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
CREATE TABLE discovery_pool (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    spotify_track_id TEXT UNIQUE NOT NULL,
                    spotify_album_id TEXT NOT NULL,
                    spotify_artist_id TEXT NOT NULL,
                    track_name TEXT NOT NULL,
                    artist_name TEXT NOT NULL,
                    album_name TEXT NOT NULL,
                    album_cover_url TEXT,
                    duration_ms INTEGER,
                    popularity INTEGER DEFAULT 0,
                    release_date TEXT,
                    is_new_release BOOLEAN DEFAULT 0,
                    track_data_json TEXT NOT NULL,
                    added_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                , artist_genres TEXT);
INSERT INTO "discovery_pool" VALUES(461,'7fixtureDiscovery0000','5fixtureDiscAlbum0000','4Z8W4fKeB5YxbusRsdQVPb','Discovered Tune','Similar Fixture Band','Found Sounds','https://i.scdn.co/image/fixture-found',198000,37,'2025-11-01',0,'{"id": "7fixtureDiscovery0000", "name": "Discovered Tune"}','2026-10-20 21:38:28',NULL);
CREATE TABLE discovery_pool_metadata (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    last_populated_timestamp TIMESTAMP NOT NULL,
                    track_count INTEGER DEFAULT 0,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
CREATE TABLE discovery_recent_albums (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    album_spotify_id TEXT NOT NULL UNIQUE,
                    album_name TEXT NOT NULL,
                    artist_name TEXT NOT NULL,
                    artist_spotify_id TEXT NOT NULL,
                    album_cover_url TEXT,
                    release_date TEXT NOT NULL,
                    album_type TEXT DEFAULT 'album',
                    cached_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
CREATE TABLE listenbrainz_playlists (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    playlist_mbid TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL,
                    creator TEXT,
                    playlist_type TEXT NOT NULL,
                    track_count INTEGER DEFAULT 0,
                    annotation_data TEXT,
                    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    cached_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
INSERT INTO "listenbrainz_playlists" VALUES(501,'c0ffee00-0000-4000-8000-000000000501','Weekly Jams for fixture','troi-bot','weekly-jams',1,NULL,'2026-10-20 21:38:28','2026-10-20 21:38:28');
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
INSERT INTO "metadata" VALUES('id_columns_migrated','true','2026-10-20 21:38:28');
INSERT INTO "metadata" VALUES('last_full_refresh','2026-01-01T12:00:00','2026-10-20 21:38:28');
CREATE TABLE recent_releases (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    watchlist_artist_id INTEGER NOT NULL,
                    album_spotify_id TEXT NOT NULL,
                    album_name TEXT NOT NULL,
                    release_date TEXT NOT NULL,
                    album_cover_url TEXT,
                    track_count INTEGER DEFAULT 0,
                    added_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(watchlist_artist_id, album_spotify_id),
                    FOREIGN KEY (watchlist_artist_id) REFERENCES watchlist_artists (id) ON DELETE CASCADE
                );
INSERT INTO "recent_releases" VALUES(471,401,'1fixtureNewAlbum00000','Fixture Comeback','2026-01-10','https://i.scdn.co/image/fixture-comeback',10,'2026-10-20 21:38:28');
CREATE TABLE similar_artists (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_artist_id TEXT NOT NULL,
                    similar_artist_spotify_id TEXT NOT NULL,
                    similar_artist_name TEXT NOT NULL,
                    similarity_rank INTEGER DEFAULT 1,
                    occurrence_count INTEGER DEFAULT 1,
                    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(source_artist_id, similar_artist_spotify_id)
                );
INSERT INTO "similar_artists" VALUES(451,'0OdUWJ0sBjDrqHygGUXeCF','4Z8W4fKeB5YxbusRsdQVPb','Similar Fixture Band',1,3,'2026-10-20 21:38:28');
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
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (album_id) REFERENCES "albums" (id) ON DELETE CASCADE,
                    FOREIGN KEY (artist_id) REFERENCES "artists" (id) ON DELETE CASCADE
                );
INSERT INTO "tracks" VALUES('9201','9101','9001','Opening Song',1,215000,'/music/Fixture Artist/Fixture Album (Deluxe Edition) (2019)/01 - Opening Song.flac',1411,'plex','2026-10-20 21:38:28','2026-10-20 21:38:28');
INSERT INTO "tracks" VALUES('9202','9101','9001','Café Été',2,216000,'/music/Fixture Artist/Fixture Album (Deluxe Edition) (2019)/02 - Café Été.mp3',320,'plex','2026-10-20 21:38:28','2026-10-20 21:38:28');
CREATE TABLE watchlist_artists (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    spotify_artist_id TEXT UNIQUE NOT NULL,
                    artist_name TEXT NOT NULL,
                    date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_scan_timestamp TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                , image_url TEXT, include_albums INTEGER DEFAULT 1, include_eps INTEGER DEFAULT 1, include_singles INTEGER DEFAULT 1);
INSERT INTO "watchlist_artists" VALUES(401,'0OdUWJ0sBjDrqHygGUXeCF','Fixture Artist','2026-01-01 09:00:00','2026-01-03 08:00:00','2026-10-20 21:38:28','2026-10-20 21:38:28','https://i.scdn.co/image/fixture-artist',1,1,0);
CREATE TABLE wishlist_tracks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    spotify_track_id TEXT UNIQUE NOT NULL,
                    spotify_data TEXT NOT NULL,  -- JSON of full Spotify track data
                    failure_reason TEXT,
                    retry_count INTEGER DEFAULT 0,
                    last_attempted TIMESTAMP,
                    date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    source_type TEXT DEFAULT 'unknown',  -- 'playlist', 'album', 'manual'
                    source_info TEXT  -- JSON of source context (playlist name, album info, etc.)
                );
INSERT INTO "wishlist_tracks" VALUES(301,'3n3Ppam7vgaVa1iaRUc9Lp','{"id": "3n3Ppam7vgaVa1iaRUc9Lp", "name": "Opening Song", "artists": [{"id": "0OdUWJ0sBjDrqHygGUXeCF", "name": "Fixture Artist"}], "album": {"id": "2noRn2Aes5aoNVsU6iWThc", "name": "Fixture Album (Deluxe Edition)", "release_date": "2019-05-17", "album_type": "album", "images": [{"url": "https://i.scdn.co/image/fixture-cover", "height": 640, "width": 640}]}, "duration_ms": 215000, "track_number": 1, "disc_number": 1, "popularity": 42, "external_urls": {"spotify": "https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp"}}','No suitable Soulseek results',2,'2026-01-02 10:00:00','2026-01-01 09:00:00','playlist','{"playlist_name": "Fixture Mix", "playlist_id": "37i9dQZF1DXcBWIGoYBM5M"}');
CREATE INDEX idx_wishlist_spotify_id ON wishlist_tracks (spotify_track_id);
CREATE INDEX idx_watchlist_spotify_id ON watchlist_artists (spotify_artist_id);
CREATE INDEX idx_wishlist_date_added ON wishlist_tracks (date_added);
CREATE INDEX idx_albums_artist_id ON albums (artist_id);
CREATE INDEX idx_tracks_album_id ON tracks (album_id);
CREATE INDEX idx_tracks_artist_id ON tracks (artist_id);
CREATE INDEX idx_artists_server_source ON artists (server_source);
CREATE INDEX idx_albums_server_source ON albums (server_source);
CREATE INDEX idx_tracks_server_source ON tracks (server_source);
CREATE INDEX idx_artists_name ON artists (name);
CREATE INDEX idx_albums_title ON albums (title);
CREATE INDEX idx_tracks_title ON tracks (title);
CREATE INDEX idx_similar_artists_source ON similar_artists (source_artist_id);
CREATE INDEX idx_similar_artists_spotify ON similar_artists (similar_artist_spotify_id);
CREATE INDEX idx_similar_artists_occurrence ON similar_artists (occurrence_count);
CREATE INDEX idx_discovery_pool_spotify_track ON discovery_pool (spotify_track_id);
CREATE INDEX idx_discovery_pool_artist ON discovery_pool (spotify_artist_id);
CREATE INDEX idx_discovery_pool_added_date ON discovery_pool (added_date);
CREATE INDEX idx_discovery_pool_is_new ON discovery_pool (is_new_release);
CREATE INDEX idx_recent_releases_watchlist ON recent_releases (watchlist_artist_id);
CREATE INDEX idx_recent_releases_date ON recent_releases (release_date);
CREATE INDEX idx_discovery_recent_albums_date ON discovery_recent_albums (release_date);
CREATE INDEX idx_listenbrainz_playlists_type ON listenbrainz_playlists (playlist_type);
CREATE INDEX idx_listenbrainz_playlists_mbid ON listenbrainz_playlists (playlist_mbid);
CREATE INDEX idx_listenbrainz_tracks_playlist ON listenbrainz_tracks (playlist_id);
CREATE INDEX idx_listenbrainz_tracks_position ON listenbrainz_tracks (playlist_id, position);
CREATE INDEX idx_discovery_recent_albums_artist ON discovery_recent_albums (artist_spotify_id);
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('wishlist_tracks',301);
INSERT INTO "sqlite_sequence" VALUES('watchlist_artists',401);
INSERT INTO "sqlite_sequence" VALUES('similar_artists',451);
INSERT INTO "sqlite_sequence" VALUES('recent_releases',471);
INSERT INTO "sqlite_sequence" VALUES('discovery_pool',461);
INSERT INTO "sqlite_sequence" VALUES('listenbrainz_playlists',501);
INSERT INTO "sqlite_sequence" VALUES('listenbrainz_tracks',511);
COMMIT;
