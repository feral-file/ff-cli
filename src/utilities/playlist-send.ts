import chalk from 'chalk';
import { isPlaylistSourceUrl, loadPlaylistSource } from './playlist-source';

interface PlaylistSendConfirmation {
  success: boolean;
  filePath: string;
  fileExists: boolean;
  playlistValid: boolean;
  playlist?: Record<string, unknown>;
  deviceName?: string;
  error?: string;
  message?: string;
  needsDeviceSelection?: boolean;
  availableDevices?: Array<{ name: string; host: string }>;
}

/**
 * Get available FF1 devices from config
 *
 * @returns {Promise<Array>} Array of device objects
 */
async function getAvailableDevices(): Promise<Array<{ name: string; host: string }>> {
  try {
    const configModule = (await import('../config.js')) as typeof import('../config.js') & {
      default?: {
        getFF1DeviceConfig?: () => { devices?: Array<{ name?: string; host?: string }> };
      };
    };
    const getFF1DeviceConfig =
      configModule.getFF1DeviceConfig ||
      (configModule.default && configModule.default.getFF1DeviceConfig) ||
      configModule.default;

    if (typeof getFF1DeviceConfig !== 'function') {
      return [];
    }

    const deviceConfig = getFF1DeviceConfig();

    if (deviceConfig.devices && Array.isArray(deviceConfig.devices)) {
      return deviceConfig.devices
        .filter((d) => d && d.host)
        .map((d) => ({
          name: d.name || d.host,
          host: d.host,
        }));
    }
  } catch (error) {
    if (process.env.DEBUG) {
      console.log(chalk.dim(`[DEBUG] Error loading devices: ${(error as Error).message}`));
    }
    // Silently fail if config can't be loaded
  }

  return [];
}

/**
 * Confirm playlist file path and validate the playlist
 *
 * Reads the playlist file, runs parse/structure validation (same as `validate`),
 * and returns confirmation result for user review. Does not verify signatures.
 *
 * @param {string} filePath - Playlist file path or URL
 * @param {string} [deviceName] - Device name (optional)
 * @returns {Promise<PlaylistSendConfirmation>} Validation result
 */
export async function confirmPlaylistForSending(
  filePath: string,
  deviceName?: string
): Promise<PlaylistSendConfirmation> {
  const defaultPath = './playlist.json';
  const resolvedPath = filePath || defaultPath;

  // Convert string "null" to undefined (in case model passes it literally)
  const actualDeviceName = deviceName === 'null' || deviceName === '' ? undefined : deviceName;

  if (process.env.DEBUG) {
    console.error(
      chalk.dim(
        `[DEBUG] confirmPlaylistForSending called with: filePath="${filePath}", deviceName="${deviceName}" -> "${actualDeviceName}"`
      )
    );
  }

  try {
    // Load playlist from file or URL
    console.log(chalk.cyan(`Playlist source: ${resolvedPath}`));

    let playlist: Record<string, unknown> | undefined;
    let fileExists = false;
    let loadedFrom: 'file' | 'url' = 'file';

    try {
      const loaded = await loadPlaylistSource(resolvedPath);
      playlist = loaded.playlist as Record<string, unknown>;
      fileExists = loaded.sourceType === 'file';
      loadedFrom = loaded.sourceType;
      console.log(chalk.green(`Loaded from ${loadedFrom}: ${resolvedPath}`));
    } catch (error) {
      const message = (error as Error).message;
      const isUrl = isPlaylistSourceUrl(resolvedPath);

      if (isUrl) {
        return {
          success: false,
          filePath: resolvedPath,
          fileExists: false,
          playlistValid: false,
          error: `Could not load playlist URL: ${resolvedPath}`,
          message: `${message}\n\nHint:\n  • Check the URL is reachable\n  • Confirm it returns JSON\n  • Use "send ./path/to/playlist.json" for local files`,
        };
      }

      if (message.includes('Invalid JSON in')) {
        return {
          success: false,
          filePath: resolvedPath,
          fileExists: true,
          playlistValid: false,
          error: message,
          message: `${message}\n\nHint:\n  • Check the JSON payload is valid DP-1 format\n  • Check local path points to a playlist file`,
        };
      }

      return {
        success: false,
        filePath: resolvedPath,
        fileExists: false,
        playlistValid: false,
        error: `Playlist file not found at ${resolvedPath}`,
        message: `Could not find playlist file. Try:\n  • Run a playlist build first\n  • Check the file path is correct\n  • Use "send ./path/to/playlist.json"`,
      };
    }

    if (!playlist) {
      return {
        success: false,
        filePath: resolvedPath,
        fileExists,
        playlistValid: false,
        error: `Playlist source is empty: ${loadedFrom}`,
      };
    }

    // Parse / structure validation only (same as `validate`; use `verify` CLI for signatures)
    console.log(chalk.cyan('Validation'));

    // Dynamic import to avoid circular dependency
    const { validatePlaylist } = await import('./playlist-verifier.js');
    const validateResult = await validatePlaylist(playlist);

    if (!validateResult.valid) {
      console.log(chalk.red('Playlist validation failed'));
      const detailLines =
        validateResult.details?.map((d) => `  • ${d.path}: ${d.message}`).join('\n') ||
        validateResult.error;
      const detailPaths = validateResult.details?.map((d) => d.path) || [];
      const hints: string[] = [];

      if (detailPaths.some((path) => path.includes('signature'))) {
        hints.push(
          'Add `playlist.privateKey` (or `PLAYLIST_PRIVATE_KEY`) and rebuild the playlist to include signatures.'
        );
      }

      if (detailPaths.some((path) => path.includes('defaults.display.margin'))) {
        hints.push('Rebuild the playlist with the latest CLI defaults (margin must be numeric).');
      }

      const hintText =
        hints.length > 0 ? `\n\nHint:\n${hints.map((h) => `  • ${h}`).join('\n')}` : '';

      return {
        success: false,
        filePath: resolvedPath,
        fileExists: true,
        playlistValid: false,
        playlist,
        deviceName: actualDeviceName,
        error: `Playlist is invalid: ${validateResult.error}`,
        message: `This playlist doesn't match DP-1 specification.\n\nErrors:\n${detailLines}${hintText}`,
      };
    }

    console.log(chalk.green('Valid DP-1 playlist'));

    // Display confirmation details
    const itemCount = (playlist.items as unknown[])?.length || 0;
    const title = (playlist.title as string) || 'Untitled';

    // Handle device selection
    let selectedDevice = actualDeviceName;
    let needsDeviceSelection = false;
    let availableDevices: Array<{ name: string; host: string }> = [];

    if (!selectedDevice) {
      // Get available devices
      availableDevices = await getAvailableDevices();

      if (process.env.DEBUG) {
        console.error(chalk.dim(`[DEBUG] selectedDevice is null/undefined`));
        console.error(chalk.dim(`[DEBUG] Available devices found: ${availableDevices.length}`));
        availableDevices.forEach((d) => {
          console.error(chalk.dim(`[DEBUG] Device: ${d.name} (${d.host})`));
        });
      }

      if (availableDevices.length === 0) {
        return {
          success: false,
          filePath: resolvedPath,
          fileExists: true,
          playlistValid: true,
          playlist,
          error: 'No FF1 devices configured',
          message: `No FF1 devices found in your configuration.\n\nPlease add devices to your config.json:\n{\n  "devices": [{\n    "name": "Living Room",\n    "host": "192.168.1.100"\n  }]\n}`,
        };
      } else if (availableDevices.length === 1) {
        // Auto-select single device
        selectedDevice = availableDevices[0].name || availableDevices[0].host;
        console.log(chalk.cyan(`Device: ${selectedDevice} (auto)`));
      } else {
        // Multiple devices - need user to choose
        needsDeviceSelection = true;
      }
    }

    console.log();
    console.log(chalk.bold('Send Summary'));
    console.log(chalk.dim(`  Title: ${title}`));
    console.log(chalk.dim(`  Items: ${itemCount}`));
    if (selectedDevice) {
      console.log(chalk.dim(`  Device: ${selectedDevice}`));
    } else if (availableDevices.length > 1) {
      console.log(chalk.dim('  Device: select one'));
    }
    console.log();

    // If multiple devices, return needsDeviceSelection flag
    if (needsDeviceSelection) {
      return {
        success: false,
        filePath: resolvedPath,
        fileExists: true,
        playlistValid: true,
        playlist,
        needsDeviceSelection: true,
        availableDevices,
        error: 'Multiple devices available - please choose one',
        message: `Which device would you like to display on?\n\nAvailable devices:\n${availableDevices.map((d, i) => `  ${i + 1}. ${d.name || d.host}`).join('\n')}\n\nSay: "send to [device name]" or "send to device 1"`,
      };
    }

    return {
      success: true,
      filePath: resolvedPath,
      fileExists: true,
      playlistValid: true,
      playlist,
      deviceName: selectedDevice,
      message: `Ready to send "${title}" (${itemCount} items) to ${selectedDevice}!`,
    };
  } catch (error) {
    const errorMsg = (error as Error).message;
    console.log(chalk.red(`Error: ${errorMsg}`));

    return {
      success: false,
      filePath: resolvedPath,
      fileExists: false,
      playlistValid: false,
      error: errorMsg,
    };
  }
}
