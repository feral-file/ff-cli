import chalk from 'chalk';
import { discoverFF1Devices } from '../../utilities/ff1-discovery';
import { findExistingDeviceEntry } from '../../utilities/device-lookup';
import { normalizeDeviceHost, normalizeDeviceIdToHost } from '../../utilities/device-normalize';

export interface DeviceDiscoverySelection {
  hostValue: string;
  discoveredName: string;
  /** mDNS device ID (e.g. 'ff1-hh9jsnoc'). Used to match a device when its host URL changes. */
  discoveredId?: string;
  /** Resolved IP addresses from mDNS. Used to match pre-id configs stored with an IP host. */
  discoveredAddresses?: string[];
  skipped: boolean;
}

/** Resolve manual input while retaining a stable ID for later relayer pairing. */
export function resolveManualDeviceInput(rawInput: string): DeviceDiscoverySelection {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { hostValue: '', discoveredName: '', skipped: false };
  }
  const lower = trimmed.toLowerCase();
  const looksLikeHost = lower.includes('.') || lower.includes(':') || lower.startsWith('http');
  const discoveredId = looksLikeHost
    ? undefined
    : (lower.startsWith('ff1-') ? lower : `ff1-${lower}`).toUpperCase();
  return {
    hostValue: normalizeDeviceIdToHost(trimmed),
    discoveredName: '',
    discoveredId,
    skipped: false,
  };
}

/**
 * Run mDNS discovery and prompt the user to pick a device, fall back to
 * manual entry, or skip when an existing device is already configured.
 *
 * Shared between `ff-cli setup` and `ff-cli device add` so both flows present
 * the same selection UX and matching rules.
 */
export async function discoverAndSelectDevice(
  ask: (question: string) => Promise<string>,
  existingDevices: Array<{ host: string; name?: string; id?: string }>,
  options?: { allowSkip?: boolean }
): Promise<DeviceDiscoverySelection> {
  const allowSkip = options?.allowSkip && existingDevices.length > 0;

  const discoveryResult = await discoverFF1Devices();
  const discoveredDevices = discoveryResult.devices;

  if (discoveryResult.error && discoveredDevices.length === 0) {
    const errorMessage = discoveryResult.error.endsWith('.')
      ? discoveryResult.error
      : `${discoveryResult.error}.`;
    console.log(chalk.dim(`mDNS discovery failed: ${errorMessage} Continuing with manual entry.`));
    console.log(
      chalk.dim(
        '  Tip: you can skip discovery entirely with ' +
          'ff-cli device add --host http://<device-ip>:1111 --name <name> --id FF1-XXXXXXXX'
      )
    );
  } else if (discoveryResult.error) {
    console.log(chalk.dim(`mDNS discovery warning: ${discoveryResult.error}`));
  }

  if (discoveredDevices.length > 0) {
    console.log(chalk.green('\nFF1 devices on your network:'));
    discoveredDevices.forEach((device, index) => {
      const displayId = device.id || device.name || device.host;
      const normalizedHost = normalizeDeviceHost(`${device.host}:${device.port}`);
      const alreadyConfigured = !!findExistingDeviceEntry(
        existingDevices,
        normalizedHost,
        device.name || device.id || '',
        device.id,
        device.addresses
      );
      const suffix = alreadyConfigured ? chalk.dim(' (already configured)') : '';
      console.log(chalk.dim(`  ${index + 1}) ${displayId}${suffix}`));
    });

    const skipHint = allowSkip ? ', press Enter to skip' : '';
    const prompt = `Select device [1-${discoveredDevices.length}], enter ID/host${skipHint}, or type m for manual entry: `;

    while (true) {
      const selectionAnswer = (await ask(prompt)).trim();

      if (!selectionAnswer) {
        if (allowSkip) {
          console.log(chalk.dim('Keeping existing devices.'));
          return { hostValue: '', discoveredName: '', skipped: true };
        }
        break;
      }

      const normalizedSelection = selectionAnswer.toLowerCase();
      if (normalizedSelection === 'm') {
        break;
      }

      const parsedIndex = Number.parseInt(selectionAnswer, 10);
      if (
        !Number.isNaN(parsedIndex) &&
        `${parsedIndex}` === selectionAnswer &&
        parsedIndex >= 1 &&
        parsedIndex <= discoveredDevices.length
      ) {
        const selected = discoveredDevices[parsedIndex - 1];
        return {
          hostValue: normalizeDeviceHost(`${selected.host}:${selected.port}`),
          discoveredName: selected.name || selected.id || '',
          discoveredId: selected.id,
          discoveredAddresses: selected.addresses,
          skipped: false,
        };
      }

      const normalizedWithPrefix = normalizedSelection.startsWith('ff1-')
        ? normalizedSelection
        : `ff1-${normalizedSelection}`;
      // Also normalize the answer as a URL-form host so pasted URLs like
      // "http://ff1-hh9jsnoc.local:1111" match the device's normalized host.
      let normalizedSelectionAsHost = '';
      try {
        normalizedSelectionAsHost = normalizeDeviceHost(selectionAnswer).toLowerCase();
      } catch {
        // not a valid URL — skip URL-form matching
      }
      const matched = discoveredDevices.find((device) => {
        const deviceNormalizedHost = normalizeDeviceHost(
          `${device.host}:${device.port}`
        ).toLowerCase();
        const candidates = [device.id, device.name, device.host, `${device.host}:${device.port}`]
          .filter((value): value is string => Boolean(value))
          .map((value) => value.toLowerCase());
        return (
          candidates.includes(normalizedSelection) ||
          candidates.includes(normalizedWithPrefix) ||
          (normalizedSelectionAsHost !== '' && normalizedSelectionAsHost === deviceNormalizedHost)
        );
      });

      if (matched) {
        return {
          hostValue: normalizeDeviceHost(`${matched.host}:${matched.port}`),
          discoveredName: matched.name || matched.id || '',
          discoveredId: matched.id,
          discoveredAddresses: matched.addresses,
          skipped: false,
        };
      }

      console.log(
        chalk.red('Invalid selection. Enter a number, m, or a discovered device ID/host.')
      );
    }
  } else if (!discoveryResult.error) {
    console.log(chalk.dim('No FF1 devices found via mDNS. Continuing with manual entry.'));
    // mDNS is best-effort and frequently fails across subnets (a common setup
    // with mesh routers that put wired and Wi-Fi clients on different /24s).
    // Point users at the reliable fallback.
    console.log(
      chalk.dim(
        '  Tip: mDNS often does not cross subnets. If the device is reachable by IP, ' +
          'add it directly: ff-cli device add --host http://<device-ip>:1111 ' +
          '--name <name> --id FF1-XXXXXXXX'
      )
    );
  }

  // Manual entry fallback
  const idAnswer = await ask('Device ID or host (e.g. ff1-ABCD1234): ');
  if (!idAnswer) {
    return { hostValue: '', discoveredName: '', skipped: false };
  }
  return resolveManualDeviceInput(idAnswer);
}
