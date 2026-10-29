// MEDIA PLAYER FUNCTIONALITY
// ===============================

// The chrome (the bar, the tray and the phone sheet: src/shell/player.ts)
// draws from state this file owns. npNotify tells it something changed;
// window.SoulSyncPlayer (bottom of this file) is how it reads and acts.
function npNotify(reason) {
    try {
        window.dispatchEvent(new CustomEvent('ss:player', { detail: { reason: reason || 'change' } }));
    } catch (e) { /* no chrome on this page */ }
}

function initializeMediaPlayer() {
    // Start in idle state (no track playing)
    const player = document.getElementById('media-player');
    if (player && !currentTrack) player.classList.add('idle');

    // Initialize HTML5 audio player
    audioPlayer = document.getElementById('audio-player');
    if (audioPlayer) {
        // Set up audio event listeners
        audioPlayer.addEventListener('timeupdate', updateAudioProgress);
        audioPlayer.addEventListener('timeupdate', npThrottledPositionState);
        audioPlayer.addEventListener('timeupdate', npMaybeLogPlay);
        audioPlayer.addEventListener('timeupdate', npMaybeMarkScrobbleEligible);
        // podcasts and audiobooks: where you got to, and their plays (HANDOFF 46)
        audioPlayer.addEventListener('timeupdate', npSpokenTick);
        audioPlayer.addEventListener('pause', npSpokenOnPause);
        audioPlayer.addEventListener('ended', onAudioEnded);
        audioPlayer.addEventListener('error', onAudioError);
        audioPlayer.addEventListener('loadstart', onAudioLoadStart);
        audioPlayer.addEventListener('canplay', onAudioCanPlay);
        // Universal: once the visualizer routes this element through
        // npAudioContext, the element is silent while that context is
        // suspended. The 'play' event fires on EVERY playback start (every
        // code path, incl. ones that bypass setPlayingState), so resume here.
        audioPlayer.addEventListener('play', npEnsureAudioContextRunning);

        // Set initial volume — restore the saved level (Spotify-style), else 70%.
        const _savedVol = npLoadSavedVolume();
        const _initialVol = _savedVol === null ? 70 : _savedVol;
        audioPlayer.volume = _initialVol / 100;
        npVolumePercent = _initialVol;
    }

    // Auto-download is off by default and profile-scoped. A user must enable it
    // from the queue header before SoulSync starts background acquisitions.
    try { npAutoDownloadQueue = localStorage.getItem(npAutoDownloadStorageKey()) === '1'; } catch (_) {}

    // Restore a previously-saved queue (does not auto-play)
    npRestoreQueue();
    npNotify('init');
}

function toggleMediaPlayerExpansion() {
    // No-op: controls are always visible in the new layout.
    // Kept for backward compatibility with any callers.
}

function extractTrackTitle(filename) {
    if (!filename) return null;

    // Strip the ``<source_id>||<display>`` prefix used by YouTube /
    // Tidal / Qobuz / torrent / usenet plugins to thread the source-
    // side identifier through ``filename`` without polluting the
    // display string. The id always comes first, the human title
    // after. If no separator is present, fall through with the raw
    // value so existing slskd / streaming-source paths are untouched.
    let title = filename;
    const sepIdx = title.indexOf('||');
    if (sepIdx >= 0) {
        title = title.slice(sepIdx + 2);
    }

    // Remove file extension
    title = title.replace(/\.[^/.]+$/, '');

    // Remove path components, keep only the filename
    title = title.split('/').pop().split('\\').pop();

    // Clean up common filename patterns
    title = title
        .replace(/^\d+\.?\s*/, '') // Remove track numbers at start
        .replace(/^\d+\s*-\s*/, '') // Remove "01 - " patterns
        .replace(/\s*-\s*\d{4}\s*$/, '') // Remove years at end
        .replace(/\s*\[\d+kbps\].*$/, '') // Remove bitrate info
        .replace(/\s*\(.*?\)\s*$/, '') // Remove parenthetical info at end
        .trim();

    return title || null;
}

function _stripSourceIdPrefix(value) {
    // Defensive cleanup for callers that pass a raw ``<source_id>||<display>``
    // string straight into setTrackInfo without first running
    // extractTrackTitle. The id always precedes the separator; the display
    // string follows. Strings with no separator pass through unchanged.
    if (!value || typeof value !== 'string') return value;
    const idx = value.indexOf('||');
    if (idx < 0) return value;
    return value.slice(idx + 2);
}

function setTrackInfo(track) {
    // an episode or a book being left keeps its place
    npSpokenLeave(track);
    currentTrack = track;
    window.__ssCurrentTrack = track;
    if (typeof window.getCurrentTrack !== 'function') {
        window.getCurrentTrack = function () { return currentTrack; };
    }
    npPlayLogged = false;   // new track — allow one play-log once it's heard a bit
    npPlayId = null;   // listening_history id for this play (for the scrobble-eligibility ping)
    npScrobbleEligibleSent = false;
    npPlayGeneration++;   // invalidate any in-flight log-play response for the previous track
    // Chat now-playing (opt-in, chat.js owns the gate + throttle). Never let a
    // chat problem break playback.
    try {
        if (typeof window.__ssNowPlaying === 'function') window.__ssNowPlaying(track);
    } catch (e) { /* chat not loaded / not in a room */ }

    // the chrome draws the title, the art and the links (src/shell/player.ts)
    const player = document.getElementById('media-player');
    if (player) player.classList.remove('idle');

    // Sync expanded player and media session
    updateNpTrackInfo();
    updateMediaSessionMetadata();
    updateMediaSessionPlaybackState();
    // Reset the lock-screen scrubber when duration becomes known for the new track.
    if (audioPlayer) audioPlayer.addEventListener('loadedmetadata', updateMediaSessionPositionState, { once: true });

    // Kick off lyrics fetch for the new track. The panel stays
    // collapsed by default — fetching in the background means the
    // user gets instant lyrics the first time they expand it. An episode
    // or an audiobook has none to find.
    if (!npIsSpokenWord(track) && npTrackKind(track) !== 'radio') {
        _npLyricsLoadForTrack({
            title: track.title,
            artist: track.artist,
            album: track.album,
            is_library: track.is_library,
            filename: track.filename,
        });
    } else {
        _npLyricsState.trackKey = null;
        _npLyricsResetUI();
    }
    npNotify('track');
}

// What kind of thing is playing: a library track, a stream (a Soulseek file,
// a preview), a podcast episode, an audiobook, or (build e) internet radio.
// The chrome picks its controls from this.
function npTrackKind(track) {
    if (!track) return null;
    if (track.kind) return track.kind;
    return track.is_library ? 'library' : 'stream';
}

function npIsSpokenWord(track) {
    const kind = npTrackKind(track);
    return kind === 'podcast' || kind === 'audiobook';
}

// a deezer clip (#1312) is 30 seconds of the song, not the song. the mini
// player says so here and now playing in its format badges, so a clip
// ending early never reads as a broken stream.
function npSetPreviewBadge(on) {
    // the chrome says "30-second preview" from currentTrack.is_preview
    npNotify('track');
}

function clearTrack() {
    if (typeof npAutomixStop === 'function') npAutomixStop();
    // Clear track state
    currentTrack = null;
    window.__ssCurrentTrack = null;
    isPlaying = false;
    try {
        if (typeof window.__ssNowPlaying === 'function') window.__ssNowPlaying(null);
    } catch (e) { /* chat not loaded */ }
    npSetPlayContext('');   // hide "Playing from" when nothing's playing

    // Hide loading animation
    hideLoadingAnimation();

    // nothing playing: the player goes away (the chrome hides with .idle)
    const player = document.getElementById('media-player');
    if (player) player.classList.add('idle');

    // Reset queue state
    npQueue = [];
    npQueueIndex = -1;

    // Sync expanded player and media session
    updateNpTrackInfo();
    updateNpPlayButton();
    updateNpProgress();
    renderNpQueue();
    updateNpPrevNextButtons();
    updateMediaSessionPlaybackState();
    stopSidebarVisualizer();
    npNotify('clear');

    console.log('🧹 Track cleared and media player reset');
}

function setPlayingState(playing) {
    isPlaying = playing;
    updateNpPlayButton();
    updateMediaSessionPlaybackState();

    // Sidebar audio visualizer
    if (playing) {
        npInitVisualizer();
        startSidebarVisualizer();
    } else {
        stopSidebarVisualizer();
    }
    npNotify('playing');
}

async function handlePlayPause() {
    // Use new streaming system toggle function
    togglePlayback();
}

async function handleStop() {
    // Tear down any in-flight crossfade so its second audio doesn't keep playing.
    npCancelCrossfade();
    // Use new streaming system stop function
    await stopStream();
    clearTrack();
}

// Volume, 0..100, the one place it changes. Unmutes unless told otherwise.
let npVolumePercent = 70;
function npSetVolume(percent, options = {}) {
    const v = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    npVolumePercent = v;
    if (audioPlayer) audioPlayer.volume = v / 100;
    npPersistVolume(v);
    if (!options.keepMute) npMuted = v === 0;
    npNotify('volume');
}

function handleVolumeChange(event) {
    npSetVolume(event && event.target ? event.target.value : npVolumePercent);
}

// Seek to a time in seconds (clamped to the track).
function npSeek(seconds) {
    if (!audioPlayer || !audioPlayer.duration || !isFinite(audioPlayer.duration)) return;
    const t = Math.max(0, Math.min(audioPlayer.duration, Number(seconds) || 0));
    try {
        audioPlayer.currentTime = t;
        updateMediaSessionPositionState();
    } catch (error) {
        console.warn('⚠️ Seek failed:', error.message);
    }
}

function handleProgressBarChange(event) {
    if (!audioPlayer || !audioPlayer.duration) return;
    const progress = parseFloat(event.target.value);
    npSeek((progress / 100) * audioPlayer.duration);
}

function updateVolumeSliderAppearance() {
    npNotify('volume');
}

// The loading state lives in #loading-animation (its .hidden class, the
// .loading-progress width and the .loading-text words): this file and the
// library player (src/shell/library-globals.ts) write it, the chrome reads it.
function showLoadingAnimation() {
    const el = document.getElementById('loading-animation');
    if (el) el.classList.remove('hidden');
    npNotify('loading');
}

function hideLoadingAnimation() {
    const el = document.getElementById('loading-animation');
    if (el) el.classList.add('hidden');
    npNotify('loading');
}

function setLoadingProgress(percentage) {
    const loadingAnimation = document.getElementById('loading-animation');
    if (!loadingAnimation) return;
    const progressBar = loadingAnimation.querySelector('.loading-progress');
    const loadingText = loadingAnimation.querySelector('.loading-text');

    loadingAnimation.classList.remove('hidden');
    if (progressBar) progressBar.style.width = `${percentage}%`;
    if (loadingText) loadingText.textContent = `${Math.round(percentage)}%`;
    npNotify('loading');
}

// ===============================
// STREAMING FUNCTIONALITY
// ===============================

let _streamLock = false;

async function startStream(searchResult) {
    if (typeof npAutomixStop === 'function') npAutomixStop();
    // Start streaming a track - handles same track toggle and new track streaming
    try {
        // Prevent multiple concurrent stream starts (rapid clicking)
        if (_streamLock) {
            console.log('⏳ Stream already starting, ignoring duplicate click');
            return;
        }

        console.log(`🎮 startStream() called with data:`, searchResult);

        // Check if this is the same track that's currently playing/loading
        const currentTrackId = currentTrack ? `${currentTrack.username}:${currentTrack.filename}` : null;
        const newTrackId = `${searchResult.username}:${searchResult.filename}`;

        console.log(`🎮 startStream() called for: ${searchResult.filename}`);
        console.log(`🎮 Current track ID: ${currentTrackId}`);
        console.log(`🎮 New track ID: ${newTrackId}`);

        if (currentTrackId === newTrackId && audioPlayer && !audioPlayer.paused) {
            // Same track clicked while playing - toggle pause
            console.log("🔄 Toggling playback for same track");
            togglePlayback();
            return;
        }

        // Same track clicked while PAUSED with audio still loaded — resume
        // instead of tearing the stream down and re-downloading it. readyState
        // guards the case where the stream never actually became playable, and
        // !ended keeps a click after natural completion on the restart path
        // (resuming at the very end would just instantly re-fire 'ended').
        if (currentTrackId === newTrackId && audioPlayer && audioPlayer.paused
                && !audioPlayer.ended && audioPlayer.src && audioPlayer.readyState >= 2) {
            console.log("▶️ Resuming paused stream for same track");
            togglePlayback();
            return;
        }

        // Lock to prevent duplicate stream starts
        _streamLock = true;

        // Different track or no current track - start new stream
        console.log("🎵 Starting new stream");

        // Stop current streaming/playback if any
        await stopStream();

        // Set track info and show loading state
        setTrackInfo({
            title: extractTrackTitle(searchResult.filename) || searchResult.title || 'Unknown Track',
            artist: searchResult.artist || searchResult.username || 'Unknown Artist',
            album: searchResult.album || 'Unknown Album',
            username: searchResult.username,
            filename: searchResult.filename,
            image_url: searchResult.image_url || searchResult.album_cover_url || null,
            is_preview: !!searchResult.preview
        });

        showLoadingAnimation();
        setLoadingProgress(0);

        // Start streaming request
        const response = await fetch(API.stream.start, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(searchResult)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        if (!data.success) {
            throw new Error(data.error || 'Failed to start streaming');
        }

        console.log("✅ Stream started successfully");

        // Start status polling
        startStreamStatusPolling();

    } catch (error) {
        console.error('Error starting stream:', error);
        showToast(`Failed to start stream: ${error.message}`, 'error');
        hideLoadingAnimation();
        clearTrack();
    } finally {
        _streamLock = false;
    }
}

function startStreamStatusPolling() {
    // Start polling for stream status updates with retry logic
    if (streamStatusPoller) {
        clearInterval(streamStatusPoller);
    }

    // Reset polling state
    streamPollingRetries = 0;
    streamPollingInterval = 1000; // Reset to 1-second interval

    console.log('🔄 Starting enhanced stream status polling');
    updateStreamStatus(); // Initial check
    streamStatusPoller = setInterval(updateStreamStatus, streamPollingInterval);
}

function stopStreamStatusPolling() {
    // Stop polling for stream status updates
    if (streamStatusPoller) {
        clearInterval(streamStatusPoller);
        streamStatusPoller = null;
        streamPollingRetries = 0;
        streamPollingInterval = 1000; // Reset interval
        console.log('⏹️ Stopped stream status polling');
    }
}

// Phase 4: Track last known tool statuses to prevent repeated toasts on terminal states
let _lastToolStatus = {};

// Phase 5: Sync/Discovery/Scan WebSocket router functions
function updateSyncProgressFromData(data) {
    const pid = data.playlist_id;
    const callback = _syncProgressCallbacks[pid];
    if (callback) callback(data);
}

function updateDiscoveryProgressFromData(data) {
    const id = data.id;
    const callback = _discoveryProgressCallbacks[id];
    if (callback) callback(data);
}

function updateMediaScanFromData(data) {
    // Re-broadcast the frame verbatim, before this function's own guards — the
    // bridge is a pure transport hop, and the React card applies the same checks
    // itself. Kept here rather than in core.js so it travels with the handler.
    window.dispatchEvent(new CustomEvent('ss:media-scan', { detail: data }));

    if (!data.success || !data.status) return;
    const status = data.status;
    // `is_scanning` is a phantom field. Both this socket frame and
    // /api/scan/status return web_scan_manager.get_scan_status(), which reports
    // status: 'idle' | 'scheduled' | 'scanning' and has NEVER carried
    // is_scanning.
    const statusKey = status.status || 'unknown';
    const wasScanning = _lastMediaScanStatus === 'scanning';
    if (_lastMediaScanStatus === statusKey && statusKey !== 'scanning') return;
    _lastMediaScanStatus = statusKey;

    // P7 hardening: every element this handler used to write (#media-scan-*,
    // #media-scan-button) exists only inside the React tools page now, and the
    // card renders this same frame itself via ss:media-scan — a second writer
    // here would be mutating React-owned DOM. What survives app-wide is the
    // completion toast:
    if (statusKey !== 'idle') return;
    // A bare idle frame is not a finished scan — the server pushes scan:media
    // every 2s regardless of activity, and without this guard every page load
    // announced a completed scan.
    if (!wasScanning) return;
    // On the tools page the React card announces it; everywhere else this is
    // the only messenger.
    if (typeof currentPage !== 'undefined' && currentPage === 'tools') return;
    showToast('✅ Media scan completed', 'success', 3000);
}

let _wishlistAutoProcessingNotified = false;
function updateWishlistStatsFromData(data) {
    // Auto-processing detection: close modal and notify (once only)
    if (data.is_auto_processing) {
        if (!_wishlistAutoProcessingNotified) {
            if (currentPage === 'wishlist') navigateToPage('active-downloads');
            showToast('Wishlist auto-processing started. View progress in Download Manager.', 'info');
            _wishlistAutoProcessingNotified = true;
        }
        return;
    }
    // Reset flag when auto-processing ends
    _wishlistAutoProcessingNotified = false;
    // Store latest stats for countdown timer refresh
    _lastWishlistStats = data;
}

async function updateStreamStatus() {
    // Always poll over HTTP: stream state is per-listener (resolved from the
    // session cookie), and the old global 'tool:stream' socket broadcast could
    // only see the DEFAULT session — it told every real browser "stopped"
    // forever while this poller deferred to it. The poller only runs while a
    // stream is being prepared, so the 1s fetch is negligible.
    // Poll server for streaming progress and handle state changes with enhanced error recovery
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10-second timeout

        const response = await fetch(API.stream.status, {
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        // Reset retry count on successful response
        streamPollingRetries = 0;
        streamPollingInterval = 1000; // Reset to normal interval

        // Update current stream state
        currentStream.status = data.status;
        currentStream.progress = data.progress;

        switch (data.status) {
            case 'loading':
                setLoadingProgress(data.progress);
                // Update loading text with progress
                const loadingText = document.querySelector('.loading-text');
                if (loadingText && data.progress > 0) {
                    loadingText.textContent = `Downloading... ${Math.round(data.progress)}%`;
                }
                break;

            case 'queued':
                // Show queue status with better messaging
                const queueText = document.querySelector('.loading-text');
                if (queueText) {
                    queueText.textContent = 'Queuing with uploader...';
                }
                setLoadingProgress(0); // Reset progress for queue state
                break;

            case 'ready':
                // Stream is ready - start audio playback
                console.log('🎵 Stream ready, starting audio playback');
                stopStreamStatusPolling();
                // Restore player UI if JS state was wiped (e.g. page refresh)
                if (!currentTrack && data.track_info) {
                    const ti = data.track_info;
                    setTrackInfo({
                        title: ti.name || ti.title || 'Unknown Track',
                        artist: ti.artist || 'Unknown Artist',
                        album: ti.album || 'Unknown Album',
                        filename: ti.filename || '',
                        is_library: !!ti.is_library,
                        is_preview: !!ti.is_preview,
                        image_url: ti.image_url || null,
                        id: ti.id || null,
                        artist_id: ti.artist_id || null,
                        album_id: ti.album_id || null,
                    });
                }
                await startAudioPlayback();
                break;

            case 'error':
                console.error('❌ Streaming error:', data.error_message);
                stopStreamStatusPolling();
                hideLoadingAnimation();
                showToast(`Streaming error: ${data.error_message || 'Unknown error'}`, 'error');
                clearTrack();
                break;

            case 'stopped':
                // Handle stopped state — do NOT clear track here; explicit stop (handleStop)
                // calls clearTrack() directly. Clearing here collapses the player mid-playback
                // when the backend transitions to 'stopped' after audio naturally ends or during
                // queue track transitions.
                console.log('🛑 Stream stopped');
                stopStreamStatusPolling();
                hideLoadingAnimation();
                break;
        }

    } catch (error) {
        streamPollingRetries++;
        console.warn(`Stream status polling error (attempt ${streamPollingRetries}):`, error.message);

        if (streamPollingRetries >= maxStreamPollingRetries) {
            // Too many consecutive failures - give up
            console.error('❌ Stream status polling failed after maximum retries');
            stopStreamStatusPolling();
            hideLoadingAnimation();
            showToast('Lost connection to streaming server', 'error');
            clearTrack();
        } else {
            // Implement exponential backoff for retries
            const backoffMultiplier = Math.min(streamPollingRetries, 5); // Max 5x backoff
            streamPollingInterval = 1000 * backoffMultiplier;

            // Restart polling with new interval
            if (streamStatusPoller) {
                clearInterval(streamStatusPoller);
                streamStatusPoller = setInterval(updateStreamStatus, streamPollingInterval);
                console.log(`🔄 Retrying stream status polling with ${streamPollingInterval}ms interval`);
            }
        }
    }
}

// (updateStreamStatusFromData removed: it consumed the global 'tool:stream'
// socket broadcast, which could only carry the DEFAULT session's state — every
// real browser has its own per-listener stream session, so the broadcast told
// everyone "stopped" forever. Stream status is driven by the per-session HTTP
// poller (updateStreamStatus) exclusively.)

async function startAudioPlayback(isCurrent = () => true, signal, handoff = null, sourceUrl = null, opts = {}) {
    if (typeof npAutomixStop === 'function') npAutomixStop();
    // Start HTML5 audio playback of the streamed file with enhanced state management
    // `handoff` is the crossfade's second audio, still playing the track this
    // player is about to load; the player joins it where it is, then it stops.
    try {
        if (!audioPlayer) {
            throw new Error('Audio player not initialized');
        }

        // Show loading state while preparing audio
        const loadingText = document.querySelector('.loading-text');
        if (loadingText) {
            loadingText.textContent = 'Preparing playback...';
        }

        // Set audio source with cache-busting timestamp. A podcast episode or
        // an audiobook sample plays from its own address (sourceUrl).
        const audioUrl = sourceUrl || `/stream/audio?t=${new Date().getTime()}`;
        console.log(`🎵 Loading audio from: ${audioUrl}`);

        // Clear any existing source first
        audioPlayer.pause();
        audioPlayer.currentTime = 0;
        audioPlayer.src = '';

        // Only a direct radio stream asks for CORS (npPlayRadio); everything
        // else loads as it always has, so undo it only if radio left it set
        if (!opts.cors && audioPlayer.crossOrigin) audioPlayer.crossOrigin = null;
        // Set new source
        audioPlayer.src = audioUrl;
        audioPlayer.load(); // Force reload

        // Wait for audio to be ready with promise-based approach
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error('Audio loading timeout'));
            }, 15000); // 15-second timeout

            const cleanup = () => {
                clearTimeout(timeout);
                audioPlayer.removeEventListener('canplay', onCanPlay);
                audioPlayer.removeEventListener('error', onError);
                signal?.removeEventListener('abort', onAbort);
            };
            const onAbort = () => { cleanup(); reject(new Error('Playback superseded')); };
            const onCanPlay = () => {
                cleanup();
                clearTimeout(timeout);
                audioPlayer.removeEventListener('canplay', onCanPlay);
                audioPlayer.removeEventListener('error', onError);
                resolve();
            };

            const onError = (event) => {
                cleanup();
                clearTimeout(timeout);
                audioPlayer.removeEventListener('canplay', onCanPlay);
                audioPlayer.removeEventListener('error', onError);
                const error = event.target.error || new Error('Audio loading failed');
                reject(error);
            };

            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted || !isCurrent()) { onAbort(); return; }
            audioPlayer.addEventListener('canplay', onCanPlay);
            audioPlayer.addEventListener('error', onError);

            // If already ready, resolve immediately
            if (audioPlayer.readyState >= 3) { // HAVE_FUTURE_DATA
                onCanPlay();
            }
        });

        console.log('✅ Audio loaded and ready for playback');

        // Try to start playback with retry logic
        let retryCount = 0;
        const maxRetries = 3;

        while (retryCount < maxRetries) {
            try {
                if (!isCurrent()) return { status: 'superseded' };
                if (handoff && npXfadeHandoff === handoff) {
                    // Read the position as late as possible: the second audio
                    // has kept moving through the whole load. The lead covers
                    // the seek + start latency so the join lands level.
                    const at = handoff.currentTime + 0.15;
                    if (isFinite(at) && at > 0) { try { audioPlayer.currentTime = at; } catch (_) {} }
                } else if (opts.startAt > 0 && retryCount === 0) {
                    // an episode or a book picks up where this profile left it
                    try { audioPlayer.currentTime = opts.startAt; } catch (_) {}
                }
                await audioPlayer.play();
                if (!isCurrent()) return { status: 'superseded' };
                if (handoff) npStopHandoff(handoff);
                console.log('✅ Audio playback started successfully');

                // Update UI to playing state
                hideLoadingAnimation();
                setPlayingState(true);

                // The player's volume (a crossfade may have left the element low)
                if (typeof npVolumePercent !== 'undefined') {
                    audioPlayer.volume = (typeof npMuted !== 'undefined' && npMuted) ? 0 : npVolumePercent / 100;
                }
                // ...or back to it over 3 s, after one that matched loudness
                if (opts.settleFrom > 0 && opts.settleFrom < 1) npSettleVolume(opts.settleFrom);

                return { status: 'played' }; // HTMLMediaElement.play acknowledged playback.

            } catch (playError) {
                retryCount++;
                console.warn(`⚠️ Audio play attempt ${retryCount} failed:`, playError.message);

                if (retryCount >= maxRetries) {
                    throw playError; // Re-throw after max retries
                }

                // Wait before retry with exponential backoff
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
            }
        }

    } catch (error) {
        if (!isCurrent()) return { status: 'superseded' };
        console.error('❌ Error starting audio playback:', error);
        hideLoadingAnimation();

        // Provide user-friendly error messages
        let userMessage = 'Playback failed';

        if (error.message.includes('no supported source') ||
            error.message.includes('Not supported') ||
            error.message.includes('MEDIA_ELEMENT_ERROR')) {
            userMessage = 'Audio format not supported by your browser. Try downloading instead.';
        } else if (error.message.includes('network') || error.message.includes('fetch')) {
            userMessage = 'Network error - please check your connection';
        } else if (error.message.includes('decode')) {
            userMessage = 'Audio file is corrupted or incompatible';
        } else if (error.message.includes('timeout')) {
            userMessage = 'Audio loading timeout - file may be too large';
        } else if (error.message.includes('AbortError')) {
            userMessage = 'Playback was interrupted';
        }

        // a radio station tried directly first falls back to the server's
        // relay (src/shell/radio-session.ts), so that first failure is quiet
        if (opts.quiet) return { status: 'failed', error: userMessage };
        showToast(userMessage, 'error');
        // Only clear track if not in queue playback mode — queue handles its own error recovery
        if (npQueue.length === 0) {
            clearTrack();
        }
        return { status: 'failed', error: userMessage };
    }
}

async function stopStream() {
    if (typeof npAutomixStop === 'function') npAutomixStop();
    // Stop streaming and clean up all state
    try {
        // Stop status polling
        stopStreamStatusPolling();

        // Stop audio playback
        if (audioPlayer) {
            audioPlayer.pause();
            audioPlayer.src = '';
        }

        // Call backend stop endpoint
        const response = await fetch(API.stream.stop, { method: 'POST' });
        if (response.ok) {
            const data = await response.json();
            console.log('🛑 Stream stopped:', data.message);
        }

        // Reset UI state
        hideLoadingAnimation();
        setPlayingState(false);

        // Reset stream state
        currentStream = {
            status: 'stopped',
            progress: 0,
            track: null
        };

    } catch (error) {
        console.error('Error stopping stream:', error);
    }
}

function togglePlayback() {
    // Toggle play/pause for currently loaded audio
    if (!audioPlayer || !currentTrack) {
        console.log('⚠️ No audio player or track to toggle');
        return;
    }

    if (audioPlayer.paused) {
        audioPlayer.play()
            .then(() => {
                setPlayingState(true);
                console.log('▶️ Resumed playback');
            })
            .catch(error => {
                console.error('Error resuming playback:', error);
                showToast('Failed to resume playback', 'error');
            });
    } else {
        audioPlayer.pause();
        setPlayingState(false);
        console.log('⏸️ Paused playback');
    }
}

// ===============================
// AUDIO EVENT HANDLERS
// ===============================

// Whether playback is past the 3s "prev restarts the track" threshold — the
// prev button's enabled state depends on it, but buttons only refresh on
// track/queue changes, so on queue item 0 prev sat disabled for the whole
// song. Refresh the buttons exactly when this boolean flips.
let _npPastRestartThreshold = false;

function updateAudioProgress() {
    // Keep Previous honest and the lyrics highlight moving
    if (!audioPlayer || !audioPlayer.duration) return;

    const pastRestart = audioPlayer.currentTime > 3;
    if (pastRestart !== _npPastRestartThreshold) {
        _npPastRestartThreshold = pastRestart;
        updateNpPrevNextButtons();
    }

    // the chrome follows the time itself (timeupdate on the element)

    // Sync lyrics highlight when synced LRC is loaded.
    if (_npLyricsState.synced && _npLyricsState.lines.length) {
        _npLyricsHighlight(audioPlayer.currentTime);
    }
}

// ─────────────────────────────────────────────────────────────────
// Lyrics panel (now-playing modal)
// ─────────────────────────────────────────────────────────────────

// Module-level state for the currently-loaded lyrics. Reset on each
// track change. ``lines`` is an array of {time, text} for synced
// lyrics or null for plain text. ``activeIndex`` tracks the last
// highlighted line to avoid re-rendering on every timeupdate tick.
const _npLyricsState = {
    trackKey: null,
    lines: [],
    synced: false,
    activeIndex: -1,
    fetchInFlight: false,
    autoOpen: false,
};

function _npLyricsResetUI() {
    const content = document.getElementById('np-lyrics-content');
    const status = document.getElementById('np-lyrics-status');
    if (content) content.innerHTML = '<div class="np-lyrics-empty">No lyrics loaded</div>';
    if (status) status.textContent = '';
}

function _npLyricsParseLrc(synced) {
    // Parse a standard LRC string. Lines without a timestamp are
    // dropped (metadata tags like ``[ti:Title]`` aren't lyrics). The
    // same line can carry multiple timestamps — emit one entry per
    // timestamp so seeks land correctly when a chorus repeats.
    const out = [];
    if (!synced) return out;
    const re = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
    synced.split(/\r?\n/).forEach(raw => {
        const stamps = [];
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(raw)) !== null) {
            const minutes = parseInt(m[1], 10);
            const seconds = parseFloat(m[2]);
            if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) continue;
            stamps.push(minutes * 60 + seconds);
        }
        if (!stamps.length) return;
        const text = raw.replace(re, '').trim();
        stamps.forEach(t => out.push({ time: t, text }));
    });
    out.sort((a, b) => a.time - b.time);
    return out;
}

function _npLyricsRenderSynced(lines) {
    const content = document.getElementById('np-lyrics-content');
    if (!content) return;
    if (!lines.length) {
        content.innerHTML = '<div class="np-lyrics-empty">No timestamped lyrics for this track</div>';
        return;
    }
    content.innerHTML = lines.map((line, idx) => {
        const safe = (line.text || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) || '&nbsp;';
        return `<div class="np-lyrics-line" data-idx="${idx}" title="Jump to this line">${safe}</div>`;
    }).join('');

    // Click a line → seek playback to its timestamp (synced lyrics only).
    content.querySelectorAll('.np-lyrics-line').forEach(el => {
        el.addEventListener('click', () => {
            const idx = Number(el.dataset.idx);
            const line = _npLyricsState.lines[idx];
            if (!line || !audioPlayer || !isFinite(line.time)) return;
            try {
                audioPlayer.currentTime = line.time;
                if (audioPlayer.paused) audioPlayer.play().catch(() => {});
            } catch (_) {}
        });
    });
}

function _npLyricsRenderPlain(text) {
    const content = document.getElementById('np-lyrics-content');
    if (!content) return;
    const safe = (text || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    content.innerHTML = `<div class="np-lyrics-plain">${safe.replace(/\n/g, '<br>')}</div>`;
}

function _npLyricsHighlight(currentTime) {
    const { lines } = _npLyricsState;
    if (!lines.length) return;
    let idx = -1;
    // Binary-search style linear scan — N is small (200 lines max).
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].time <= currentTime) idx = i;
        else break;
    }
    if (idx === _npLyricsState.activeIndex) return;
    _npLyricsState.activeIndex = idx;
    const content = document.getElementById('np-lyrics-content');
    if (!content) return;
    content.querySelectorAll('.np-lyrics-line').forEach((el, i) => {
        el.classList.remove('active', 'passed', 'upcoming');
        if (i === idx) el.classList.add('active');
        else if (i < idx) el.classList.add('passed');
        else el.classList.add('upcoming');
    });
    const activeEl = content.querySelector('.np-lyrics-line.active');
    if (activeEl) {
        // Smooth-scroll the active line into the middle of the lyrics body.
        const body = document.getElementById('np-lyrics-body');
        if (body) {
            const bodyRect = body.getBoundingClientRect();
            const lineRect = activeEl.getBoundingClientRect();
            const targetTop = (lineRect.top - bodyRect.top) - (bodyRect.height / 2) + (lineRect.height / 2);
            body.scrollTo({ top: body.scrollTop + targetTop, behavior: 'smooth' });
        }
    }
}

function _npLyricsTrackKey(track) {
    if (!track) return null;
    return `${track.title || ''}|${track.artist || ''}|${track.album || ''}`;
}

async function _npLyricsLoadForTrack(track) {
    const key = _npLyricsTrackKey(track);
    if (!key) return;
    if (_npLyricsState.trackKey === key) return;     // already loaded
    if (_npLyricsState.fetchInFlight) return;
    _npLyricsState.trackKey = key;
    _npLyricsState.lines = [];
    _npLyricsState.synced = false;
    _npLyricsState.activeIndex = -1;
    _npLyricsResetUI();
    const status = document.getElementById('np-lyrics-status');
    if (status) status.textContent = 'Fetching…';
    _npLyricsState.fetchInFlight = true;
    try {
        const resp = await fetch('/api/lyrics/fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: _stripSourceIdPrefix(track.title) || '',
                artist: _stripSourceIdPrefix(track.artist) || '',
                album: _stripSourceIdPrefix(track.album) || '',
                duration: Math.round(audioPlayer?.duration || 0),
                file_path: track.is_library ? track.filename : null,
            }),
        });
        const data = await resp.json();
        if (_npLyricsState.trackKey !== key) return;    // track changed mid-fetch
        if (data && data.success) {
            if (data.synced) {
                const parsed = _npLyricsParseLrc(data.synced);
                if (parsed.length) {
                    _npLyricsState.synced = true;
                    _npLyricsState.lines = parsed;
                    _npLyricsRenderSynced(parsed);
                    if (status) status.textContent = 'Synced';
                    return;
                }
            }
            if (data.plain) {
                _npLyricsState.synced = false;
                _npLyricsState.lines = [];
                _npLyricsRenderPlain(data.plain);
                if (status) status.textContent = 'Plain';
                return;
            }
        }
        const content = document.getElementById('np-lyrics-content');
        if (content) content.innerHTML = '<div class="np-lyrics-empty">No lyrics found</div>';
        if (status) status.textContent = '';
    } catch (e) {
        console.debug('lyrics fetch failed:', e);
        const content = document.getElementById('np-lyrics-content');
        if (content) content.innerHTML = '<div class="np-lyrics-empty">Lyrics unavailable</div>';
        if (status) status.textContent = '';
    } finally {
        _npLyricsState.fetchInFlight = false;
        npNotify('lyrics');
    }
}

function _npLyricsTogglePanel(forceOpen = null) {
    const panel = document.getElementById('np-lyrics-panel');
    const body = document.getElementById('np-lyrics-body');
    const toggle = document.getElementById('np-lyrics-toggle');
    if (!panel || !body || !toggle) return;
    const willOpen = forceOpen === null ? body.classList.contains('hidden') : forceOpen;
    if (willOpen) {
        body.classList.remove('hidden');
        panel.classList.remove('collapsed');
        toggle.setAttribute('aria-expanded', 'true');
    } else {
        body.classList.add('hidden');
        panel.classList.add('collapsed');
        toggle.setAttribute('aria-expanded', 'false');
    }
}

function _npLyricsInit() {
    const toggle = document.getElementById('np-lyrics-toggle');
    if (toggle && !toggle._lyricsBound) {
        toggle.addEventListener('click', () => _npLyricsTogglePanel());
        toggle._lyricsBound = true;
    }
}

// The playing track ended and its advance went to auto-mix, or was turned
// away by a load in flight: the next track is owed, and auto-mix starts it if
// nothing else does (its last line of defence for the queue; Ross's report
// of 28 October). Never set by a stop meant at the end: the sleep timer, a
// radio's end, the queue's end. Cleared by the next load.
let npAdvanceOwed = false;

function onAudioEnded() {
    npAdvanceOwed = false;
    // Auto-mix (DJ mix) owns the advance while its decks play the mix: this
    // element was only keeping time under them, muted (src/features/automix),
    // so its end is no one's business, and the player is still playing
    if (npAutomixOwnsAdvance()) { npAdvanceOwed = true; return; }
    // Handle audio playback completion
    console.log('🏁 Audio playback ended');
    setPlayingState(false);
    npSpokenOnEnded();

    // Sleep timer "end of track": pause instead of advancing to the next track.
    if (npSleepEndOfTrack) { npFireSleepTimer(); return; }

    // A radio station has no end: when its stream does, say so (the radio
    // session decides what to do) and leave the queue alone.
    if (currentTrack && currentTrack.kind === 'radio') {
        window.dispatchEvent(new CustomEvent('ss:radio-stream-ended', { detail: { radio: currentTrack.radio || null } }));
        return;
    }

    // A second audio mid-flight would own the advance (there's no crossfade
    // any more, so this stays false; kept as the guard it was).
    if (npXfadeActive) return;

    // Repeat-one is handled by audioPlayer.loop (set in handleNpRepeat)
    // Auto-advance to next track if queue has a next item (guard against race conditions)
    if (npQueue.length > 0 && !npLoadingQueueItem) {
        const hasNext = npShuffleOn
            ? npQueue.length > 1
            : (npQueueIndex < npQueue.length - 1 || npRepeatMode === 'all');
        if (hasNext) { playNextInQueue(); return; }
    } else if (npQueue.length > 0 && npQueueIndex < npQueue.length - 1) {
        // a load in flight turned the advance away
        npAdvanceOwed = true;
    }

    // Radio mode: auto-fetch similar tracks when queue is exhausted
    if (npRadioMode && currentTrack && currentTrack.id && !npLoadingQueueItem) {
        npFetchRadioTracks();
    }
}

function onAudioError(event) {
    // Handle audio playback errors
    const error = event.target.error;
    console.error('❌ Audio error:', error);

    // Don't show error toast if it's just a format/codec issue and retrying
    if (error && error.code) {
        console.error(`Audio error code: ${error.code}, message: ${error.message || 'Unknown error'}`);

        // Only show user-facing errors for serious issues
        if (error.code === 4) { // MEDIA_ELEMENT_ERROR: Media not supported
            console.warn('⚠️ Media format not supported by browser, but streaming may still work');
            // Don't clear track or show error - let retry logic handle it
            return;
        }
    }

    hideLoadingAnimation();

    // Only clear track after a short delay to allow for recovery
    setTimeout(() => {
        if (audioPlayer && audioPlayer.error) {
            let userMessage = 'Audio format not supported by your browser. Try downloading instead.';

            if (error && error.code) {
                switch (error.code) {
                    case 1: // MEDIA_ERR_ABORTED
                        userMessage = 'Playback was stopped';
                        break;
                    case 2: // MEDIA_ERR_NETWORK
                        userMessage = 'Network error - please try again';
                        break;
                    case 3: // MEDIA_ERR_DECODE
                        userMessage = 'Audio file is corrupted or incompatible';
                        break;
                    case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
                        userMessage = 'Audio format not supported by your browser. Try downloading instead.';
                        break;
                }
            }

            showToast(userMessage, 'error');
            // Only clear track if not in queue playback — queue handles its own recovery
            if (npQueue.length === 0) {
                clearTrack();
            }
        }
    }, 2000);
}

function onAudioLoadStart() {
    npAdvanceOwed = false;
    // Handle audio load start
    console.log('🔄 Audio loading started');
}

function onAudioCanPlay() {
    // Handle when audio can start playing
    console.log('✅ Audio ready to play');
}

function formatTime(seconds) {
    // Format seconds as MM:SS
    if (!seconds || !isFinite(seconds)) return '0:00';

    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function formatCountdownTime(seconds) {
    // Format seconds as countdown timer (e.g., "24m 13s", "2h 15m", "23h 59m")
    if (seconds === null || seconds === undefined || seconds < 0) return '';
    if (seconds === 0) return '0s';  // Show "0s" instead of hiding timer

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
        return `${minutes}m ${secs}s`;
    } else {
        return `${secs}s`;
    }
}

// ===============================
// AUDIO FORMAT SUPPORT DETECTION
// ===============================

function getFileExtension(filename) {
    if (!filename) return '';
    const ext = filename.toLowerCase().match(/\.([^.]+)$/);
    return ext ? ext[1] : '';
}

function isAudioFormatSupported(filename) {
    const ext = getFileExtension(filename);
    const supportedFormats = ['mp3', 'ogg', 'wav'];  // Most reliable formats
    const partialSupport = ['flac', 'aac', 'm4a', 'opus', 'webm'];  // Test browser support
    const unsupported = ['wma', 'ape', 'aiff'];  // Generally problematic

    if (supportedFormats.includes(ext)) {
        return true;
    }

    if (partialSupport.includes(ext)) {
        // Test if browser can actually play this format
        return canPlayAudioFormat(ext);
    }

    return false;  // Unsupported formats
}

function canPlayAudioFormat(extension) {
    const audio = document.createElement('audio');

    const mimeTypes = {
        'mp3': 'audio/mpeg',
        'ogg': 'audio/ogg; codecs="vorbis"',
        'wav': 'audio/wav',
        'flac': 'audio/flac',
        'aac': 'audio/aac',
        'm4a': 'audio/mp4; codecs="mp4a.40.2"',  // More specific M4A MIME type
        'opus': 'audio/ogg; codecs="opus"',
        'webm': 'audio/webm; codecs="opus"',
        'wma': 'audio/x-ms-wma'
    };

    const mimeType = mimeTypes[extension];
    if (!mimeType) {
        console.warn(`🎵 [FORMAT CHECK] No MIME type found for extension: ${extension}`);
        return false;
    }

    const canPlay = audio.canPlayType(mimeType);
    console.log(`🎵 [FORMAT CHECK] ${extension} (${mimeType}): ${canPlay}`);

    let isSupported = canPlay === 'probably' || canPlay === 'maybe';

    // Special handling for M4A - try fallback MIME types if first one fails
    if (!isSupported && extension === 'm4a') {
        const fallbackMimeTypes = ['audio/mp4', 'audio/x-m4a', 'audio/aac'];
        console.log(`🎵 [FORMAT CHECK] M4A failed with primary MIME type, trying fallbacks...`);

        for (const fallbackMime of fallbackMimeTypes) {
            const fallbackResult = audio.canPlayType(fallbackMime);
            console.log(`🎵 [FORMAT CHECK] M4A fallback (${fallbackMime}): ${fallbackResult}`);
            if (fallbackResult === 'probably' || fallbackResult === 'maybe') {
                isSupported = true;
                console.log(`🎵 [FORMAT CHECK] M4A supported with fallback MIME type: ${fallbackMime}`);
                break;
            }
        }
    }

    console.log(`🎵 [FORMAT CHECK] ${extension} final support result: ${isSupported}`);
    return isSupported;
}

// ===============================
// EXPANDED NOW PLAYING MODAL
// ===============================

let npModalOpen = false;
let npRepeatMode = 'off';     // 'off' | 'all' | 'one'
let npShuffleOn = false;
let npQueue = [];
let npQueueIndex = -1;
let npMuted = false;
let npPreMuteVolume = 70;
let npMediaSessionThrottle = 0;
let npLoadingQueueItem = false;
let npPlaybackGeneration = 0;
let npPlaybackAbort = new AbortController();
// Serialize server stream mutations; stale requests never start audio afterward.
let npPlaybackSetup = Promise.resolve();
window.cancelPendingPlayback = function () {
    npPlaybackGeneration += 1;
    npPlaybackAbort.abort();
    npPlaybackAbort = new AbortController();
    npLoadingQueueItem = false;
};
let npRadioMode = false;
let npRecentlyPlayedIds = [];
let npAudioContext = null;
let npAnalyser = null;
let npMediaSource = null;
let npVizInitialized = false;
let npCrossfadeOn = false;
let npSleepMinutes = 0;       // 0 = off
let npSleepTimerId = null;
let npSleepEndOfTrack = false; // sleep when the current track ends
let npAutoDownloadQueue = false;
let npQueueRequestCounter = 0;
let npQueuePrefetchRequest = null;
let npQueuePrefetchReschedule = false;
let npQueuePrefetchTimer = null;
let npQueuePrefetchPoller = null;
const npQueuePrefetchBatchIds = new Set();
const NP_QUEUE_PREFETCH_TERMINAL = new Set(['failed', 'not_found', 'cancelled', 'quarantined']);

function npQueueIdentity(track) {
    const source = String(track?.source || track?.metadata_source || '').trim().toLowerCase();
    const sourceId = String(track?.source_track_id || track?.spotify_track_id || track?.tidal_track_id ||
        track?.deezer_id || track?.itunes_track_id || track?.musicbrainz_recording_id || track?.track_id || '').trim();
    if (source && sourceId) return `source:${source}:${sourceId}`;
    const title = String(track?.title || track?.name || '').trim().toLowerCase();
    const artistValues = Array.isArray(track?.artists) ? track.artists : [];
    const artists = artistValues.map(value => String(typeof value === 'object' ? value?.name : value || '').trim().toLowerCase()).filter(Boolean);
    if (!artists.length) artists.push(String(track?.artist || track?.artist_name || '').trim().toLowerCase());
    const rawAlbum = track?.album;
    const album = String(typeof rawAlbum === 'object' ? (rawAlbum?.name || rawAlbum?.title || '') :
        (rawAlbum || track?.album_title || '')).trim().toLowerCase();
    return `metadata:${title}|${artists.join('|')}|${album}`;
}

function npPrepareQueueTrack(rawTrack) {
    const track = { ...(rawTrack || {}) };
    track.title = track.title || track.name || 'Unknown Track';
    track.name = track.name || track.title;
    if (!track.artist) {
        const first = Array.isArray(track.artists) ? track.artists[0] : null;
        track.artist = typeof first === 'object' ? first?.name : first;
    }
    track.artist = track.artist || track.artist_name || 'Unknown Artist';
    if (!Array.isArray(track.artists) || !track.artists.length) track.artists = [{ name: track.artist }];
    if (typeof track.album === 'object') track.album = track.album?.name || track.album?.title || '';
    track.album = track.album || track.album_title || 'Unknown Album';
    track.file_path = track.file_path || track.filename || '';
    track.filename = track.file_path;
    track.is_library = Boolean(track.file_path);
    track.playback_status = (track.file_path || track.media_src) ? 'ready' : (track.playback_status || 'missing');
    track._queue_identity = npQueueIdentity(track);
    if (!track._queue_request_id) {
        const existing = npQueue.find(item => item?._queue_identity === track._queue_identity && item?._queue_request_id);
        track._queue_request_id = existing?._queue_request_id ||
            `npq-${Date.now().toString(36)}-${(++npQueueRequestCounter).toString(36)}`;
    }
    return track;
}

function npPrepareQueueTracks(rawTracks) {
    const requestIdByIdentity = new Map();
    return (rawTracks || []).map(rawTrack => {
        const track = npPrepareQueueTrack(rawTrack);
        const sharedRequestId = requestIdByIdentity.get(track._queue_identity);
        if (sharedRequestId) {
            track._queue_request_id = sharedRequestId;
        } else {
            requestIdByIdentity.set(track._queue_identity, track._queue_request_id);
        }
        return track;
    });
}

function npQueueTrackNeedsDownload(track) {
    // an episode or an audiobook sample plays from its own address
    return Boolean(track && !track.media_src && !track.file_path && track.title && track.artist &&
        !NP_QUEUE_PREFETCH_TERMINAL.has(track.playback_status));
}

function npAutoDownloadStorageKey() {
    const profile = String(window._currentProfileName || 'default');
    return `soulsync-queue-auto-download:${profile}`;
}

function npQueueStatusLabel(track) {
    switch (track?.playback_status) {
        case 'requesting': return 'Preparing…';
        case 'pending':
        case 'queued': return 'Queued';
        case 'searching': return 'Searching…';
        case 'downloading': return track.download_progress > 0 ? `Downloading ${Math.round(track.download_progress)}%` : 'Downloading…';
        case 'post_processing': return 'Verifying…';
        case 'ready': return 'Ready';
        case 'failed': return 'Download failed';
        case 'not_found': return 'Not found';
        case 'cancelled': return 'Cancelled';
        case 'quarantined': return 'Quarantined';
        default: return track?.file_path ? '' : 'Missing';
    }
}

function npApplyQueuePrefetchState(requestIds, state, finalPath = '', progress = 0, error = '') {
    const ids = new Set((requestIds || []).map(String));
    let changed = false;
    npQueue.forEach(track => {
        if (!ids.has(String(track?._queue_request_id || ''))) return;
        if (finalPath) {
            track.file_path = finalPath;
            track.filename = finalPath;
            track.is_library = true;
            track.playback_status = 'ready';
            track.playback_error = '';
        } else {
            track.playback_status = state || track.playback_status;
            track.download_progress = Number(progress || 0);
            track.playback_error = error || '';
        }
        changed = true;
    });
    return changed;
}

function npStartQueuePrefetchPolling() {
    if (npQueuePrefetchPoller || npQueuePrefetchBatchIds.size === 0) return;
    npQueuePrefetchPoller = setInterval(npPollQueuePrefetch, 2000);
    npPollQueuePrefetch();
}

function npStopQueuePrefetchPolling() {
    if (npQueuePrefetchPoller) clearInterval(npQueuePrefetchPoller);
    npQueuePrefetchPoller = null;
}

async function npPollQueuePrefetch() {
    if (npQueuePrefetchBatchIds.size === 0) {
        npStopQueuePrefetchPolling();
        return;
    }
    const query = [...npQueuePrefetchBatchIds].map(id => `batch_ids=${encodeURIComponent(id)}`).join('&');
    try {
        const response = await fetch(`/api/playback/queue/prefetch/status?${query}`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Queue download status unavailable');
        let changed = false;
        Object.entries(data.batches || {}).forEach(([batchId, batch]) => {
            const tasks = Array.isArray(batch?.tasks) ? batch.tasks : [];
            tasks.forEach(task => {
                const info = task.track_info || {};
                const requestIds = Array.isArray(info._queue_request_ids) && info._queue_request_ids.length
                    ? info._queue_request_ids
                    : [info._queue_request_id].filter(Boolean);
                if (!requestIds.length) return;
                const state = task.quarantine_entry_id ? 'quarantined' : String(task.status || 'queued');
                const finalPath = state === 'completed' ? String(task.final_file_path || '') : '';
                changed = npApplyQueuePrefetchState(
                    requestIds,
                    finalPath ? 'ready' : state,
                    finalPath,
                    task.progress,
                    task.error_message,
                ) || changed;
            });
            const terminal = ['complete', 'error', 'cancelled'].includes(batch?.phase) &&
                tasks.every(task => ['completed', 'failed', 'not_found', 'cancelled'].includes(task.status));
            if (terminal) npQueuePrefetchBatchIds.delete(batchId);
        });
        if (changed) renderNpQueue();
        if (npQueuePrefetchBatchIds.size === 0) npStopQueuePrefetchPolling();
    } catch (error) {
        console.warn('Queue prefetch status failed:', error.message);
    }
}

async function npPrefetchMissingQueueTracks() {
    if (!npAutoDownloadQueue) return;
    if (npQueuePrefetchRequest) return npQueuePrefetchRequest;
    const missing = npQueue.filter(npQueueTrackNeedsDownload);
    if (!missing.length) return;
    missing.forEach(track => { track.playback_status = 'requesting'; });
    renderNpQueue();
    npQueuePrefetchRequest = (async () => {
        try {
            const response = await fetch('/api/playback/queue/prefetch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tracks: missing }),
            });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.error || 'Could not prefetch queue');
            (data.items || []).forEach(item => {
                npApplyQueuePrefetchState(
                    item.request_ids || [],
                    item.state || 'queued',
                    item.final_path || '',
                );
            });
            (data.batch_ids || []).forEach(id => npQueuePrefetchBatchIds.add(String(id)));
            if (data.queued > 0) showToast(`Preloading ${data.queued} missing queue track${data.queued === 1 ? '' : 's'}`, 'info');
            renderNpQueue();
            npStartQueuePrefetchPolling();
        } catch (error) {
            missing.forEach(track => {
                if (track.playback_status === 'requesting') {
                    track.playback_status = 'failed';
                    track.playback_error = error.message;
                }
            });
            renderNpQueue();
            showToast(`Queue prefetch failed: ${error.message}`, 'error');
        } finally {
            npQueuePrefetchRequest = null;
            if (npQueuePrefetchReschedule) {
                npQueuePrefetchReschedule = false;
                npScheduleQueuePrefetch();
            }
        }
    })();
    return npQueuePrefetchRequest;
}

function npScheduleQueuePrefetch() {
    if (!npAutoDownloadQueue) return;
    if (npQueuePrefetchRequest) {
        npQueuePrefetchReschedule = true;
        return;
    }
    if (npQueuePrefetchTimer) clearTimeout(npQueuePrefetchTimer);
    npQueuePrefetchTimer = setTimeout(() => {
        npQueuePrefetchTimer = null;
        npPrefetchMissingQueueTracks();
    }, 80);
}

async function npEnsureQueueTrackReady(track, isCurrent = () => true) {
    if (track?.file_path) return track;
    if (!npAutoDownloadQueue) throw new Error('Auto-download is disabled for missing queue tracks');
    await npPrefetchMissingQueueTracks();
    const deadline = Date.now() + 45 * 60 * 1000;
    while (!track.file_path && Date.now() < deadline) {
        if (!isCurrent()) throw new Error('Playback superseded');
        if (NP_QUEUE_PREFETCH_TERMINAL.has(track.playback_status)) {
            throw new Error(track.playback_error || npQueueStatusLabel(track));
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (!isCurrent()) throw new Error('Playback superseded');
        await npPollQueuePrefetch();
    }
    if (!track.file_path) throw new Error('Download timed out after 45 minutes');
    return track;
}

function npQueueHasNext() {
    if (npQueue.length === 0) return false;
    return npShuffleOn
        ? npQueue.length > 1
        : (npQueueIndex < npQueue.length - 1 || npRepeatMode === 'all');
}

function npEnsureCurrentTrackInQueue() {
    if (!currentTrack || !currentTrack.is_library || npQueue.length > 0) return;
    npQueue.push({
        title: currentTrack.title,
        artist: currentTrack.artist,
        album: currentTrack.album,
        file_path: currentTrack.filename || currentTrack.file_path,
        filename: currentTrack.filename || currentTrack.file_path,
        is_library: true,
        image_url: currentTrack.image_url,
        id: currentTrack.id,
        artist_id: currentTrack.artist_id,
        album_id: currentTrack.album_id,
        bitrate: currentTrack.bitrate,
        sample_rate: currentTrack.sample_rate
    });
    npQueueIndex = 0;
    renderNpQueue();
    updateNpPrevNextButtons();
}

function npSetRadioMode(enabled, options = {}) {
    const { toast = true, fetchIfNeeded = false } = options;
    npRadioMode = Boolean(enabled);
    const radioBtn = document.getElementById('np-radio-btn');
    if (radioBtn) {
        radioBtn.classList.toggle('active', npRadioMode);
        radioBtn.setAttribute('aria-pressed', npRadioMode ? 'true' : 'false');
        radioBtn.title = npRadioMode
            ? 'Radio mode on - similar tracks will auto-queue'
            : 'Radio mode - auto-add similar tracks';
    }
    if (toast) {
        // Radio seeds from the current track's LIBRARY id — a streamed
        // (non-library) track has none, so promising auto-queue would be a
        // lie. Mode stays armed either way: it engages on the next library
        // track that plays.
        if (npRadioMode && currentTrack && !currentTrack.id) {
            showToast('Radio armed - it kicks in when a library track plays', 'info');
        } else {
            showToast(npRadioMode ? 'Radio mode on - similar tracks will auto-queue' : 'Radio mode off', 'success');
        }
    }
    // Context label: only set the generic "Radio" if a more specific one (e.g.
    // "<Artist> Radio") wasn't already set by the caller.
    if (npRadioMode) {
        if (!npPlayContext || !/radio/i.test(npPlayContext)) npSetPlayContext('Radio');
    } else if (/radio/i.test(npPlayContext)) {
        npSetPlayContext('');
    }
    if (npRadioMode && fetchIfNeeded && currentTrack && currentTrack.id && !npLoadingQueueItem && !npQueueHasNext()) {
        npEnsureCurrentTrackInQueue();
        npFetchRadioTracks();
    }
    if (typeof npNotify === 'function') npNotify('settings');
}

// Wires what the chrome doesn't own: the queue menu's switches (their ids
// live in the record's "…" menu now), the buffering state, the keyboard and
// the Media Session. The chrome itself boots from src/shell/player.ts.
function initExpandedPlayer() {
    // No crossfade (Ross, 27 October: "we either mix auto or manual or
    // nothing"): Between tracks is Off or Auto mix. A stored Smart crossfade
    // ('smart') and the old crossfade switch both become Off, once.
    npCrossfadeOn = false;
    try {
        if (localStorage.getItem('soulsync-crossfade') === '1') localStorage.setItem('soulsync-crossfade', '0');
        const between = localStorage.getItem('soulsync-between-tracks');
        if (between !== null && between !== 'off' && between !== 'dj') localStorage.setItem('soulsync-between-tracks', 'off');
    } catch (e) { /* storage unavailable */ }

    const queueClearBtn = document.getElementById('np-queue-clear');
    if (queueClearBtn) queueClearBtn.addEventListener('click', () => { clearQueue(); });

    const autoDownloadBtn = document.getElementById('np-autodownload-btn');
    if (autoDownloadBtn) {
        autoDownloadBtn.classList.toggle('active', npAutoDownloadQueue);
        autoDownloadBtn.setAttribute('aria-pressed', npAutoDownloadQueue ? 'true' : 'false');
        autoDownloadBtn.addEventListener('click', () => npSetAutoDownload(!npAutoDownloadQueue));
    }

    // Radio mode button
    const radioBtn = document.getElementById('np-radio-btn');
    if (radioBtn) {
        radioBtn.addEventListener('click', () => {
            npSetRadioMode(!npRadioMode, { fetchIfNeeded: true });
        });
    }

    // Keyboard shortcuts (global)
    document.addEventListener('keydown', handlePlayerKeyboardShortcuts);

    // Buffering: the chrome rings the play button while the element waits
    if (audioPlayer) {
        audioPlayer.addEventListener('waiting', () => { npBuffering = true; npNotify('buffering'); });
        const ready = () => { if (npBuffering) { npBuffering = false; npNotify('buffering'); } };
        audioPlayer.addEventListener('canplay', ready);
        audioPlayer.addEventListener('playing', ready);
        audioPlayer.addEventListener('emptied', ready);
    }

    // Init Media Session API
    initMediaSession();
}

let npBuffering = false;

function npSetAutoDownload(on) {
    npAutoDownloadQueue = Boolean(on);
    const btn = document.getElementById('np-autodownload-btn');
    if (btn) {
        btn.classList.toggle('active', npAutoDownloadQueue);
        btn.setAttribute('aria-pressed', npAutoDownloadQueue ? 'true' : 'false');
    }
    try { localStorage.setItem(npAutoDownloadStorageKey(), npAutoDownloadQueue ? '1' : '0'); } catch (_) {}
    showToast(npAutoDownloadQueue ? 'Queue auto-download enabled' : 'Queue auto-download disabled', 'info');
    if (npAutoDownloadQueue) npScheduleQueuePrefetch();
    npNotify('settings');
}

// Kept for anything that still calls it: there's no crossfade any more, so
// it only ever turns it off (Between tracks is Off or Auto mix).
function npSetCrossfade(on) {
    npCrossfadeOn = false;
    void on;
    try {
        localStorage.setItem('soulsync-crossfade', '0');
    } catch (e) {}
    npNotify('settings');
    if (typeof renderNpQueue === 'function') renderNpQueue();
}

// The tray took the Now Playing modal's place: "open" expands the player,
// "close" collapses it. npModalOpen mirrors the tray for the old checks.
function openNowPlayingModal() {
    if (window.SoulSyncPlayerChrome && typeof window.SoulSyncPlayerChrome.expand === 'function') {
        window.SoulSyncPlayerChrome.expand();
    }
}

function closeNowPlayingModal() {
    if (window.SoulSyncPlayerChrome && typeof window.SoulSyncPlayerChrome.collapse === 'function') {
        window.SoulSyncPlayerChrome.collapse();
    }
}

function syncExpandedPlayerUI() {
    npNotify('sync');
}

// a library track: played from the library, with its db ids. streams and
// queued downloads have nothing an issue could point at.
function npIsReportableTrack(track) {
    return !!(track && track.is_library && track.id != null && track.id !== '' && track.artist_id != null);
}

// The record's art (#np-album-art) is set here, not by the chrome: its
// colours become the visuals' palette (npExtractAmbientColor) and the vinyl
// visual draws it on the label. Everything else the chrome draws.
function updateNpTrackInfo() {
    const artImg = document.getElementById('np-album-art');
    const artPlaceholder = document.getElementById('np-album-art-placeholder');

    if (currentTrack) {
        const artUrl = getNpAlbumArtUrl();
        if (artUrl && artImg) {
            // Only set crossOrigin for external URLs — local paths break with CORS headers
            if (artUrl.startsWith('http')) {
                artImg.crossOrigin = 'anonymous';
            } else {
                artImg.removeAttribute('crossOrigin');
            }
            if (artImg.getAttribute('src') !== artUrl) artImg.src = artUrl;
            artImg.classList.remove('hidden');
            if (artPlaceholder) artPlaceholder.classList.add('hidden');
            artImg.onerror = () => {
                artImg.classList.add('hidden');
                if (artPlaceholder) artPlaceholder.classList.remove('hidden');
                npResetAmbientGlow();
            };
            artImg.onload = () => { npExtractAmbientColor(artImg); };
        } else if (artImg) {
            artImg.classList.add('hidden');
            if (artPlaceholder) artPlaceholder.classList.remove('hidden');
            npResetAmbientGlow();
        }

        // Track recently played for radio mode
        if (currentTrack.id && !npRecentlyPlayedIds.includes(currentTrack.id)) {
            npRecentlyPlayedIds.push(currentTrack.id);
            if (npRecentlyPlayedIds.length > 50) npRecentlyPlayedIds.shift();
        }
    } else {
        if (artImg) artImg.classList.add('hidden');
        if (artPlaceholder) artPlaceholder.classList.remove('hidden');
        npResetAmbientGlow();
    }
}

function npExtractAmbientColor(imgEl) {
    try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 64;
        canvas.height = 64;
        ctx.drawImage(imgEl, 0, 0, 64, 64);
        const data = ctx.getImageData(0, 0, 64, 64).data;

        // Dominant VIBRANT color, not a flat average (averaging muddies to
        // grey-brown). Bin colors into a coarse 4-bit-per-channel histogram,
        // weight each bin by saturation² × pixel-count so a punchy accent in
        // the cover wins over a large dull background. Apple-Music-style.
        const bins = new Map();
        for (let i = 0; i < data.length; i += 16) { // sample every 4th pixel
            const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
            if (a < 128) continue;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            const brightness = (r + g + b) / 3;
            if (brightness < 24 || brightness > 240) continue; // skip near-black/white
            const sat = max === 0 ? 0 : (max - min) / max; // 0..1
            const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
            const weight = (0.15 + sat * sat) ; // floor so greys still count a little
            const bin = bins.get(key);
            if (bin) { bin.r += r; bin.g += g; bin.b += b; bin.n++; bin.w += weight; }
            else bins.set(key, { r, g, b, n: 1, w: weight });
        }
        let best = null, bestScore = -1;
        for (const bin of bins.values()) {
            const score = bin.w; // saturation-weighted population
            if (score > bestScore) { bestScore = score; best = bin; }
        }
        if (best) {
            let r = Math.round(best.r / best.n);
            let g = Math.round(best.g / best.n);
            let b = Math.round(best.b / best.n);
            // Nudge toward vivid: lift saturation/brightness a touch so the
            // glow reads as a color, not a wash.
            [r, g, b] = npPunchUpColor(r, g, b);
            // a real second color from the same cover, so the theater's
            // accent belongs to the art instead of a channel swap of the first
            const [r2, g2, b2] = npPunchUpColor(...npPickAccentColor(Array.from(bins.values()), best));
            // the mini player wears the same colors as the theater
            for (const el of [document.querySelector('.np-modal'), document.getElementById('media-player')]) {
                if (!el) continue;
                el.style.setProperty('--np-ambient-r', r);
                el.style.setProperty('--np-ambient-g', g);
                el.style.setProperty('--np-ambient-b', b);
                el.style.setProperty('--np-ambient2-r', r2);
                el.style.setProperty('--np-ambient2-g', g2);
                el.style.setProperty('--np-ambient2-b', b2);
            }
        }
    } catch (e) {
        // Cross-origin or canvas error — ignore silently
    }
}

// Hue of an rgb color in degrees, or -1 for a grey. Pure.
function npHue(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    if (d < 12) return -1;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
}

// Second color for the theater: the strongest bin whose hue sits clearly away
// from the main one (and still carries a real share of the cover). A cover
// with one color gets a close neighbour of it instead, lighter, so the accent
// is in harmony with the art, never a random channel swap. Pure.
function npPickAccentColor(bins, best) {
    const avg = (bin) => [bin.r / bin.n, bin.g / bin.n, bin.b / bin.n];
    const [br, bg, bb] = avg(best);
    const h0 = npHue(br, bg, bb);
    let pick = null, pickScore = -1;
    for (const bin of bins) {
        if (bin === best || bin.w < best.w * 0.12) continue;
        const [r, g, b] = avg(bin);
        const h = npHue(r, g, b);
        if (h < 0 || h0 < 0) continue;
        const dh = Math.min(Math.abs(h - h0), 360 - Math.abs(h - h0));
        if (dh < 40) continue;
        if (bin.w > pickScore) { pickScore = bin.w; pick = [r, g, b]; }
    }
    if (pick) return pick.map(Math.round);
    // analogous fallback: rotate the hue ~35 degrees and lift it a little
    const t = (35 / 360) * 2 * Math.PI;
    const cos = Math.cos(t), sin = Math.sin(t);
    const k = (1 - cos) / 3, q = Math.sqrt(1 / 3) * sin;
    const rot = [
        br * (cos + k) + bg * (k - q) + bb * (k + q),
        br * (k + q) + bg * (cos + k) + bb * (k - q),
        br * (k - q) + bg * (k + q) + bb * (cos + k),
    ];
    return rot.map((v) => Math.max(0, Math.min(255, Math.round(v * 1.12 + 10))));
}

// Lift a color toward vividness for the ambient glow (boost saturation,
// floor brightness) without fully desaturating dark/pastel covers.
function npPunchUpColor(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max === min) return [r, g, b]; // grey — leave it
    // Pull each channel away from the mid to boost perceived saturation ~1.3x.
    const mid = (max + min) / 2;
    const boost = 1.3;
    let nr = Math.round(mid + (r - mid) * boost);
    let ng = Math.round(mid + (g - mid) * boost);
    let nb = Math.round(mid + (b - mid) * boost);
    // Floor overall brightness so very dark covers still glow.
    const bright = (nr + ng + nb) / 3;
    if (bright < 70) { const lift = 70 / Math.max(bright, 1); nr *= lift; ng *= lift; nb *= lift; }
    const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
    return [clamp(nr), clamp(ng), clamp(nb)];
}

// ── Crossfade engine (library tracks only) ──
// EXPERIMENTAL. Real crossfade needs two tracks playing at once; /stream/audio
// only serves the ONE current track (single global stream_state), so we use a
// dedicated /stream/library-audio endpoint + a second <audio> to play the NEXT
// library track and ramp volumes. Streamed (non-library) tracks can't crossfade
// and fall back to the normal hard cut.
//
// Duration: the player theater (media-player-v2.js) exposes a duration picker;
// the setting lives in localStorage so the modal and mini player always agree.
function npCrossfadeSeconds() {
    const allowed = [0, 2, 4, 6, 10, 15];
    let v = 6;
    try {
        v = parseInt(localStorage.getItem('soulsync-npv2-crossfade-secs') || '6', 10);
    } catch (e) { /* storage unavailable — keep default */ }
    return allowed.indexOf(v) >= 0 ? v : 6;
}
let npXfadeAudio = null;
let npXfadeActive = false;
let npXfadeTimer = null;
let npXfadeMainVol = null;   // main-player volume to restore if a crossfade is aborted
// The second audio while the main player catches up to it after a fade. It
// keeps playing until the main player is at the same spot, so the handoff is
// heard as nothing at all instead of the song starting over.
let npXfadeHandoff = null;

function npStopHandoff(xa) {
    if (!xa) return;
    if (npXfadeHandoff === xa) npXfadeHandoff = null;
    try { xa.pause(); } catch (_) {}
    xa.src = '';
    xa.volume = 0;
}

// Abort an in-flight crossfade (manual skip / stop during the fade). Restores
// the main player's volume and tears down the second audio element. Safe to
// call when no crossfade is active (no-op).
function npCancelCrossfade() {
    if (npXfadeTimer) { clearInterval(npXfadeTimer); npXfadeTimer = null; }
    if (typeof npSettleTimer !== 'undefined' && npSettleTimer) { clearInterval(npSettleTimer); npSettleTimer = null; }
    if (npXfadeAudio) { try { npXfadeAudio.pause(); } catch (_) {} npXfadeAudio.src = ''; npXfadeAudio.volume = 0; npXfadeAudio = null; }
    // A skip while the main player was still catching up: the handed-off
    // audio would otherwise play on underneath the new track.
    if (npXfadeHandoff) npStopHandoff(npXfadeHandoff);
    if (npXfadeActive && audioPlayer && npXfadeMainVol !== null) {
        audioPlayer.volume = npXfadeMainVol; // undo any partial fade-down
    }
    npXfadeActive = false;
    npXfadeMainVol = null;
}

// Player settings → Between tracks (26h): 'off' (plain playback) or 'dj'
// (shown as Auto mix). Kept per browser; anything else ('smart', from when
// there was a crossfade) reads as Off.
const NP_BETWEEN_KEY = 'soulsync-between-tracks';
function npBetweenTracks() {
    try {
        if (localStorage.getItem(NP_BETWEEN_KEY) === 'dj') return 'dj';
    } catch (e) { /* storage unavailable */ }
    return 'off';
}

// src/features/automix (window.SoulSyncAutomix) when it's loaded
function npAutomix() {
    const a = window.SoulSyncAutomix;
    return a && typeof a === 'object' ? a : null;
}
// Anything that loads other audio than the queue's next row (a station, a
// search result's stream, a podcast, Stop): auto-mix lets its decks go first,
// so a frozen mix can't come back over it (gauntlet H2). Its own hand-back
// is ignored there.
function npAutomixStop() {
    try { const a = npAutomix(); if (a && a.stop) a.stop(); } catch (e) { /* never block playback */ }
}
function npAutomixOwnsAdvance() {
    try { const a = npAutomix(); return Boolean(a && a.ownsAdvance && a.ownsAdvance()); } catch (e) { return false; }
}

// No crossfade (Ross, 27 October): Between tracks is Off or Auto mix, and
// Auto mix's decks mix, it cuts, or the track plays to its end. The old
// crossfade (npCrossfadeTick, npStartCrossfade, npFinishCrossfade and the
// window API's crossfadeInto) is gone; the loader's handoff option below
// stays for a second audio, should one ever be handed over again.

// After a crossfade that came in at the last track's loudness (Smart
// crossfade), the player goes back to its own level over 3 s, not at once.
let npSettleTimer = null;
function npSettleVolume(fromGain) {
    if (npSettleTimer) { clearInterval(npSettleTimer); npSettleTimer = null; }
    if (!audioPlayer || !(fromGain > 0 && fromGain < 1)) return;
    const steps = 30;
    let n = 0;
    const level = () => (npMuted ? 0 : npVolumePercent / 100);
    audioPlayer.volume = Math.min(1, level() * fromGain);
    npSettleTimer = setInterval(() => {
        n++;
        audioPlayer.volume = Math.min(1, level() * (fromGain + (1 - fromGain) * Math.min(1, n / steps)));
        if (n >= steps) { clearInterval(npSettleTimer); npSettleTimer = null; }
    }, 100);
}

function npResetAmbientGlow() {
    for (const el of [document.querySelector('.np-modal'), document.getElementById('media-player')]) {
        if (!el) continue;
        el.style.setProperty('--np-ambient-r', '29');
        el.style.setProperty('--np-ambient-g', '185');
        el.style.setProperty('--np-ambient-b', '84');
        el.style.setProperty('--np-ambient2-r', '29');
        el.style.setProperty('--np-ambient2-g', '140');
        el.style.setProperty('--np-ambient2-b', '185');
    }
}

function updateNpPlayButton() {
    // the chrome draws the play state; the old modal's visualizer bars are gone
    npNotify('playing');
}

function updateNpProgress() {
    // the chrome follows the time from the element itself
}

function handleNpProgressBarChange(event) {
    if (!audioPlayer || !audioPlayer.duration) return;
    npSeek((parseFloat(event.target.value) / 100) * audioPlayer.duration);
}

function handleNpVolumeChange(event) {
    npSetVolume(parseInt(event.target.value, 10));
}

// Mute keeps the level to come back to.
function handleNpMuteToggle() {
    if (npMuted) {
        npMuted = false;
        npSetVolume(npPreMuteVolume > 0 ? npPreMuteVolume : 70);
    } else {
        npPreMuteVolume = npVolumePercent > 0 ? npVolumePercent : 70;
        npMuted = true;
        if (audioPlayer) audioPlayer.volume = 0;
        npNotify('volume');
    }
}

function updateNpMuteIcon() {
    npNotify('volume');
}

// Shuffle and repeat: the chrome reads npShuffleOn / npRepeatMode.
function syncShuffleRepeatUI() {
    npNotify('modes');
}

function handleNpShuffle() {
    npShuffleOn = !npShuffleOn;
    syncShuffleRepeatUI();
    updateNpPrevNextButtons();
}

function handleNpRepeat() {
    if (npRepeatMode === 'off') {
        npRepeatMode = 'all';
        if (audioPlayer) audioPlayer.loop = false;
    } else if (npRepeatMode === 'all') {
        npRepeatMode = 'one';
        if (audioPlayer) audioPlayer.loop = true;
    } else {
        npRepeatMode = 'off';
        if (audioPlayer) audioPlayer.loop = false;
    }
    syncShuffleRepeatUI();
    updateNpPrevNextButtons();
}

// ===============================
// QUEUE MANAGEMENT
// ===============================

// "Playing from" context shown above the track title (Spotify-style).
let npPlayContext = '';
function npSetPlayContext(text) {
    npPlayContext = text || '';
    npNotify('context');
}

// The Added toast says once where a track is in the analysis line, when Auto
// mix is on and it isn't ready to mix (Brief A, 31b): "Playing next ·
// analysing, 2nd in line". The words come from the React side
// (window.ssAnalysisToastWords, the automix host); without it, or when the
// track is ready, the toast says what it always did.
function npQueueToast(words, track) {
    const ask = window.ssAnalysisToastWords;
    if (typeof ask !== 'function' || !track || track.id === undefined || track.id === null) {
        showToast(words, 'success');
        return;
    }
    Promise.resolve(ask([track.id]))
        .then(more => showToast(more ? `${words} · ${more}` : words, 'success'))
        .catch(() => showToast(words, 'success'));
}

function addToQueue(track) {
    npQueue.push(npPrepareQueueTrack(track));
    npQueueToast('Added to queue', track);
    renderNpQueue();
    updateNpPrevNextButtons();
    npScheduleQueuePrefetch();
    // If nothing is currently playing, auto-play the first queued track
    if (!currentTrack) {
        playQueueItem(npQueue.length - 1);
    }
}

// Insert a track to play right after the current one (Spotify "Play next").
function playNext(track) {
    if (npQueue.length === 0 || npQueueIndex < 0) {
        // Nothing queued / playing — same as add-to-queue (which auto-plays).
        addToQueue(track);
        return;
    }
    npQueue.splice(npQueueIndex + 1, 0, npPrepareQueueTrack(track));
    npQueueToast('Playing next', track);
    renderNpQueue();
    updateNpPrevNextButtons();
    npScheduleQueuePrefetch();
}

// a whole album onto the end of the queue: one toast, one render, not one per
// track the way calling addToQueue in a loop did.
function addTracksToQueue(tracks) {
    const list = npPrepareQueueTracks((tracks || []).filter(Boolean));
    if (!list.length) return;
    const firstNew = npQueue.length;
    npQueue.push(...list);
    showToast(list.length === 1 ? 'Added to queue' : `Added ${list.length} songs to queue`, 'success');
    renderNpQueue();
    updateNpPrevNextButtons();
    npScheduleQueuePrefetch();
    // same as addToQueue: nothing playing, so start with what was just added
    if (!currentTrack) {
        playQueueItem(firstNew);
    }
}

function removeFromQueue(index) {
    if (index < 0 || index >= npQueue.length) return;
    const wasCurrentTrack = (index === npQueueIndex);
    npQueue.splice(index, 1);
    // Adjust current index
    if (npQueue.length === 0) {
        npQueueIndex = -1;
        // Current track keeps playing but queue is now empty — that's OK
    } else if (index < npQueueIndex) {
        npQueueIndex--;
    } else if (wasCurrentTrack) {
        // Removed the currently playing item
        if (npQueueIndex >= npQueue.length) {
            npQueueIndex = npQueue.length - 1;
        }
        // Play the next track at the adjusted index
        playQueueItem(npQueueIndex);
    }
    renderNpQueue();
    npScheduleQueuePrefetch();
    updateNpPrevNextButtons();
    if (!npQueue.some(track => !track.file_path)) npStopQueuePrefetchPolling();
}

function clearQueue() {
    npQueue = [];
    npQueueIndex = -1;
    npQueuePrefetchBatchIds.clear();
    npStopQueuePrefetchPolling();
    renderNpQueue();
    updateNpPrevNextButtons();
}

function playNextInQueue() {
    // while auto-mix is mixing, Next cuts to the track coming in where it is
    try { const a = npAutomix(); if (a && a.next && a.next()) return; } catch (e) { /* the player's own next */ }
    if (npQueue.length === 0) {
        // Radio with an empty queue (e.g. cleared mid-session): a skip should
        // re-seed from the current track, not go dead.
        if (npRadioMode && currentTrack && currentTrack.id && !npLoadingQueueItem) {
            npEnsureCurrentTrackInQueue();
            npFetchRadioTracks(true);
        }
        return;
    }
    if (npShuffleOn) {
        // Pick a random index that is not the current one
        const candidates = [];
        for (let i = 0; i < npQueue.length; i++) {
            if (i !== npQueueIndex) candidates.push(i);
        }
        if (candidates.length === 0) return;
        const next = candidates[Math.floor(Math.random() * candidates.length)];
        playQueueItem(next);
    } else {
        const next = npQueueIndex + 1;
        if (next >= npQueue.length) {
            // End of queue — repeat-all wraps to start
            if (npRepeatMode === 'all') {
                playQueueItem(0);
                return;
            }
            // Radio mode: a skip at the tail of the fetched batch used to do
            // nothing (more tracks only arrived when the song ENDED naturally)
            // — fetch the next batch now and advance as soon as it lands.
            if (npRadioMode && currentTrack && currentTrack.id && !npLoadingQueueItem) {
                npFetchRadioTracks(true);
            }
            return;
        }
        playQueueItem(next);
    }
}

function playPreviousInQueue() {
    // a mix or its countdown stops first: the track going out plays on here
    try { const a = npAutomix(); if (a && a.previous) a.previous(); } catch (e) { /* the player's own previous */ }
    // If more than 3 seconds in, restart current track
    if (audioPlayer && audioPlayer.currentTime > 3) {
        audioPlayer.currentTime = 0;
        if (audioPlayer.paused) audioPlayer.play();
        return;
    }
    if (npQueue.length === 0) return;
    const prev = npQueueIndex - 1;
    if (prev < 0) {
        // At start — restart current track
        if (audioPlayer) {
            audioPlayer.currentTime = 0;
            if (audioPlayer.paused) audioPlayer.play();
        }
        return;
    }
    playQueueItem(prev);
}

// a missing queue song with auto-download off was skipped. with the stream
// source on deezer previews it plays its 30s clip instead (#1312). null
// means no clip (another stream source, or deezer doesn't have the song),
// and the caller skips like before.
async function npFindQueuePreview(track, signal) {
    try {
        const response = await fetch('/api/enhanced-search/stream-track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                track_name: track.title || '',
                artist_name: track.artist || '',
                album_name: track.album || '',
                preview_only: true,
            }),
            signal,
        });
        const data = await response.json();
        return (data && data.success && data.result && data.result.preview) ? data.result : null;
    } catch (e) {
        return null;
    }
}

async function playQueueItem(index, options = {}) {
    const generation = npPlaybackGeneration;
    const signal = npPlaybackAbort.signal;
    const isCurrent = () => generation === npPlaybackGeneration && !signal.aborted && (!options.isCurrent || options.isCurrent());
    if (!isCurrent()) return { status: 'superseded' };
    let releaseSetup;
    if (index < 0 || index >= npQueue.length) return { status: 'empty' };
    if (npLoadingQueueItem) return { status: 'busy' }; // Prevent race condition from double-advance
    // Auto-mix lets go of a mix it's playing for any other load (a skip, a
    // row clicked); its own hand-back passes options.automix
    try { const a = npAutomix(); if (a && a.beforeLoad) a.beforeLoad(index, options); } catch (e) { /* never block playback */ }
    // Manual skip / row-click: tear down any second audio so it can't play on
    // under this change. No-op when nothing is there (no crossfade any more).
    npCancelCrossfade();
    // Registered AFTER the cancel: this load owns the second audio now, and
    // any later load's cancel is what silences it.
    if (options.handoff) npXfadeHandoff = options.handoff;
    npLoadingQueueItem = true;
    npAdvanceOwed = false;
    npQueueIndex = index;
    const track = npQueue[index];
    let preview = null;

    try {
        if (track.media_src) {
            // A podcast episode or an audiobook sample: no server stream, the
            // element plays the episode's own address.
            const previousSetup = npPlaybackSetup;
            npPlaybackSetup = new Promise(resolve => { releaseSetup = resolve; });
            await previousSetup;
            if (!isCurrent()) return { status: 'superseded' };
            await stopStream();
            if (!isCurrent()) return { status: 'superseded' };
            setTrackInfo({
                title: track.title,
                artist: track.artist,
                album: track.album,
                filename: '',
                is_library: false,
                kind: track.kind,
                media_id: track.media_id,
                media_src: track.media_src,
                image_url: track.image_url,
                duration: track.duration,
                chapters: track.chapters,
                chapters_url: track.chapters_url,
            });
            showLoadingAnimation();
            if (audioPlayer) audioPlayer.loop = (npRepeatMode === 'one');
            const startAt = await npSpokenResumeAt(track);
            if (!isCurrent()) return { status: 'superseded' };
            const playback = await startAudioPlayback(isCurrent, signal, null, track.media_src, { startAt });
            if (playback?.status !== 'played') {
                if (playback?.status === 'superseded') return playback;
                throw new Error(playback?.error || 'Playback did not start');
            }
            renderNpQueue();
            updateNpPrevNextButtons();
            return { status: 'played' };
        }
        if (!track.file_path && !npAutoDownloadQueue) {
            preview = await npFindQueuePreview(track, signal);
            if (!isCurrent()) return { status: 'superseded' };
        }
        if (!track.file_path && !preview) {
            setTrackInfo({
                title: track.title,
                artist: track.artist,
                album: track.album || 'Waiting for download',
                filename: '',
                is_library: false,
                image_url: track.image_url,
                download_pending: true,
            });
            showLoadingAnimation();
            const loadingText = document.querySelector('.loading-text');
            if (loadingText) loadingText.textContent = 'Downloading queued track…';
            renderNpQueue();
            await npEnsureQueueTrackReady(track, isCurrent);
            if (!isCurrent()) return { status: 'superseded' };
            track.is_library = true;
            if (loadingText) loadingText.textContent = 'Loading track…';
        }
        if (preview) {
            const previousSetup = npPlaybackSetup;
            npPlaybackSetup = new Promise(resolve => { releaseSetup = resolve; });
            await previousSetup;
            if (!isCurrent()) return { status: 'superseded' };
            await stopStream();
            if (!isCurrent()) return { status: 'superseded' };
            setTrackInfo({
                title: track.title,
                artist: track.artist,
                album: track.album,
                username: preview.username,
                filename: preview.filename,
                is_library: false,
                is_preview: true,
                image_url: track.image_url || preview.image_url || null,
                artist_id: track.artist_id,
                album_id: track.album_id,
            });
            showLoadingAnimation();
            const response = await fetch(API.stream.start, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(preview),
            });
            const result = await response.json();
            if (!isCurrent()) return { status: 'superseded' };
            if (!result.success) throw new Error(result.error || 'Preview unavailable');
            if (audioPlayer) audioPlayer.loop = (npRepeatMode === 'one');
            const playback = await startAudioPlayback(isCurrent, signal);
            if (playback?.status !== 'played') {
                if (playback?.status === 'superseded') return playback;
                throw new Error(playback?.error || 'Playback did not start');
            }
        } else if (track.is_library) {
            const previousSetup = npPlaybackSetup;
            npPlaybackSetup = new Promise(resolve => { releaseSetup = resolve; });
            await previousSetup;
            if (!isCurrent()) return { status: 'superseded' };
            // Library track playback flow
            await stopStream();
            if (!isCurrent()) return { status: 'superseded' };
            setTrackInfo({
                title: track.title,
                artist: track.artist,
                album: track.album,
                filename: track.file_path,
                is_library: true,
                image_url: track.image_url,
                id: track.id,
                artist_id: track.artist_id,
                album_id: track.album_id,
                bitrate: track.bitrate,
                sample_rate: track.sample_rate
            });
            showLoadingAnimation();

            const response = await fetch('/api/library/play', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_path: track.file_path,
                    title: track.title || '',
                    artist: track.artist || '',
                    album: track.album || '',
                    // Server song id (Navidrome/Subsonic) so playback can fall
                    // back to streaming via the server when the file isn't on
                    // SoulSync's disk (#809).
                    track_id: track.id || null
                })
            });
            const result = await response.json();
            if (!isCurrent()) return { status: 'superseded' };
            if (!result.success) throw new Error(result.error || 'Failed to start playback');
            // Re-apply repeat-one loop property
            if (audioPlayer) audioPlayer.loop = (npRepeatMode === 'one');
            const playback = await startAudioPlayback(isCurrent, signal, options.handoff || null, null,
                { settleFrom: options.settleFrom });
            if (playback?.status !== 'played') {
                if (playback?.status === 'superseded') return playback;
                throw new Error(playback?.error || 'Playback did not start');
            }
        } else {
            // Non-library (stream) tracks cannot be queued for auto-advance
            // Just show track info — the stream flow handles its own playback
            setTrackInfo({
                title: track.title,
                artist: track.artist,
                album: track.album,
                filename: track.filename || track.file_path,
                is_library: false,
                image_url: track.image_url,
                id: track.id,
                artist_id: track.artist_id,
                album_id: track.album_id,
                bitrate: track.bitrate,
                sample_rate: track.sample_rate
            });
        }
    } catch (error) {
        if (!isCurrent()) return { status: 'superseded' };
        console.error('Queue playback error:', error);
        showToast(`Skipping track: ${error.message}`, 'error');
        hideLoadingAnimation();
        // Auto-skip to next track on failure instead of stopping the queue
        npLoadingQueueItem = false;
        const nextIdx = npQueueIndex + 1;
        const skipping = nextIdx < npQueue.length;
        if (skipping) {
            setTimeout(() => { if (isCurrent()) void playQueueItem(nextIdx, options); }, 500);
        }
        // A queue that is moving on to the next track has not failed. Saying
        // 'failed' here made Discover announce "Playback could not start" and
        // then start playing the next track a moment later.
        return skipping
            ? { status: 'skipped', error: error.message }
            : { status: 'failed', error: error.message };
    } finally {
        releaseSetup?.();
        if (isCurrent()) npLoadingQueueItem = false;
    }

    renderNpQueue();
    updateNpPrevNextButtons();
    return { status: (track.is_library || preview) ? 'played' : 'unsupported' };
}

function npFocusQueueAction(index, action) {
    const list = document.getElementById('np-queue-list');
    const row = list?.querySelectorAll('.np-queue-item')[index];
    const button = row?.querySelector(`[data-queue-action="${action}"]`);
    if (button && !button.disabled) button.focus();
    else if (row) row.querySelector('[data-queue-action="play"]')?.focus();
    else if (list) { list.tabIndex = -1; list.focus(); }
}

function npAnnounceQueue(message) {
    let note = document.getElementById('np-queue-announcement');
    if (!note) {
        note = document.createElement('div'); note.id = 'np-queue-announcement';
        note.className = 'np-queue-announcement'; note.setAttribute('role', 'status');
        document.getElementById('np-queue-list')?.after(note);
    }
    note.textContent = message;
}

// "artist · FLAC" / "artist · MP3 320" / "show · podcast · 1.2×" under a
// queue row's title (board 6a).
function npQueueRowMeta(track) {
    const who = track.artist || 'Unknown Artist';
    if (track.kind === 'podcast' || track.kind === 'audiobook') {
        const speed = (window.npV2 && typeof window.npV2.getSpeed === 'function') ? window.npV2.getSpeed() : 1;
        return [who, track.kind, speed !== 1 ? `${speed}×` : ''].filter(Boolean).join(' · ');
    }
    const ext = getFileExtension(track.file_path || track.filename || '').toUpperCase();
    if (!ext) return who;
    const lossy = ['MP3', 'M4A', 'AAC', 'OGG', 'OPUS', 'WMA'].includes(ext);
    const fmt = ext === 'M4A' ? 'AAC' : ext;
    return `${who} · ${lossy && track.bitrate ? `${fmt} ${track.bitrate}` : fmt}`;
}

const NP_GRIP_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';

// The queue rows (the tray's Up next). Every row is in the list; the ones
// already played and the one playing are classed so the list shows what's
// up next until "Show all". Each row (34b): a drag grip, its number, the
// art, the title + "artist · format" (the whole row plays it), Play (or
// Playing), Move to the top on hover or focus, the duration or download
// state, and the actions (earlier, later, remove) on hover or focus.
function renderNpQueue() {
    const listEl = document.getElementById('np-queue-list');
    const emptyEl = document.getElementById('np-queue-empty');
    const countEl = document.getElementById('np-queue-count');
    if (!listEl) return;
    listEl.setAttribute('role', 'list');
    const focused = listEl.contains(document.activeElement) ? document.activeElement : null;
    const focusedIndex = focused?.closest('.np-queue-item')?.dataset.qindex;
    const focusedAction = focused?.dataset.queueAction;

    if (countEl) countEl.textContent = npQueue.length > 0 ? `(${npQueue.length})` : '';

    if (npQueue.length === 0) {
        listEl.innerHTML = '';
        if (emptyEl) emptyEl.classList.remove('hidden');
        if (typeof npPersistQueue === 'function') npPersistQueue();
        if (typeof npNotify === 'function') npNotify('queue');
        return;
    }

    if (emptyEl) emptyEl.classList.add('hidden');
    listEl.innerHTML = '';

    // DJ mix (26a): a transition chip in each gap from the playing track on;
    // src/features/automix fills the gaps (it hears npNotify('queue') below)
    let gaps = false;
    try { const a = npAutomix(); gaps = Boolean(a && a.gapsWanted && a.gapsWanted()); } catch (e) { gaps = false; }
    const gapFrom = Math.max(0, npQueueIndex);

    let firstUpNext = true;
    npQueue.forEach((track, i) => {
        const item = document.createElement('div');
        const place = i < npQueueIndex ? 'played' : (i === npQueueIndex ? 'active' : 'upnext');
        item.className = 'np-queue-item ' + place;
        if (place === 'upnext' && firstUpNext) { item.classList.add('upnext-first'); firstUpNext = false; }
        item.setAttribute('role', 'listitem');
        item.setAttribute('aria-label', `${i + 1} of ${npQueue.length}`);
        if (i === npQueueIndex) item.setAttribute('aria-current', 'true');

        // Drag-to-reorder
        item.draggable = true;
        item.dataset.qindex = i;
        item.addEventListener('dragstart', npQueueDragStart);
        item.addEventListener('dragover', npQueueDragOver);
        item.addEventListener('drop', npQueueDrop);
        item.addEventListener('dragend', npQueueDragEnd);

        const grip = document.createElement('span');
        grip.className = 'np-queue-item-grip';
        grip.setAttribute('aria-hidden', 'true');
        grip.innerHTML = typeof NP_GRIP_SVG !== 'undefined' ? NP_GRIP_SVG : '';
        item.appendChild(grip);

        // its place in the queue (34b; a set played as a mix numbers as its rows)
        const num = document.createElement('span');
        num.className = 'np-queue-item-num';
        num.setAttribute('aria-hidden', 'true');
        num.textContent = String(i + 1);
        item.appendChild(num);

        // Album thumbnail
        const art = document.createElement('img');
        art.className = 'np-queue-item-art';
        art.alt = '';
        if (track.image_url) {
            art.src = track.image_url;
            art.onerror = () => { art.style.visibility = 'hidden'; };
        } else {
            art.style.visibility = 'hidden';
        }
        item.appendChild(art);

        const info = document.createElement('button');
        info.type = 'button';
        info.className = 'np-queue-item-info np-queue-item-play';
        info.dataset.queueAction = 'play';
        info.setAttribute('aria-label', `Play ${track.title || 'Unknown track'} by ${track.artist || 'Unknown artist'}`);
        info.onclick = () => void playQueueItem(i);

        const title = document.createElement('span');
        title.className = 'np-queue-item-title';
        title.textContent = track.title || 'Unknown Track';

        const artist = document.createElement('span');
        artist.className = 'np-queue-item-artist';
        artist.textContent = typeof getFileExtension === 'function' ? npQueueRowMeta(track) : (track.artist || 'Unknown Artist');

        info.appendChild(title);
        info.appendChild(artist);
        item.appendChild(info);

        // Missing rows expose acquisition progress; ready rows keep the normal
        // equalizer/duration affordance.
        const meta = document.createElement('div');
        meta.className = 'np-queue-item-meta';
        const queueStatus = npQueueStatusLabel(track);
        if (!track.media_src && (!track.file_path || (track.playback_status && track.playback_status !== 'ready'))) {
            const status = document.createElement('span');
            status.className = `np-queue-item-status ${track.playback_status || 'missing'}`;
            status.textContent = queueStatus || 'Missing';
            if (track.playback_error) status.title = track.playback_error;
            meta.appendChild(status);
        } else if (track.duration) {
            const dur = document.createElement('span');
            dur.className = 'np-queue-item-duration';
            dur.textContent = formatTime(track.duration);
            meta.appendChild(dur);
        }

        // Brief D (34b): Play is the row's one visible button ("Play now" cuts
        // to it, as Next does), Playing (three green bars) on the playing row;
        // Move to the top (an arrow to a bar) on hover and focus: Up next's
        // Play next. Same paths as src/features/dj/row-play.tsx.
        const playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'np-queue-item-btn np-queue-item-playnow';
        playBtn.dataset.queueAction = 'play-now';
        if (i === npQueueIndex) {
            playBtn.dataset.kind = 'playing';
            playBtn.dataset.title = track.title || 'track';
            npQueuePlayingLabel(playBtn);
            playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 10h3v10H4zM10 4h3v16h-3zM16 13h3v7h-3z"/></svg>';
            playBtn.onclick = (e) => { e.stopPropagation(); togglePlayback(); };
        } else {
            playBtn.setAttribute('aria-label', `Play ${track.title || 'track'} now`);
            playBtn.title = 'Play now';
            playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4l14 8-14 8z"/></svg>';
            playBtn.onclick = (e) => { e.stopPropagation(); void playQueueItem(i); };
        }
        item.appendChild(playBtn);

        const topBtn = document.createElement('button');
        topBtn.type = 'button';
        topBtn.className = 'np-queue-item-btn np-queue-item-top';
        topBtn.dataset.queueAction = 'top';
        topBtn.setAttribute('aria-label', `Move ${track.title || 'track'} to the top`);
        topBtn.title = 'Move to the top: plays next';
        topBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V7M6 13l6-6 6 6M5 4h14"/></svg>';
        // nothing to move for the playing row or the one already next
        const already = npQueueIndex >= 0 ? (i === npQueueIndex || i === npQueueIndex + 1) : i === 0;
        if (already) { topBtn.disabled = true; topBtn.dataset.none = ''; }
        topBtn.onclick = (e) => {
            e.stopPropagation();
            const to = npMoveNext(i);
            if (to < 0) return;
            renderNpQueue();
            npFocusQueueAction(to, 'play-now');
            npAnnounceQueue(`${track.title || 'Track'} moved to the top: it plays next`);
        };
        item.appendChild(topBtn);

        item.appendChild(meta);
        const actions = document.createElement('div');
        actions.className = 'np-queue-item-actions';
        for (const [direction, target, symbol] of [['earlier', i - 1, '↑'], ['later', i + 1, '↓']]) {
            const move = document.createElement('button');
            move.type = 'button'; move.className = 'np-queue-item-move';
            move.dataset.queueAction = direction;
            move.textContent = symbol;
            move.setAttribute('aria-label', `Move ${track.title || 'track'} ${direction}`);
            move.disabled = target < 0 || target >= npQueue.length;
            move.onclick = () => {
                npReorderQueue(i, target);
                npFocusQueueAction(target, direction);
                npAnnounceQueue(`${track.title || 'Track'} moved to position ${target + 1} of ${npQueue.length}`);
            };
            actions.appendChild(move);
        }

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'np-queue-item-remove';
        removeBtn.dataset.queueAction = 'remove';
        removeBtn.setAttribute('aria-label', `Remove ${track.title || 'track'} from queue`);
        removeBtn.innerHTML = '&#10005;';
        removeBtn.title = 'Remove from queue';
        removeBtn.onclick = (e) => {
            e.stopPropagation();
            removeFromQueue(i);
            npFocusQueueAction(Math.min(i, npQueue.length - 1), 'remove');
            npAnnounceQueue(`${track.title || 'Track'} removed from queue`);
        };
        actions.appendChild(removeBtn);
        item.appendChild(actions);

        listEl.appendChild(item);
        if (gaps && i >= gapFrom && i < npQueue.length - 1) {
            const gap = document.createElement('div');
            gap.className = 'np-queue-gap';
            gap.dataset.automixGap = String(i);
            gap.setAttribute('role', 'listitem');
            gap.setAttribute('aria-label', `Transition into ${npQueue[i + 1].title || 'the next track'}`);
            listEl.appendChild(gap);
        }
    });

    npUpdateUpNext();
    npPersistQueue();
    if (focusedAction && focusedIndex !== undefined) npFocusQueueAction(Number(focusedIndex), focusedAction);
    if (typeof npNotify === 'function') npNotify('queue');
}

// ── Queue persistence across page reloads (localStorage) ──
const NP_QUEUE_STORAGE_KEY = 'soulsync-np-queue';

function npPersistQueue() {
    try {
        if (!npQueue.length) { localStorage.removeItem(NP_QUEUE_STORAGE_KEY); return; }
        localStorage.setItem(NP_QUEUE_STORAGE_KEY, JSON.stringify({
            queue: npQueue,
            index: npQueueIndex,
            savedAt: Date.now(),
        }));
    } catch (e) { /* quota / disabled storage — non-fatal */ }
}

// Restore the saved queue into the panel WITHOUT auto-playing (the user
// reloaded; resume playback is their choice via clicking a row).
function npRestoreQueue() {
    try {
        const raw = localStorage.getItem(NP_QUEUE_STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.queue) && data.queue.length) {
            npQueue = npPrepareQueueTracks(data.queue).map(track => {
                const restored = track;
                if (!restored.file_path && !restored.media_src) {
                    restored.playback_status = 'missing';
                    restored.playback_error = '';
                    restored.download_progress = 0;
                }
                return restored;
            });
            // Don't claim a track is "playing" on a fresh load — nothing is.
            npQueueIndex = -1;
            renderNpQueue();
            updateNpPrevNextButtons();
            npScheduleQueuePrefetch();
        }
    } catch (e) { /* corrupt entry — ignore */ }
}

// ── Queue drag-to-reorder ──
let npDragFromIndex = null;

function npQueueDragStart(e) {
    npDragFromIndex = Number(e.currentTarget.dataset.qindex);
    e.currentTarget.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox requires data to be set for drag to fire.
    try { e.dataTransfer.setData('text/plain', String(npDragFromIndex)); } catch (_) {}
}

function npQueueDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const row = e.currentTarget;
    document.querySelectorAll('.np-queue-item.drag-over').forEach(r => r.classList.remove('drag-over'));
    row.classList.add('drag-over');
}

function npQueueDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    const to = Number(e.currentTarget.dataset.qindex);
    npReorderQueue(npDragFromIndex, to);
}

function npQueueDragEnd() {
    document.querySelectorAll('.np-queue-item').forEach(r => r.classList.remove('dragging', 'drag-over'));
    npDragFromIndex = null;
}

// Move a queue item, keeping npQueueIndex pointed at the SAME playing track.
function npReorderQueue(from, to) {
    if (from === null || from === to || from < 0 || to < 0) return;
    if (from >= npQueue.length || to >= npQueue.length) return;
    const [moved] = npQueue.splice(from, 1);
    npQueue.splice(to, 0, moved);

    // Recompute which index now holds the currently-playing track.
    if (npQueueIndex === from) {
        npQueueIndex = to;
    } else if (from < npQueueIndex && to >= npQueueIndex) {
        npQueueIndex -= 1;
    } else if (from > npQueueIndex && to <= npQueueIndex) {
        npQueueIndex += 1;
    }
    renderNpQueue();
    updateNpPrevNextButtons();
    npScheduleQueuePrefetch();
}

// Auto-mix's hand-back: move a row to straight after the playing one and
// return where it is now. A row from above the playing one takes the playing
// row's place (npReorderQueue moves the playing index up by one for it).
// A set played as a mix from the playing track (the Mix tab's working set:
// Ross's report of 28 October): its later rows go straight after the playing
// one, each once (a row already queued after it moves here rather than being
// queued twice: the gauntlet review's M3), the rest of Up next after them;
// drawn and saved once. The index of the first.
function npQueueAfterPlaying(tracks) {
    const list = npPrepareQueueTracks((tracks || []).filter(Boolean));
    const ids = new Set(list.map(t => String(t.id)));
    for (let i = npQueue.length - 1; i > npQueueIndex; i--) {
        if (npQueue[i] && ids.has(String(npQueue[i].id))) npQueue.splice(i, 1);
    }
    const at = Math.max(0, npQueueIndex + 1);
    npQueue.splice(at, 0, ...list);
    renderNpQueue();
    updateNpPrevNextButtons();
    npPersistQueue();
    npScheduleQueuePrefetch();
    return at;
}

function npMoveNext(index) {
    if (!Number.isInteger(index) || index < 0 || index >= npQueue.length) return -1;
    const moved = npQueue[index];
    const at = index < npQueueIndex ? npQueueIndex : npQueueIndex + 1;
    if (index !== at) npReorderQueue(index, Math.min(at, npQueue.length - 1));
    npPersistQueue();
    return npQueue.indexOf(moved);
}

// Up-next peek: the old modal's "Next" line. The tray's list shows what's
// up next now; kept for callers.
function npUpdateUpNext() {}

// Sleep timer: off, 15 / 30 / 45 / 60 / 90 / 120 minutes, or the end of the
// track. End-of-track pauses when the current track finishes instead of using
// a minute timer. Firing always pauses (never stops) — see npFireSleepTimer.
const NP_SLEEP_STEPS = [0, 15, 30, 45, 60, 90, 120, 'track'];
let npSleepEndsAt = 0;   // ms timestamp the minute timer fires at, 0 when off

function npSetSleepTimer(next) {
    npClearSleepTimer();
    const btn = document.getElementById('np-sleep-btn');
    const label = document.getElementById('np-sleep-label');
    if (next === 'track') {
        npSleepEndOfTrack = true;
        if (label) label.textContent = 'Sleep: track end';
        if (btn) btn.classList.add('active');
    } else if (next > 0) {
        npSleepMinutes = next;
        if (label) label.textContent = `Sleep ${npSleepMinutes}m`;
        if (btn) btn.classList.add('active');
        npSleepTimerId = setTimeout(npFireSleepTimer, npSleepMinutes * 60 * 1000);
        npSleepEndsAt = Date.now() + npSleepMinutes * 60 * 1000;
    }
    // next === 0 means fully off, already handled by npClearSleepTimer().
    if (typeof npNotify === 'function') npNotify('sleep');
}

// Cycle off → 15 → 30 → 45 → 60 → 90 → 120 → end-of-track → off.
function npCycleSleepTimer() {
    const steps = NP_SLEEP_STEPS;
    const cur = npSleepEndOfTrack ? 'track' : npSleepMinutes;
    npSetSleepTimer(steps[(steps.indexOf(cur) + 1) % steps.length]);
}

function npClearSleepTimer() {
    if (npSleepTimerId) { clearTimeout(npSleepTimerId); npSleepTimerId = null; }
    npSleepMinutes = 0;
    npSleepEndOfTrack = false;
    npSleepEndsAt = 0;
    const btn = document.getElementById('np-sleep-btn');
    const label = document.getElementById('np-sleep-label');
    if (label) label.textContent = 'Sleep';
    if (btn) btn.classList.remove('active');
    if (typeof npNotify === 'function') npNotify('sleep');
}

function npFireSleepTimer() {
    // A station stops, as its Stop does (Design 147): a paused live stream
    // isn't what the timer promises, and the relay would keep running.
    if (typeof currentTrack !== 'undefined' && currentTrack && currentTrack.kind === 'radio') {
        npClearSleepTimer();
        if (window.SoulSyncRadio && typeof window.SoulSyncRadio.stop === 'function') {
            window.SoulSyncRadio.stop();
            return;
        }
        // no radio session to ask: drop the stream itself, so a relay doesn't stay open
        if (audioPlayer) {
            audioPlayer.pause();
            audioPlayer.removeAttribute('src');
            if (typeof audioPlayer.load === 'function') audioPlayer.load();
        }
        return;
    }
    // Pause, don't stop: handleStop() runs clearTrack(), which wipes
    // the queue (including the persisted copy) — falling asleep to a
    // playlist shouldn't cost the playlist. Pause keeps track + queue
    // so the morning is one tap to resume.
    // Tear down any in-flight crossfade first: the second audio element
    // plays outside audioPlayer, so pausing alone would leave it audible.
    npCancelCrossfade();
    if (audioPlayer && !audioPlayer.paused) audioPlayer.pause();
    setPlayingState(false);
    npClearSleepTimer();
}

let npCanPrev = false;
let npCanNext = false;
function updateNpPrevNextButtons() {
    npCanPrev = npQueueIndex > 0 || Boolean(audioPlayer && audioPlayer.currentTime > 3);
    // Radio keeps next alive at the batch tail — a skip there fetches more.
    const radioCanFetch = npRadioMode && currentTrack && currentTrack.id;
    npCanNext = (npQueue.length > 0 && (npShuffleOn ? npQueue.length > 1 : (npQueueIndex < npQueue.length - 1 || npRepeatMode === 'all')))
        || Boolean(radioCanFetch);
    npNotify('queue');
}

// what the now playing "Add to playlist" hands the picker: artist + title,
// or null when the track has no artist to identify it by
function npAddToPlaylistTrack(track) {
    if (!track) return null;
    let title = String(track.title || '');
    const cut = title.indexOf('||');   // some titles are stored "<id>||<title>"
    if (cut >= 0) title = title.slice(cut + 2);
    title = title.trim();
    const artist = String(track.artist || '').trim();
    if (!title || !artist || artist === 'Unknown Artist') return null;
    return { track_name: title, artist_name: artist, album_name: String(track.album || '').trim() };
}

function handlePlayerKeyboardShortcuts(event) {
    // a popover over the player (add to playlist) owns its own keys
    if (document.activeElement?.closest?.('[data-popover-layer]')) return;
    // Don't intercept when typing in inputs or when non-player modals are open
    const tag = document.activeElement.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || document.activeElement.isContentEditable) return;

    // Leave the keys to any dialog that's open (the visuals handle their own)
    if (event.defaultPrevented) return;
    // a page with its own single-letter keys claims them while it's open
    // (html[data-letter-keys], e.g. the Import inbox's j k a d x): those
    // letters are the page's there; Space, the arrows and shifted keys stay
    // the player's
    const claimed = document.documentElement && document.documentElement.dataset
        ? (document.documentElement.dataset.letterKeys || '') : '';
    if (claimed && !event.shiftKey && typeof event.key === 'string' && event.key.length === 1 &&
        claimed.toLowerCase().includes(event.key.toLowerCase())) return;
    const otherModals = document.querySelectorAll('.modal-overlay:not(.hidden):not(#np-modal-overlay)');
    if (otherModals.length > 0) return;
    if (document.activeElement?.closest?.('[role="dialog"][data-open], .ss-player-menu')) return;

    switch (event.key) {
        case ' ':
            if (!currentTrack) return;
            // a focused control takes its own Space
            if (document.activeElement?.closest?.('button, a[href], [role="slider"], [role="tab"], summary')) return;
            event.preventDefault();
            // a station stops (Design 145, 167): a paused live stream isn't what
            // Pause promises, and the bar and the visuals' transport say Stop
            if (currentTrack.kind === 'radio' && window.SoulSyncRadio && typeof window.SoulSyncRadio.stop === 'function') {
                window.SoulSyncRadio.stop();
                break;
            }
            togglePlayback();
            break;
        case 'ArrowLeft':
            if (!audioPlayer || !audioPlayer.duration) return;
            event.preventDefault();
            audioPlayer.currentTime = Math.max(0, audioPlayer.currentTime - 5);
            break;
        case 'ArrowRight':
            if (!audioPlayer || !audioPlayer.duration) return;
            event.preventDefault();
            audioPlayer.currentTime = Math.min(audioPlayer.duration, audioPlayer.currentTime + 5);
            break;
        case 'ArrowUp':
            if (!currentTrack) return;
            event.preventDefault();
            npSetVolume(npVolumePercent + 5);
            break;
        case 'ArrowDown':
            if (!currentTrack) return;
            event.preventDefault();
            npSetVolume(npVolumePercent - 5);
            break;
        // 24a: M, N, A and X through NP_LETTER_KEYS (below the handler)
        case 'm':
        case 'M':
        case 'n':
        case 'N':
        case 'a':
        case 'A':
        case 'x':
        case 'X': {
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            const actions = NP_LETTER_KEYS[(event.shiftKey ? '⇧' : '') + event.key.toUpperCase()];
            if (!actions) return;
            for (const action of actions) {
                if (npLetterKeyAction(action)) {
                    event.preventDefault();
                    break;
                }
            }
            break;
        }
        case 'p':
        case 'P':
            event.preventDefault();
            playPreviousInQueue();
            break;
        case 's':
        case 'S':
            // 24a: S stars or unstars the playing track everywhere (the
            // focused row's track first); Shift+S is the visuals' favourite
            if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
            if (typeof window.SoulSyncStarKey === 'function' && window.SoulSyncStarKey()) event.preventDefault();
            break;
        default:
            return; // Don't prevent default for unhandled keys
    }
}

// The letter keys (24a), each a list of actions tried in order until one
// acts: "mix:M" / "mix:N" / "mix:A" are the Mix tab's (M the tray to Mix and
// back, or the Visuals drawer; N the top match next; A the playing track into
// the working set; src/features/mix/mix-host.tsx), which act only while the
// playing track has a working Mix tab; "mute" and "next" are the player's
// own. Ross answered 287: mute and next move to ⇧M / ⇧N, which always mute
// and skip; plain M and N still do where there's no Mix tab. X is Mix now
// (26a, auto-mix stage C: src/features/automix): it acts only with DJ mix
// on and a next track it can mix into, else the key is the page's.
const NP_LETTER_KEYS = {
    'M': ['mix:M', 'mute'],
    '⇧M': ['mute'],
    'N': ['mix:N', 'next'],
    '⇧N': ['next'],
    'A': ['mix:A'],
    'X': ['automix:X'],
};

// true when the action acted (the key is then the page's no more)
function npLetterKeyAction(action) {
    if (action.startsWith('mix:')) {
        return Boolean(window.SoulSyncMix && window.SoulSyncMix.key(action.slice(4)));
    }
    if (action.startsWith('automix:')) {
        const a = npAutomix();
        return Boolean(a && a.key && a.key(action.slice(8)));
    }
    if (action === 'mute') {
        handleNpMuteToggle();   // works whether or not the modal is open
        return true;
    }
    if (action === 'next') {
        if (npQueue.length > 0) playNextInQueue();
        return true;
    }
    return false;
}

function syncVolumeUI(volumePercent) {
    npSetVolume(volumePercent);
}

// Remember volume across reloads (Spotify-style). Stored 0..100.
const NP_VOLUME_STORAGE_KEY = 'soulsync-volume';
function npPersistVolume(percent) {
    try { localStorage.setItem(NP_VOLUME_STORAGE_KEY, String(Math.round(percent))); } catch (e) {}
}
function npLoadSavedVolume() {
    try {
        const raw = localStorage.getItem(NP_VOLUME_STORAGE_KEY);
        if (raw === null) return null;
        const v = parseInt(raw, 10);
        return (isFinite(v) && v >= 0 && v <= 100) ? v : null;
    } catch (e) { return null; }
}

function getNpAlbumArtUrl() {
    if (!currentTrack) return null;
    return currentTrack.image_url || currentTrack.album_cover_url || currentTrack.thumb_url || null;
}

// ===============================
// WEB AUDIO VISUALIZER
// ===============================

// Once createMediaElementSource() captures the <audio> element, ALL of its
// output is routed through this AudioContext — so if the context is suspended
// (browsers create it suspended under the autoplay policy, and we init it from
// an async play().then callback that's outside the gesture), the track plays
// but no sound reaches the speakers. Resuming must happen on every play start,
// not only when the visualizer loop runs. Safe to call anytime.
function npEnsureAudioContextRunning() {
    try {
        if (npAudioContext && npAudioContext.state === 'suspended') {
            npAudioContext.resume().catch(() => {});
        }
    } catch (_) { /* no-op */ }
}

function npInitVisualizer() {
    if (npVizInitialized || !audioPlayer) return;
    try {
        if (!npAudioContext) {
            npAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (!npMediaSource) {
            npMediaSource = npAudioContext.createMediaElementSource(audioPlayer);
            npAnalyser = npAudioContext.createAnalyser();
            npAnalyser.fftSize = 64;
            npAnalyser.smoothingTimeConstant = 0.8;
            npMediaSource.connect(npAnalyser);
            npAnalyser.connect(npAudioContext.destination);
        }
        npVizInitialized = true;
        // Freshly created contexts start suspended — resume so the rerouted
        // element is actually audible (this is the no-sound-on-play bug).
        npEnsureAudioContextRunning();
    } catch (e) {
        console.warn('Web Audio visualizer init failed, using CSS fallback:', e.message);
        // Mark as CSS fallback
        const viz = document.getElementById('np-visualizer');
        if (viz) viz.classList.add('np-viz-css-fallback');
        npVizInitialized = true; // don't retry
    }
}

// The old transport bars and album-art visualizer went with the old player;
// the visuals overlay (media-player-v2.js) reads npAnalyser itself.

// ===============================
// SIDEBAR AUDIO VISUALIZER
// ===============================

let sidebarVizAnimFrame = null;
let sidebarVisualizerType = 'bars'; // bars | wave | spectrum | mirror | equalizer | none
const SIDEBAR_VIZ_BAR_COUNT = 32;

let _sidebarVizBuiltType = null;

function buildSidebarVizElements(type) {
    const container = document.getElementById('sidebar-visualizer');
    if (!container) return;
    if (_sidebarVizBuiltType === type && container.children.length > 0) return;
    _sidebarVizBuiltType = type;
    container.innerHTML = '';
    container.className = 'sidebar-visualizer';

    if (type === 'bars') {
        container.classList.add('viz-bars');
        for (let i = 0; i < SIDEBAR_VIZ_BAR_COUNT; i++) {
            const bar = document.createElement('div');
            bar.className = 'sidebar-viz-bar';
            container.appendChild(bar);
        }
    } else if (type === 'wave' || type === 'spectrum') {
        container.classList.add('viz-canvas');
        const canvas = document.createElement('canvas');
        canvas.className = 'sidebar-viz-canvas';
        canvas.width = 10;
        canvas.height = 600;
        container.appendChild(canvas);
    } else if (type === 'mirror') {
        container.classList.add('viz-mirror');
        for (let i = 0; i < SIDEBAR_VIZ_BAR_COUNT; i++) {
            const bar = document.createElement('div');
            bar.className = 'sidebar-viz-mirror-bar';
            container.appendChild(bar);
        }
    } else if (type === 'equalizer') {
        container.classList.add('viz-equalizer');
        for (let i = 0; i < SIDEBAR_VIZ_BAR_COUNT; i++) {
            const wrap = document.createElement('div');
            wrap.className = 'sidebar-viz-eq-wrap';
            const bar = document.createElement('div');
            bar.className = 'sidebar-viz-eq-bar';
            const peak = document.createElement('div');
            peak.className = 'sidebar-viz-eq-peak';
            wrap.appendChild(bar);
            wrap.appendChild(peak);
            container.appendChild(wrap);
        }
    }
}

function startSidebarVisualizer() {
    const type = sidebarVisualizerType;
    if (type === 'none') return;

    const container = document.getElementById('sidebar-visualizer');
    if (!container) return;

    buildSidebarVizElements(type);
    container.classList.add('active');

    if (sidebarVizAnimFrame) return;
    if (!npAnalyser) return;

    const bufferLength = npAnalyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const hueStart = 200, hueRange = 160;

    // Helper: average frequency bins for a given segment index
    function getBinValue(i, count) {
        const binsPerSeg = Math.max(1, Math.floor((bufferLength - 1) / count));
        let sum = 0;
        const start = i * binsPerSeg + 1;
        for (let b = 0; b < binsPerSeg; b++) sum += dataArray[Math.min(start + b, bufferLength - 1)];
        return (sum / binsPerSeg) / 255;
    }

    // ── Bars ──
    if (type === 'bars') {
        const bars = container.querySelectorAll('.sidebar-viz-bar');
        if (bars.length === 0) return;
        function drawBars() {
            sidebarVizAnimFrame = requestAnimationFrame(drawBars);
            npAnalyser.getByteFrequencyData(dataArray);
            for (let i = 0; i < bars.length; i++) {
                const value = getBinValue(i, bars.length);
                const scale = Math.max(0.08, value);
                const hue = (hueStart + (i / bars.length) * hueRange + value * 30) % 360;
                bars[i].style.transform = `scaleX(${scale})`;
                bars[i].style.backgroundColor = `hsla(${hue}, 80%, ${50 + value * 15}%, ${0.5 + value * 0.5})`;
            }
        }
        drawBars();

        // ── Wave ──
    } else if (type === 'wave') {
        const canvas = container.querySelector('.sidebar-viz-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        let hueOffset = 0;
        function drawWave() {
            sidebarVizAnimFrame = requestAnimationFrame(drawWave);
            const ch = container.clientHeight;
            if (ch > 0 && canvas.height !== ch) canvas.height = ch;
            npAnalyser.getByteFrequencyData(dataArray);
            const w = canvas.width, h = canvas.height;
            if (h === 0) return;
            ctx.clearRect(0, 0, w, h);

            let totalEnergy = 0;
            for (let i = 1; i < bufferLength; i++) totalEnergy += dataArray[i];
            const avgEnergy = totalEnergy / (bufferLength - 1) / 255;
            hueOffset = (hueOffset + 0.5) % 360;

            const segments = 64;
            ctx.lineWidth = 3;
            ctx.lineCap = 'round';
            ctx.beginPath();
            for (let i = 0; i <= segments; i++) {
                const y = (i / segments) * h;
                const binIdx = Math.min(Math.floor((i / segments) * (bufferLength - 1)) + 1, bufferLength - 1);
                const value = dataArray[binIdx] / 255;
                const x = (w / 2) + Math.sin((i / segments) * Math.PI * 4 + Date.now() * 0.003) * value * (w - 2) * 0.4;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            const grad = ctx.createLinearGradient(0, 0, 0, h);
            grad.addColorStop(0, `hsla(${hueOffset + 200}, 80%, 60%, ${0.3 + avgEnergy * 0.7})`);
            grad.addColorStop(0.5, `hsla(${hueOffset + 280}, 80%, 55%, ${0.3 + avgEnergy * 0.7})`);
            grad.addColorStop(1, `hsla(${hueOffset + 360}, 80%, 60%, ${0.3 + avgEnergy * 0.7})`);
            ctx.strokeStyle = grad;
            ctx.stroke();
            ctx.lineWidth = 6;
            ctx.globalAlpha = 0.15 + avgEnergy * 0.2;
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
        drawWave();

        // ── Spectrum (mountain/terrain fill) ──
    } else if (type === 'spectrum') {
        const canvas = container.querySelector('.sidebar-viz-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        let hueOffset = 0;
        // Smoothed values for fluid motion
        const smoothed = new Float32Array(64);

        function drawSpectrum() {
            sidebarVizAnimFrame = requestAnimationFrame(drawSpectrum);
            const ch = container.clientHeight;
            if (ch > 0 && canvas.height !== ch) canvas.height = ch;
            npAnalyser.getByteFrequencyData(dataArray);
            const w = canvas.width, h = canvas.height;
            if (h === 0) return;
            ctx.clearRect(0, 0, w, h);

            hueOffset = (hueOffset + 0.3) % 360;
            const segments = smoothed.length;

            // Smooth the frequency data
            for (let i = 0; i < segments; i++) {
                const binIdx = Math.min(Math.floor((i / segments) * (bufferLength - 1)) + 1, bufferLength - 1);
                const target = dataArray[binIdx] / 255;
                smoothed[i] += (target - smoothed[i]) * 0.25;
            }

            // Draw filled mountain shape from left edge
            ctx.beginPath();
            ctx.moveTo(0, 0);
            for (let i = 0; i <= segments; i++) {
                const y = (i / segments) * h;
                const value = i < segments ? smoothed[i] : smoothed[segments - 1];
                const x = value * w * 0.95;
                ctx.lineTo(x, y);
            }
            ctx.lineTo(0, h);
            ctx.closePath();

            // Gradient fill
            const fillGrad = ctx.createLinearGradient(0, 0, 0, h);
            fillGrad.addColorStop(0, `hsla(${hueOffset + 200}, 85%, 55%, 0.7)`);
            fillGrad.addColorStop(0.25, `hsla(${hueOffset + 240}, 80%, 50%, 0.6)`);
            fillGrad.addColorStop(0.5, `hsla(${hueOffset + 290}, 85%, 50%, 0.65)`);
            fillGrad.addColorStop(0.75, `hsla(${hueOffset + 330}, 80%, 50%, 0.6)`);
            fillGrad.addColorStop(1, `hsla(${hueOffset + 360}, 85%, 55%, 0.7)`);
            ctx.fillStyle = fillGrad;
            ctx.fill();

            // Bright edge line
            ctx.beginPath();
            ctx.moveTo(0, 0);
            for (let i = 0; i <= segments; i++) {
                const y = (i / segments) * h;
                const value = i < segments ? smoothed[i] : smoothed[segments - 1];
                ctx.lineTo(value * w * 0.95, y);
            }
            const lineGrad = ctx.createLinearGradient(0, 0, 0, h);
            lineGrad.addColorStop(0, `hsla(${hueOffset + 200}, 90%, 70%, 0.9)`);
            lineGrad.addColorStop(0.5, `hsla(${hueOffset + 290}, 90%, 65%, 0.9)`);
            lineGrad.addColorStop(1, `hsla(${hueOffset + 360}, 90%, 70%, 0.9)`);
            ctx.strokeStyle = lineGrad;
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Outer glow
            ctx.lineWidth = 4;
            ctx.globalAlpha = 0.2;
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
        drawSpectrum();

        // ── Mirror (bars from center outward) ──
    } else if (type === 'mirror') {
        const bars = container.querySelectorAll('.sidebar-viz-mirror-bar');
        if (bars.length === 0) return;
        function drawMirror() {
            sidebarVizAnimFrame = requestAnimationFrame(drawMirror);
            npAnalyser.getByteFrequencyData(dataArray);
            const half = Math.floor(bars.length / 2);
            for (let i = 0; i < half; i++) {
                const value = getBinValue(i, half);
                const scale = Math.max(0.06, value);
                const hue = (hueStart + (i / half) * hueRange + value * 30) % 360;
                const color = `hsla(${hue}, 80%, ${50 + value * 15}%, ${0.5 + value * 0.5})`;
                // Top half — mirror index from center
                const topIdx = half - 1 - i;
                const bottomIdx = half + i;
                bars[topIdx].style.transform = `scaleX(${scale})`;
                bars[topIdx].style.backgroundColor = color;
                if (bottomIdx < bars.length) {
                    bars[bottomIdx].style.transform = `scaleX(${scale})`;
                    bars[bottomIdx].style.backgroundColor = color;
                }
            }
        }
        drawMirror();

        // ── Equalizer (bars with falling peak indicators) ──
    } else if (type === 'equalizer') {
        const wraps = container.querySelectorAll('.sidebar-viz-eq-wrap');
        if (wraps.length === 0) return;
        const peaks = new Float32Array(wraps.length);
        const peakVelocity = new Float32Array(wraps.length);

        function drawEqualizer() {
            sidebarVizAnimFrame = requestAnimationFrame(drawEqualizer);
            npAnalyser.getByteFrequencyData(dataArray);
            for (let i = 0; i < wraps.length; i++) {
                const value = getBinValue(i, wraps.length);
                const scale = Math.max(0.06, value);
                const hue = (hueStart + (i / wraps.length) * hueRange + value * 30) % 360;
                const barEl = wraps[i].querySelector('.sidebar-viz-eq-bar');
                const peakEl = wraps[i].querySelector('.sidebar-viz-eq-peak');

                barEl.style.transform = `scaleX(${scale})`;
                barEl.style.backgroundColor = `hsla(${hue}, 80%, ${50 + value * 15}%, ${0.5 + value * 0.5})`;

                // Peak hold with gravity
                if (value > peaks[i]) {
                    peaks[i] = value;
                    peakVelocity[i] = 0;
                } else {
                    peakVelocity[i] += 0.002; // gravity
                    peaks[i] = Math.max(0, peaks[i] - peakVelocity[i]);
                }
                const peakPos = Math.max(0.06, peaks[i]);
                peakEl.style.left = `${peakPos * 100}%`;
                peakEl.style.backgroundColor = `hsla(${hue}, 90%, 75%, ${0.6 + peaks[i] * 0.4})`;
                peakEl.style.boxShadow = `0 0 4px hsla(${hue}, 90%, 70%, ${peaks[i] * 0.5})`;
            }
        }
        drawEqualizer();
    }
}

function stopSidebarVisualizer() {
    if (sidebarVizAnimFrame) {
        cancelAnimationFrame(sidebarVizAnimFrame);
        sidebarVizAnimFrame = null;
    }
    const container = document.getElementById('sidebar-visualizer');
    if (container) {
        container.classList.remove('active');
    }
}

// Listen for visualizer type changes in settings — use isPlaying (not wasRunning)
// so switching from 'none' to a real type while music plays starts the visualizer
document.addEventListener('change', (e) => {
    if (e.target.id === 'sidebar-visualizer-type') {
        const newType = e.target.value;
        stopSidebarVisualizer();
        _sidebarVizBuiltType = null; // force rebuild for new type
        sidebarVisualizerType = newType;
        if (isPlaying && newType !== 'none') {
            npInitVisualizer();
            startSidebarVisualizer();
        }
    }
});

// ===============================
// RADIO MODE
// ===============================

// Map a /api/library/radio row into a queue entry (shared by the seeded
// refill fetch and the Library Radio starter).
function npMapRadioTrack(t) {
    return {
        title: t.title || 'Unknown Track',
        artist: t.artist || 'Unknown Artist',
        album: t.album || 'Unknown Album',
        file_path: t.file_path,
        filename: t.file_path,
        is_library: true,
        image_url: t.image_url || null,
        id: t.id,
        artist_id: t.artist_id,
        album_id: t.album_id,
        bitrate: t.bitrate,
        sample_rate: t.sample_rate
    };
}

// Library Radio: a seedless station across the WHOLE library (ranked-random
// server side — popularity nudges, not pure noise). Entry point is the Radio
// button on the library page. Once the first batch plays, refills go through
// the normal seeded radio path (each playing track has a library id).
async function startLibraryRadio() {
    try {
        const resp = await fetch('/api/library/radio?library=1&limit=50');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (!data.success || !data.tracks || data.tracks.length === 0) {
            showToast('No playable library tracks found for radio', 'error');
            return;
        }
        // Fresh station: replace the queue + any prior radio state, exactly
        // like startArtistRadioById does.
        npCancelCrossfade();
        npRadioMode = false;
        clearQueue();
        if (audioPlayer && !audioPlayer.paused) audioPlayer.pause();
        npQueue = data.tracks.map(npMapRadioTrack);
        renderNpQueue();
        // Context BEFORE enabling radio — npSetRadioMode keeps a specific
        // "<X> Radio" label when one is already set.
        npSetPlayContext('Shuffle your library');
        npSetRadioMode(true, { toast: false });
        await playQueueItem(0);
        showToast('Shuffling your whole library', 'success');
    } catch (e) {
        console.warn('Library radio failed:', e);
        showToast(`Couldn't shuffle your library: ${e.message}`, 'error');
    }
}
window.startLibraryRadio = startLibraryRadio;

// Play an acquisition-aware track list. Owned rows start immediately; missing
// rows enter the same queue and are downloaded, verified and imported ahead of
// playback. Radio mode stays off because a playlist still has a fixed end.
async function playTrackList(tracks, contextName, options = {}) {
    if (options.isCurrent && !options.isCurrent()) return { status: 'superseded' };
    var list = (tracks || []).filter(function (t) {
        if (!t) return false;
        if (t.file_path) return true;
        const title = t.title || t.name;
        const firstArtist = Array.isArray(t.artists) ? t.artists[0] : null;
        const artist = t.artist || t.artist_name || (typeof firstArtist === 'object' ? firstArtist?.name : firstArtist);
        return Boolean(title && artist);
    });
    if (!list.length) {
        showToast('This list has no usable track metadata', 'info');
        return { status: 'empty' };
    }
    window.cancelPendingPlayback();
    npCancelCrossfade();
    npRadioMode = false;
    clearQueue();
    if (audioPlayer && !audioPlayer.paused) audioPlayer.pause();
    npQueue = npPrepareQueueTracks(list);
    renderNpQueue();
    npSetPlayContext(contextName || 'Playlist');
    npScheduleQueuePrefetch();
    // a set's row Play (34b): the whole set queued, from that row
    const start = Number.isInteger(options.startIndex) ? Math.max(0, Math.min(options.startIndex, npQueue.length - 1)) : 0;
    return await playQueueItem(start, options);
}
window.playTrackList = playTrackList;

async function npFetchRadioTracks(forceAdvance = false) {
    // forceAdvance: a manual skip at the tail of the fetched batch (next
    // button / 'n' key) — the user asked for the next track, so advance as
    // soon as the new batch lands even though something is still playing.
    if (!currentTrack || !currentTrack.id) return;
    try {
        npLoadingQueueItem = true;
        const excludeIds = npRecentlyPlayedIds.join(',');
        const resp = await fetch(`/api/library/radio?track_id=${currentTrack.id}&limit=50&exclude=${encodeURIComponent(excludeIds)}`);
        if (!resp.ok) {
            console.warn('Radio endpoint returned', resp.status);
            npLoadingQueueItem = false;
            return;
        }
        const data = await resp.json();
        // Bail if radio was toggled off during the fetch
        if (!npRadioMode) { npLoadingQueueItem = false; return; }
        if (data.tracks && data.tracks.length > 0) {
            data.tracks.forEach(t => { npQueue.push(npMapRadioTrack(t)); });
            showToast(`Radio: Added ${data.tracks.length} similar tracks`, 'success');
            renderNpQueue();
            updateNpPrevNextButtons();
            npLoadingQueueItem = false;
            // Advance when idle (triggered by onAudioEnded) or when the user
            // explicitly skipped at the batch tail (forceAdvance).
            if (!isPlaying || forceAdvance) {
                playNextInQueue();
            }
        } else {
            showToast('Radio: No similar tracks found', 'info');
            npLoadingQueueItem = false;
        }
    } catch (e) {
        console.warn('Radio fetch error:', e);
        npLoadingQueueItem = false;
    }
}

// Media Session API
function initMediaSession() {
    if (!('mediaSession' in navigator)) return;

    navigator.mediaSession.setActionHandler('play', () => {
        if (audioPlayer && currentTrack) {
            audioPlayer.play().then(() => setPlayingState(true));
        }
    });
    navigator.mediaSession.setActionHandler('pause', () => {
        if (audioPlayer) {
            audioPlayer.pause();
            setPlayingState(false);
        }
    });
    navigator.mediaSession.setActionHandler('stop', () => {
        handleStop();
    });
    navigator.mediaSession.setActionHandler('seekbackward', () => {
        if (audioPlayer && audioPlayer.duration) {
            audioPlayer.currentTime = Math.max(0, audioPlayer.currentTime - 10);
        }
    });
    navigator.mediaSession.setActionHandler('seekforward', () => {
        if (audioPlayer && audioPlayer.duration) {
            audioPlayer.currentTime = Math.min(audioPlayer.duration, audioPlayer.currentTime + 10);
        }
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => {
        if (npQueue.length > 0) playPreviousInQueue();
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => {
        if (npQueue.length > 0) playNextInQueue();
    });
    // Scrub from the lock screen / notification scrubber.
    try {
        navigator.mediaSession.setActionHandler('seekto', (details) => {
            if (!audioPlayer || !isFinite(audioPlayer.duration)) return;
            if (details.fastSeek && 'fastSeek' in audioPlayer) {
                audioPlayer.fastSeek(details.seekTime);
            } else if (typeof details.seekTime === 'number') {
                audioPlayer.currentTime = details.seekTime;
            }
            updateMediaSessionPositionState();
        });
    } catch (e) { /* some browsers don't support seekto — handlers above still work */ }
}

// Log a SoulSync play once a track has been heard ~10s — feeds 'recently
// played' + smart-radio recency. 10s is a "play" for SoulSync's own stats,
// but it is NOT a scrobble: the row only becomes scrobble-eligible via
// npMaybeMarkScrobbleEligible once the Last.fm threshold is reached.
let npPlayLogged = false;
let npPlayId = null;
let npPlayGeneration = 0;
function npMaybeLogPlay() {
    if (npPlayLogged || !currentTrack || !audioPlayer) return;
    // a 30s clip isn't a listen: it would land in recently played and
    // smart-radio recency for a song nobody heard
    if (currentTrack.is_preview) return;
    // an episode, a sample or a radio stream isn't a music listen either
    if (currentTrack.kind && currentTrack.kind !== 'library' && currentTrack.kind !== 'stream') return;
    if (!isFinite(audioPlayer.currentTime) || audioPlayer.currentTime < 10) return;
    npPlayLogged = true;   // set first so a slow request can't double-fire
    const gen = npPlayGeneration;   // a late response for a skipped track must not claim this track's id
    try {
        fetch('/api/library/log-play', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                track: {
                    id: currentTrack.id,
                    title: currentTrack.title,
                    artist: currentTrack.artist,
                    album: currentTrack.album,
                },
                duration_ms: Math.round((audioPlayer.duration || 0) * 1000),
            }),
        }).then(r => (r && r.ok) ? r.json() : null)
          .then(d => { if (d && d.play_id != null && gen === npPlayGeneration) npPlayId = d.play_id; })
          .catch(() => {});   // fire-and-forget; logging must never affect playback
    } catch (e) { /* non-fatal */ }
}

// Mark the current play scrobble-eligible once it satisfies the Last.fm rule:
// played for at least half the track's duration or 4 minutes, whichever comes
// first (tracks of 30s or less never scrobble). Unknown durations (streams)
// fall back to the 4-minute cap. Seeking past the threshold counts — this is
// a heuristic for "actually listened", not an audit.
let npScrobbleEligibleSent = false;
function npMaybeMarkScrobbleEligible() {
    if (npScrobbleEligibleSent || npPlayId == null || !currentTrack || !audioPlayer) return;
    const dur = audioPlayer.duration;
    const effectiveDur = (isFinite(dur) && dur > 0) ? dur : Infinity;
    if (effectiveDur <= 30) return;
    if (!isFinite(audioPlayer.currentTime)) return;
    if (audioPlayer.currentTime < Math.min(effectiveDur / 2, 240)) return;
    npScrobbleEligibleSent = true;   // set first so a slow request can't double-fire
    try {
        fetch('/api/library/log-play/eligible', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ play_id: npPlayId }),
        }).catch(() => {});   // fire-and-forget; scrobbling must never affect playback
    } catch (e) { /* non-fatal */ }
}

// timeupdate fires ~4x/s; only push position to the OS ~1x/s.
let _npPosStateLast = 0;
function npThrottledPositionState() {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (now - _npPosStateLast < 950) return;
    _npPosStateLast = now;
    updateMediaSessionPositionState();
}

// Feeds the lock-screen scrubber its progress (elapsed / duration / rate).
// Without this the OS shows a dead, position-less media control.
function updateMediaSessionPositionState() {
    if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;
    if (!audioPlayer || !isFinite(audioPlayer.duration) || audioPlayer.duration <= 0) return;
    try {
        navigator.mediaSession.setPositionState({
            duration: audioPlayer.duration,
            playbackRate: audioPlayer.playbackRate || 1,
            position: Math.min(audioPlayer.currentTime, audioPlayer.duration),
        });
    } catch (e) { /* invalid state (e.g. mid-load) — skip this tick */ }
}

function updateMediaSessionMetadata() {
    if (!('mediaSession' in navigator) || !currentTrack) return;
    const artwork = [];
    const artUrl = getNpAlbumArtUrl();
    if (artUrl) artwork.push({ src: artUrl, sizes: '512x512', type: 'image/jpeg' });

    navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.title || 'Unknown Track',
        artist: currentTrack.artist || 'Unknown Artist',
        album: currentTrack.album || 'Unknown Album',
        artwork: artwork
    });
}

function updateMediaSessionPlaybackState() {
    if (!('mediaSession' in navigator)) return;
    if (!currentTrack) {
        navigator.mediaSession.playbackState = 'none';
    } else {
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }
}

// ===============================
// PODCAST AND AUDIOBOOK PROGRESS (HANDOFF 46)
// ===============================

// Where each profile got to in an episode or an audiobook, kept on the server
// (core/playback/spoken.py, through /api/player/progress): saved every 15 s
// while it plays, on pause, at the end, when another item takes over and when
// the page closes; read back when the item plays again, which then starts
// there (a finished one starts from the top). A play is logged once an item
// has played 10 s (/api/player/plays) for Listening history and Recent. None
// of it goes near listening_history or scrobbling, which stay music only.
const NP_SPOKEN_SAVE_EVERY_MS = 15000;
let npSpokenSnap = null;      // {kind, media_id, position, duration} of what's playing
let npSpokenLastSave = 0;
let npSpokenPlayLogged = false;

function npSpokenKey(track) {
    return track && npIsSpokenWord(track) && track.media_id ? track.media_id : null;
}

function npSpokenDuration() {
    if (audioPlayer && isFinite(audioPlayer.duration) && audioPlayer.duration > 0) return audioPlayer.duration;
    const hint = currentTrack && Number(currentTrack.duration);
    return hint > 0 ? hint : null;
}

// Read the element into the snapshot. A load resets the position to 0 (and
// a switch empties src), so a zero or a missing source never overwrites it.
function npSpokenRead() {
    if (!audioPlayer || !npSpokenKey(currentTrack)) return false;
    const pos = audioPlayer.currentTime;
    if (!audioPlayer.currentSrc || !isFinite(pos) || pos <= 0) return false;
    npSpokenSnap = {
        kind: currentTrack.kind,
        media_id: currentTrack.media_id,
        position: pos,
        duration: npSpokenDuration(),
    };
    return true;
}

function npSpokenSend(snap, ended, beacon) {
    if (!snap) return;
    const body = JSON.stringify({
        kind: snap.kind,
        media_id: snap.media_id,
        position_s: Math.round(snap.position * 10) / 10,
        duration_s: snap.duration ? Math.round(snap.duration * 10) / 10 : null,
        ended: Boolean(ended),
    });
    try {
        if (beacon && navigator.sendBeacon) {
            navigator.sendBeacon('/api/player/progress', new Blob([body], { type: 'application/json' }));
            return;
        }
        fetch('/api/player/progress', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body,
            keepalive: true,
        }).catch(() => {});   // bookkeeping must never affect playback
    } catch (e) { /* non-fatal */ }
}

function npSpokenTick() {
    if (!npSpokenRead()) return;
    if (!npSpokenPlayLogged && npSpokenSnap.position >= 10) {
        npSpokenPlayLogged = true;
        npSpokenLogPlay(currentTrack);
    }
    const now = Date.now();
    if (now - npSpokenLastSave >= NP_SPOKEN_SAVE_EVERY_MS) {
        npSpokenLastSave = now;
        npSpokenSend(npSpokenSnap, false);
    }
}

function npSpokenOnPause() {
    if (!npSpokenKey(currentTrack) || (audioPlayer && audioPlayer.ended)) return;
    npSpokenRead();
    if (npSpokenSnap && npSpokenSnap.media_id === currentTrack.media_id) {
        npSpokenLastSave = Date.now();
        npSpokenSend(npSpokenSnap, false);
    }
}

function npSpokenOnEnded() {
    if (!npSpokenKey(currentTrack)) return;
    const duration = npSpokenDuration();
    npSpokenSnap = {
        kind: currentTrack.kind,
        media_id: currentTrack.media_id,
        position: duration || (npSpokenSnap ? npSpokenSnap.position : 0),
        duration,
    };
    npSpokenSend(npSpokenSnap, true);
}

// Another item is taking over: keep where this one got to.
function npSpokenLeave(next) {
    if (npSpokenSnap && (!next || next.media_id !== npSpokenSnap.media_id)) {
        npSpokenSend(npSpokenSnap, false);
        npSpokenSnap = null;
    }
    if (!next || !currentTrack || next.media_id !== currentTrack.media_id) {
        npSpokenPlayLogged = false;
        npSpokenLastSave = 0;
    }
}

function npSpokenLogPlay(track) {
    try {
        fetch('/api/player/plays', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                kind: track.kind,
                media_id: track.media_id,
                title: track.title,
                subtitle: track.artist || '',
                art_url: track.image_url || null,
                src: track.media_src || null,
                duration_s: npSpokenDuration(),
            }),
        }).catch(() => {});
    } catch (e) { /* non-fatal */ }
}

function npFormatResume(seconds) {
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// Where this profile left an episode or a book (0 for the top). Waits at most
// 2.5 s: playback never hangs on the bookkeeping.
async function npSpokenResumeAt(track) {
    if (!npSpokenKey(track)) return 0;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 2500) : null;
    try {
        // a POST: an episode's id is often its whole address, too long for a query
        const res = await fetch('/api/player/progress/lookup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: track.kind, ids: [track.media_id] }),
            signal: ctrl ? ctrl.signal : undefined,
        });
        if (!res || !res.ok) return 0;
        const body = await res.json();
        const row = body && body.items ? body.items[track.media_id] : null;
        const at = row ? Number(row.resume_at) || 0 : 0;
        if (at > 0) {
            npSpokenSnap = { kind: track.kind, media_id: track.media_id, position: at, duration: row.duration_s || null };
            if (typeof showToast === 'function') showToast(`Picking up where you left off, at ${npFormatResume(at)}`, 'info');
        }
        return at;
    } catch (e) {
        return 0;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// The page is closing or going to the background: keep the place now.
function npSpokenOnHide() {
    if (!npSpokenKey(currentTrack)) return;
    npSpokenRead();
    if (npSpokenSnap) npSpokenSend(npSpokenSnap, false, true);
}
window.addEventListener('pagehide', npSpokenOnHide);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') npSpokenOnHide();
});

// ===============================
// PODCASTS AND AUDIOBOOKS
// ===============================

// Play a podcast episode or an audiobook sample in the app's one player.
// It goes in the queue right after what's playing and starts; the same
// episode again is play / pause. item: {kind: 'podcast'|'audiobook', id, src,
// title, subtitle, album, artUrl, durationHint, chapters, chaptersUrl}.
async function npPlayMedia(item) {
    if (typeof npAutomixStop === 'function') npAutomixStop();
    if (!item || !item.src) return { status: 'empty' };
    if (currentTrack && currentTrack.media_id && item.id && currentTrack.media_id === item.id
            && audioPlayer && audioPlayer.src) {
        togglePlayback();
        return { status: 'toggled' };
    }
    window.cancelPendingPlayback();
    npCancelCrossfade();
    const entry = npPrepareQueueTrack({
        title: item.title || 'Untitled',
        artist: item.subtitle || '',
        album: item.album || item.subtitle || '',
        kind: item.kind === 'audiobook' ? 'audiobook' : 'podcast',
        media_id: item.id || item.src,
        media_src: item.src,
        image_url: item.artUrl || null,
        duration: Number(item.durationHint) || null,
        chapters: Array.isArray(item.chapters) ? item.chapters : null,
        chapters_url: item.chaptersUrl || null,
    });
    const at = npQueueIndex >= 0 ? npQueueIndex + 1 : npQueue.length;
    npQueue.splice(at, 0, entry);
    renderNpQueue();
    return await playQueueItem(at);
}
window.playMedia = npPlayMedia;

// ===============================
// INTERNET RADIO (build e)
// ===============================

// Play a station in the app's player without touching the queue: radio
// replaces what's playing, and stopping it leaves the queue as it was.
// item: {id, src, title, subtitle, artUrl, radio: {station_id, session_id,
// mode, ...}, crossOrigin, quiet}. A direct stream needs crossOrigin, since
// the player's audio runs through the Web Audio graph (EQ, visuals), which
// stays silent for another site's audio without it.
async function npPlayRadio(item) {
    if (typeof npAutomixStop === 'function') npAutomixStop();
    if (!item || !item.src || !audioPlayer) return { status: 'empty' };
    window.cancelPendingPlayback();
    npCancelCrossfade();
    const generation = npPlaybackGeneration;
    const signal = npPlaybackAbort.signal;
    const isCurrent = () => generation === npPlaybackGeneration && !signal.aborted;
    await stopStream();
    if (!isCurrent()) return { status: 'superseded' };
    setTrackInfo({
        title: item.title || 'Radio',
        artist: item.subtitle || '',
        album: '',
        filename: '',
        is_library: false,
        kind: 'radio',
        media_id: item.id || item.src,
        media_src: item.src,
        image_url: item.artUrl || null,
        duration: null,
        radio: item.radio || null,
    });
    showLoadingAnimation();
    audioPlayer.loop = false;
    if (item.crossOrigin) audioPlayer.crossOrigin = 'anonymous';
    else if (audioPlayer.crossOrigin) audioPlayer.crossOrigin = null;
    const playback = await startAudioPlayback(isCurrent, signal, null, item.src,
        { quiet: !!item.quiet, cors: !!item.crossOrigin });
    if (playback?.status !== 'played') {
        if (playback?.status !== 'superseded' && item.quiet) hideLoadingAnimation();
        return playback || { status: 'failed' };
    }
    return { status: 'played' };
}

// Update what the player shows for the station (the radio session calls this
// when what's playing changes): the title and the line under it.
function npUpdateRadioInfo(info) {
    if (!currentTrack || currentTrack.kind !== 'radio' || !info) return;
    if (info.title !== undefined) currentTrack.title = info.title;
    if (info.subtitle !== undefined) currentTrack.artist = info.subtitle;
    if (info.radio) currentTrack.radio = { ...(currentTrack.radio || {}), ...info.radio };
    updateMediaSessionMetadata();
    npNotify('track');
}

// Skip back or forward by seconds (the spoken-word −15 s / +30 s).
function npSkip(seconds) {
    if (!audioPlayer || !audioPlayer.duration || !isFinite(audioPlayer.duration)) return;
    npSeek(audioPlayer.currentTime + Number(seconds || 0));
}

// ===============================
// THE PLAYER'S API (for src/shell/player.ts and the pages)
// ===============================

function npLoadingSnapshot() {
    const el = document.getElementById('loading-animation');
    if (!el) return { active: false, text: '', progress: 0 };
    const text = (el.querySelector('.loading-text')?.textContent || '').trim();
    const width = parseFloat(el.querySelector('.loading-progress')?.style.width || '0') || 0;
    return { active: !el.classList.contains('hidden'), text, progress: width };
}

/** Up next's Playing button: "Pause X" while it plays, "Resume X" while paused (gauntlet review L2). */
function npQueuePlayingLabel(button) {
    const title = button.dataset.title || 'track';
    button.setAttribute('aria-label', isPlaying ? `Pause ${title}` : `Resume ${title}`);
    button.title = isPlaying ? 'Playing · press to pause' : 'Paused · press to play';
}
window.addEventListener('ss:player', () => {
    document.querySelectorAll('.np-queue-item-playnow[data-kind="playing"]').forEach(npQueuePlayingLabel);
});

window.SoulSyncPlayer = {
    /** Everything the chrome draws, read fresh each time. */
    state() {
        return {
            track: currentTrack,
            kind: npTrackKind(currentTrack),
            playing: Boolean(isPlaying),
            buffering: npBuffering,
            loading: npLoadingSnapshot(),
            queue: npQueue,
            index: npQueueIndex,
            canPrevious: npCanPrev,
            canNext: npCanNext,
            shuffle: npShuffleOn,
            repeat: npRepeatMode,
            radio: npRadioMode,
            autoDownload: npAutoDownloadQueue,
            crossfade: npCrossfadeOn,
            crossfadeSeconds: npCrossfadeSeconds(),
            between: npBetweenTracks(),
            crossfading: npXfadeActive,
            playbackRate: audioPlayer ? audioPlayer.playbackRate : 1,
            context: npPlayContext,
            volume: npVolumePercent,
            muted: npMuted,
            sleep: npSleepEndOfTrack ? 'track' : npSleepMinutes,
            // the ended track's next is owed (auto-mix's last line of defence)
            advanceOwed: npAdvanceOwed,
            sleepEndsAt: npSleepEndsAt,
            sleepSteps: NP_SLEEP_STEPS.slice(),
            lyrics: { synced: _npLyricsState.synced, lines: _npLyricsState.lines.length, loading: _npLyricsState.fetchInFlight,
                status: (document.getElementById('np-lyrics-status')?.textContent || '').trim() },
            reportable: npIsReportableTrack(currentTrack),
            playlistTrack: npAddToPlaylistTrack(currentTrack),
        };
    },
    audio() { return audioPlayer; },
    /** what an output device has to be set on: both elements and the audio graph */
    outputTargets() {
        return {
            elements: [audioPlayer, document.getElementById('audio-player-xfade')].filter(Boolean),
            context: npAudioContext,
        };
    },
    analyser() { return npAnalyser; },
    /** The player's audio graph, made now if it isn't yet: the two-deck
     * engine (auto-mix) plays on this context and into this analyser, so
     * the visualisers see the mix and the output device applies to it. */
    audioGraph() {
        npInitVisualizer();
        npEnsureAudioContextRunning();
        return npAudioContext && npAnalyser ? { context: npAudioContext, analyser: npAnalyser } : null;
    },
    toggle: () => togglePlayback(),
    stop: () => handleStop(),
    next: () => playNextInQueue(),
    previous: () => playPreviousInQueue(),
    seek: (seconds) => npSeek(seconds),
    skip: (seconds) => npSkip(seconds),
    setVolume: (percent) => npSetVolume(percent),
    toggleMute: () => handleNpMuteToggle(),
    toggleShuffle: () => handleNpShuffle(),
    cycleRepeat: () => handleNpRepeat(),
    playIndex: (index, options) => playQueueItem(index, options || {}),
    /** auto-mix: put a track straight after the playing one, quietly; its index */
    insertNext(track) {
        const at = Math.max(0, npQueueIndex + 1);
        npQueue.splice(at, 0, npPrepareQueueTrack(track));
        renderNpQueue();   // saves the queue and says so ('queue')
        updateNpPrevNextButtons();
        npPersistQueue();
        return at;
    },
    /** auto-mix: move a queued row to straight after the playing one; its index */
    moveNext(index) { return npMoveNext(index); },
    /** a set played as a mix from the playing track: its later rows next, each once */
    queueAfterPlaying(tracks) { return npQueueAfterPlaying(tracks); },
    /** Up next again (auto-mix's chips changed, or the setting) */
    renderQueue: () => renderNpQueue(),
    persistQueue: () => npPersistQueue(),
    remove: (index) => removeFromQueue(index),
    move: (from, to) => npReorderQueue(from, to),
    clearQueue: () => clearQueue(),
    setRadio: (on) => npSetRadioMode(on, { fetchIfNeeded: true }),
    setAutoDownload: (on) => npSetAutoDownload(on),
    setCrossfade: (on) => npSetCrossfade(on),
    setSleep: (value) => npSetSleepTimer(value),
    playMedia: (item) => npPlayMedia(item),
    playRadio: (item) => npPlayRadio(item),
    updateRadio: (info) => npUpdateRadioInfo(info),
    playNext: (track) => playNext(track),
    addToQueue: (track) => addToQueue(track),
    /** the chrome tells the engine when the tray opens or closes */
    setExpanded(open) { npModalOpen = Boolean(open); },
};
