import type { Noble, Peripheral } from '@stoprocent/noble';
import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { type AccessoryContext, type DeviceConfig, GardenaValveAccessory } from './accessory.js';
import { GardenaConnection } from './connection.js';
import { isGardenaAdvertisement } from './protocol.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

interface GardenaPlatformConfig extends PlatformConfig {
  devices?: DeviceConfig[];
  pollInterval?: number;
}

const DEFAULT_POLL_INTERVAL_SECONDS = 60;
const SCAN_WINDOW_MS = 30_000;
const RESCAN_INTERVAL_MS = 5 * 60_000;

/** Linux reports MAC addresses, macOS reports CoreBluetooth UUIDs. Compare either, ignoring separators. */
const normalizeAddress = (address: string) => address.replace(/[^0-9a-f]/gi, '').toLowerCase();

export class GardenaPlatform implements DynamicPlatformPlugin {
  private readonly cached = new Map<string, PlatformAccessory<AccessoryContext>>();
  /** Configured devices waiting to be seen in a scan, keyed by normalised address. */
  private readonly pending = new Map<string, GardenaValveAccessory>();
  private readonly handlers: GardenaValveAccessory[] = [];
  private readonly reported = new Set<string>();
  private readonly config: GardenaPlatformConfig;
  private rescanTimer?: NodeJS.Timeout;

  constructor(
    readonly log: Logging,
    config: PlatformConfig,
    readonly api: API,
  ) {
    this.config = config;
    api.on('didFinishLaunching', () => void this.start());
    api.on('shutdown', () => void this.shutdown());
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.cached.set(accessory.UUID, accessory as PlatformAccessory<AccessoryContext>);
  }

  private async start() {
    this.registerAccessories();

    let noble: Noble;
    try {
      noble = (await import('@stoprocent/noble')).default;
      await noble.waitForPoweredOnAsync(30_000);
    } catch (error) {
      this.log.error(`Bluetooth is unavailable: ${(error as Error).message}. See the README for adapter setup.`);
      return;
    }

    noble.on('discover', (peripheral: Peripheral) => this.onDiscover(peripheral));
    await this.scan(noble);
  }

  private registerAccessories() {
    const devices = this.config.devices ?? [];
    if (devices.length === 0) {
      this.log.warn('No devices configured. Scanning so you can find their addresses in the log.');
    }

    const keep = new Set<string>();
    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(normalizeAddress(device.address));
      keep.add(uuid);

      const cached = this.cached.get(uuid);
      const accessory =
        cached ??
        new this.api.platformAccessory<AccessoryContext>(
          device.name ?? 'Gardena Water Control',
          uuid,
          this.api.hap.Categories.SPRINKLER,
        );
      accessory.context = { ...accessory.context, device };
      if (device.name && accessory.displayName !== device.name) accessory.updateDisplayName(device.name);

      // The handler adds the HomeKit services, so it must exist before the accessory is published.
      const handler = new GardenaValveAccessory(this, accessory);
      if (cached) {
        this.api.updatePlatformAccessories([accessory]);
      } else {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
      this.handlers.push(handler);
      this.pending.set(normalizeAddress(device.address), handler);
    }

    const stale = [...this.cached.values()].filter((accessory) => !keep.has(accessory.UUID));
    if (stale.length > 0) this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
  }

  private onDiscover(peripheral: Peripheral) {
    const keys = [peripheral.address, peripheral.id].filter(Boolean).map(normalizeAddress);
    const key = keys.find((candidate) => this.pending.has(candidate));
    // A configured address is trusted even if this advert lacks the Gardena markers.
    if (!key && !isGardenaAdvertisement(peripheral.advertisement)) return;

    if (!this.reported.has(peripheral.id)) {
      this.reported.add(peripheral.id);
      const label = peripheral.address || peripheral.id;
      const name = peripheral.advertisement.localName ?? 'unnamed';
      this.log.info(`Found Gardena device "${name}" at ${label} (RSSI ${peripheral.rssi})${key ? '' : ', not configured'}`);
    }

    if (!key) return;
    const handler = this.pending.get(key)!;
    this.pending.delete(key);
    handler.attach(new GardenaConnection(peripheral), this.config.pollInterval ?? DEFAULT_POLL_INTERVAL_SECONDS);
  }

  /** Scan in short windows until every configured device has been seen. */
  private async scan(noble: Noble) {
    await noble.startScanningAsync([], false);
    await new Promise((resolve) => setTimeout(resolve, SCAN_WINDOW_MS));
    await noble.stopScanningAsync();

    if (!this.config.devices?.length) {
      this.log.info(
        this.reported.size > 0
          ? `Scan finished. Add an address from above to "devices" and restart.`
          : 'Scan finished without finding a Gardena device. Check it is in range and not connected to a phone.',
      );
    } else if (this.pending.size > 0) {
      this.log.warn(
        `Still looking for ${[...this.pending.keys()].join(', ')}. Check the address and that the device is in range.`,
      );
      this.rescanTimer = setTimeout(() => void this.scan(noble), RESCAN_INTERVAL_MS);
    }
  }

  private async shutdown() {
    clearTimeout(this.rescanTimer);
    await Promise.all(this.handlers.map((handler) => handler.shutdown()));
  }
}
