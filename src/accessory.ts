import type { CharacteristicValue, Logging, PlatformAccessory, Service } from 'homebridge';
import type { GardenaConnection, Gatt } from './connection.js';
import type { GardenaPlatform } from './platform.js';
import { decodeBool, decodeInt, decodeString, encodeInt32, GattUuid } from './protocol.js';

export interface DeviceConfig {
  address: string;
  name?: string;
  /** Seconds to water when switched on from HomeKit, until changed in the Home app. */
  defaultDuration?: number;
}

export interface AccessoryContext {
  device: DeviceConfig;
  duration?: number;
}

const DEFAULT_DURATION_SECONDS = 15 * 60;
const LOW_BATTERY_PERCENT = 20;
/** After a run is due to finish, poll this much later to confirm the valve closed. */
const END_OF_RUN_GRACE_MS = 5_000;
const CONFIRM_DELAY_MS = 3_000;
/** Consecutive failed polls before HomeKit shows the device as "No Response". */
const FAILURES_BEFORE_UNREACHABLE = 3;

/**
 * One Gardena valve as a HomeKit irrigation Valve with a Battery service.
 *
 * HomeKit reads are answered from cached state: BLE round trips take seconds and
 * would make the Home app show "No Response". The cache is refreshed by polling.
 * Once polls keep failing, reads fail too, so a stale state is never shown as live.
 */
export class GardenaValveAccessory {
  private readonly valve: Service;
  private readonly battery: Service;
  private readonly log: Logging;
  private connection?: GardenaConnection;
  private pollTimer?: NodeJS.Timeout;
  private endOfRunTimer?: NodeJS.Timeout;
  private informationLoaded = false;
  private reachable = false;
  private failures = 0;

  private active = false;
  /** Epoch ms when the current run ends, so RemainingDuration counts down between polls. */
  private runEndsAt = 0;

  constructor(
    private readonly platform: GardenaPlatform,
    private readonly accessory: PlatformAccessory<AccessoryContext>,
  ) {
    const { Service, Characteristic } = platform.api.hap;
    this.log = platform.log;

    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Gardena')
      .setCharacteristic(Characteristic.Model, 'Bluetooth Water Control')
      .setCharacteristic(Characteristic.SerialNumber, this.device.address);

    this.valve = accessory.getService(Service.Valve) ?? accessory.addService(Service.Valve);
    this.valve.setCharacteristic(Characteristic.Name, accessory.displayName);
    this.valve.setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.IRRIGATION);
    this.valve
      .getCharacteristic(Characteristic.Active)
      .onGet(() => this.whenReachable(Number(this.active)))
      .onSet((value) => this.setActive(value === Characteristic.Active.ACTIVE));
    this.valve.getCharacteristic(Characteristic.InUse).onGet(() => this.whenReachable(Number(this.active)));
    this.valve
      .getCharacteristic(Characteristic.RemainingDuration)
      .onGet(() => this.whenReachable(this.remainingSeconds()));
    this.valve
      .getCharacteristic(Characteristic.SetDuration)
      .onGet(() => this.duration)
      .onSet((value) => this.setDuration(value));

    this.battery = accessory.getService(Service.Battery) ?? accessory.addService(Service.Battery);
    this.battery.setCharacteristic(Characteristic.ChargingState, Characteristic.ChargingState.NOT_CHARGEABLE);
  }

  private get device() {
    return this.accessory.context.device;
  }

  private get duration() {
    return this.accessory.context.duration ?? this.device.defaultDuration ?? DEFAULT_DURATION_SECONDS;
  }

  private remainingSeconds() {
    return Math.max(0, Math.round((this.runEndsAt - Date.now()) / 1000));
  }

  /** Called once the device has been found by a BLE scan. */
  attach(connection: GardenaConnection, pollIntervalSeconds: number) {
    this.connection = connection;
    void this.poll();
    this.pollTimer = setInterval(() => void this.poll(), pollIntervalSeconds * 1000);
  }

  async shutdown() {
    clearInterval(this.pollTimer);
    clearTimeout(this.endOfRunTimer);
    await this.connection?.disconnect();
  }

  private async poll() {
    if (!this.connection) return;
    try {
      await this.connection.transaction(async (gatt) => {
        if (!this.informationLoaded) await this.loadInformation(gatt);
        if (!gatt.has(GattUuid.valveState)) return this.disableUnsupported();

        const open = decodeBool(await gatt.read(GattUuid.valveState));
        const remaining = decodeInt(await gatt.read(GattUuid.remainingOpenTime));
        this.applyState(open, remaining);
        const battery = await this.readBattery(gatt);
        this.log.debug(
          `[${this.accessory.displayName}] Valve ${open ? `open, ${remaining}s left` : 'closed'}, battery ${battery ?? 'unknown'}%`,
        );
        this.failures = 0;
        this.reachable = true;
      });
    } catch (error) {
      this.failures += 1;
      this.log.warn(
        `[${this.accessory.displayName}] Could not reach device (attempt ${this.failures}): ${(error as Error).message}`,
      );
      if (this.reachable && this.failures >= FAILURES_BEFORE_UNREACHABLE) this.markUnreachable();
    }
  }

  private markUnreachable() {
    this.reachable = false;
    const { Characteristic, HapStatusError, HAPStatus } = this.platform.api.hap;
    this.valve
      .getCharacteristic(Characteristic.Active)
      .updateValue(new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
  }

  private disableUnsupported() {
    clearInterval(this.pollTimer);
    this.log.error(
      `[${this.accessory.displayName}] This device has no classic Gardena valve service, so it can't be controlled. ` +
        'Only Water Control Bluetooth (01889) and Irrigation Valve 9V (1285) are supported. Remove it from the config.',
    );
  }

  private async loadInformation(gatt: Gatt) {
    const { Service, Characteristic } = this.platform.api.hap;
    const information = this.accessory.getService(Service.AccessoryInformation)!;
    const found: string[] = [];
    const fields = [
      [GattUuid.modelNumber, Characteristic.Model],
      [GattUuid.serialNumber, Characteristic.SerialNumber],
      [GattUuid.firmwareVersion, Characteristic.FirmwareRevision],
    ] as const;
    for (const [uuid, characteristic] of fields) {
      if (gatt.has(uuid)) {
        const value = decodeString(await gatt.read(uuid));
        if (value) {
          information.setCharacteristic(characteristic, value);
          found.push(value);
        }
      }
    }
    this.log.info(`[${this.accessory.displayName}] Connected to ${found.join(', ') || 'device'}`);
    this.informationLoaded = true;
  }

  private async readBattery(gatt: Gatt) {
    const uuid = [GattUuid.batteryLevel, GattUuid.standardBatteryLevel].find((candidate) => gatt.has(candidate));
    if (!uuid) return undefined;

    const { Characteristic } = this.platform.api.hap;
    const level = Math.min(100, Math.max(0, decodeInt(await gatt.read(uuid))));
    this.battery.updateCharacteristic(Characteristic.BatteryLevel, level);
    this.battery.updateCharacteristic(
      Characteristic.StatusLowBattery,
      level < LOW_BATTERY_PERCENT
        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
    return level;
  }

  private applyState(active: boolean, remainingSeconds: number) {
    const { Characteristic } = this.platform.api.hap;
    this.active = active && remainingSeconds > 0;
    this.runEndsAt = this.active ? Date.now() + remainingSeconds * 1000 : 0;

    this.valve.updateCharacteristic(Characteristic.Active, Number(this.active));
    this.valve.updateCharacteristic(Characteristic.InUse, Number(this.active));
    this.valve.updateCharacteristic(Characteristic.RemainingDuration, this.remainingSeconds());

    clearTimeout(this.endOfRunTimer);
    if (this.active) {
      this.endOfRunTimer = setTimeout(() => void this.poll(), remainingSeconds * 1000 + END_OF_RUN_GRACE_MS);
    }
  }

  /**
   * Answers HomeKit straight away and talks to the device in the background, since
   * a BLE connect can outlast HomeKit's request timeout. A failed write reverts the tile.
   */
  private setActive(active: boolean) {
    const connection = this.whenReachable(this.connection)!;
    const previous = { active: this.active, remaining: this.remainingSeconds() };
    const seconds = active ? this.duration : 0;
    this.applyState(active, seconds);

    connection
      .transaction((gatt) => gatt.write(GattUuid.remainingOpenTime, encodeInt32(seconds)))
      .then(() => {
        this.log.info(`[${this.accessory.displayName}] ${active ? `Watering for ${seconds}s` : 'Stopped'}`);
        // Confirm the valve moved while the link is still open.
        setTimeout(() => void this.poll(), CONFIRM_DELAY_MS);
      })
      .catch((error: Error) => {
        this.log.error(`[${this.accessory.displayName}] Failed to ${active ? 'start' : 'stop'}: ${error.message}`);
        this.applyState(previous.active, previous.remaining);
      });
  }

  private setDuration(value: CharacteristicValue) {
    this.accessory.context.duration = Number(value);
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }

  /** Pass a cached value through, or fail the HomeKit request so the tile shows "No Response". */
  private whenReachable<T>(value: T): T {
    if (this.reachable) return value;
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
}
