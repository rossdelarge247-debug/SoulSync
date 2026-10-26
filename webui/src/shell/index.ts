/**
 * The shell bundle entry - the typed home for what used to be classic
 * scripts in webui/static. Built as a synchronous IIFE (vite.shell.config.ts
 * -> static/dist/shell.js) and loaded as a CLASSIC script tag in the same
 * slot the vanilla files occupied, because the modules ported here are
 * consumed by the remaining classic scripts and by inline onclick handlers -
 * both need the names on window before later scripts run, which a deferred
 * `type="module"` bundle cannot provide.
 *
 * Every port adds its module here and assigns its public names onto window.
 * The assignment list IS the compatibility contract - the census test pins it.
 */

import {
  canClearSpotifyPause,
  clearSpotifyPause,
  spotifyPauseView,
  TRY_AGAIN_NOTE,
} from '@/features/spotify-pause/spotify-pause';

import { initAiSettings, loadAiSettings, openAiSettings } from './ai-settings';
import { initAppearanceSettings, syncAppearanceSettings } from './appearance';
import {
  blockFromSearch,
  closeBlocklistModal,
  onBlocklistSearchInput,
  openBlocklistModal,
  switchBlocklistTab,
  unblockEntry,
} from './blocklist';
import { patchChatMessages } from './chat-morph';
import { refreshDiscoverInboxBadge, startDiscoverInboxBadge } from './discover-inbox-badge';
import {
  _handoffLibrarySearchToEnhancedSearch,
  _updateSidebarLibraryBreadcrumb,
  clearArtistDetailPageState,
  navigateToArtistDetail,
  playLibraryTrack,
} from './library-globals';
import {
  _mlmClose,
  _mlmDeleteMatch,
  _mlmLibraryDebounce,
  _mlmSaveMatch,
  _mlmSelectLibrary,
  _mlmSelectSource,
  _mlmSourceDebounce,
  openManualLibraryMatchTool,
} from './manual-library-match';
import {
  initModules,
  loadModulesSettings,
  moduleIsOff,
  noteModuleDisabled,
  openModulesSettings,
} from './modules';
import {
  connectMyAccount,
  closeMyAccountsModal,
  disconnectMyAccount,
  openMyAccountsModal,
  openPersonalSettings,
  saveMyAccountToken,
} from './my-accounts';
import { bootNavShell } from './nav-shell';
import {
  closeDownloadOriginsModal,
  deleteSelectedOriginEntries,
  removeSelectedOriginEntries,
  openDownloadOriginsModal,
  switchDownloadOriginTab,
  toggleAllOriginEntries,
  toggleOriginEntry,
  toggleOriginGroup,
} from './origin-history';
import './server-activity';
import { bootPlayer } from './player';
import { bootRadioChrome } from './player-radio';
import { bootPlayerStar } from './player-star';
import { initPlexSignIn } from './plex-signin';
import { bootRadioSession } from './radio-session';
import { initRadioSettings, loadRadioSettings, openRadioSettings } from './radio-settings';
import {
  closeServiceSwitchModal,
  openServiceSwitchModal,
  openServiceSwitchSettings,
  setActiveSource,
  switchServiceSwitchTab,
} from './service-switch';
import {
  bootSidebarWeather,
  getWeatherPreview,
  initSidebarWeather,
  setWeatherPreview,
  weatherPreviewPresets,
} from './sidebar-weather';
import { closeTrackDetail, openTrackDetail } from './track-detail';
import {
  closeWatchlistHistoryModal,
  openWatchlistHistoryModal,
  toggleWatchlistHistoryRun,
} from './watchlist-history';
import { initWeatherPreviewSettings } from './weather-preview-settings';

/** every name the rest of the app may reach through window. */
export const SHELL_WINDOW_EXPORTS = {
  // blocklist.js (ported aug 26)
  openBlocklistModal,
  closeBlocklistModal,
  switchBlocklistTab,
  onBlocklistSearchInput,
  blockFromSearch,
  unblockEntry,
  // origin-history.js (ported aug 26)
  openDownloadOriginsModal,
  closeDownloadOriginsModal,
  switchDownloadOriginTab,
  toggleOriginGroup,
  toggleOriginEntry,
  toggleAllOriginEntries,
  deleteSelectedOriginEntries,
  removeSelectedOriginEntries,
  // watchlist-history.js (ported aug 26)
  openWatchlistHistoryModal,
  closeWatchlistHistoryModal,
  toggleWatchlistHistoryRun,
  // my-accounts.js (ported aug 26)
  openMyAccountsModal,
  closeMyAccountsModal,
  connectMyAccount,
  saveMyAccountToken,
  disconnectMyAccount,
  // the old My Settings entry point, now the same modal
  openPersonalSettings,
  // service-switch.js (ported aug 26)
  openServiceSwitchModal,
  closeServiceSwitchModal,
  switchServiceSwitchTab,
  setActiveSource,
  openServiceSwitchSettings,
  // library-globals.js (ported aug 26; the state objects self-assign inside)
  navigateToArtistDetail,
  playLibraryTrack,
  clearArtistDetailPageState,
  _updateSidebarLibraryBreadcrumb,
  _handoffLibrarySearchToEnhancedSearch,
  // track-detail.js (ported aug 26)
  openTrackDetail,
  closeTrackDetail,
  // manual-library-match.js (ported aug 26)
  openManualLibraryMatchTool,
  _mlmClose,
  _mlmSourceDebounce,
  _mlmLibraryDebounce,
  _mlmSelectSource,
  _mlmSelectLibrary,
  _mlmSaveMatch,
  _mlmDeleteMatch,
  // server-activity.js (ported aug 26): self-assigns window.ServerActivity
  // chat.js renderMessages patches the list instead of rebuilding it (sept 24)
  patchChatMessages,
  // the Discover inbox badge (sept 26)
  refreshDiscoverInboxBadge,
  // the sidebar weather line + particle scene (oct 6)
  initSidebarWeather,
  // re-runnable boot, called from settings.js after a location/enabled change
  bootSidebarWeather,
  // settings > advanced > developer: preview any sky in this tab
  getWeatherPreview,
  setWeatherPreview,
  weatherPreviewPresets,
  // module switches (oct 21): settings > modules, the sidebar, module pages
  moduleIsOff,
  noteModuleDisabled,
  openModulesSettings,
  loadModulesSettings,
  // settings > appearance (oct 22): the accent cards; settings.js calls the
  // sync after it loads the saved accent
  syncAppearanceSettings,
  // settings > ai (the automation assistant): settings.js loads it when the
  // tab opens; the assistant panel's "Open Settings → AI" uses the other
  loadAiSettings,
  openAiSettings,
  loadRadioSettings,
  openRadioSettings,
  // the Spotify pause (oct 23): the same words, countdown and "Try again now"
  // for the rate-limit modal, the Settings card and the sidebar's service dot
  ssSpotifyPauseView: spotifyPauseView,
  ssClearSpotifyPause: clearSpotifyPause,
  ssCanClearSpotifyPause: canClearSpotifyPause,
  ssSpotifyTryAgainNote: TRY_AGAIN_NOTE,
} as const;

Object.assign(window, SHELL_WINDOW_EXPORTS);
// before DOMContentLoaded: the sidebar and #chat-page are parsed by now, and
// video-side.js reads moduleIsOff when it picks the side
initModules();
// the navigation shell (sidebar, top bar, tab bar): its markup is parsed too,
// and shell-bridge.js (loaded after this bundle) hands it the current page
bootNavShell();
startDiscoverInboxBadge();
initSidebarWeather();
const onReady = () => {
  // the player's bar and tray (board 6a) over media-player.js, which loaded
  // first; the radio session (window.SoulSyncRadio) and the player's radio
  // mode ride on it (build e)
  bootRadioSession();
  bootPlayer();
  // the star in the bar, the mini bar and the record (28c), and S
  bootPlayerStar();
  bootRadioChrome();
  initWeatherPreviewSettings();
  initAppearanceSettings();
  initAiSettings();
  initRadioSettings();
  void initPlexSignIn();
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', onReady, { once: true });
} else {
  onReady();
}
