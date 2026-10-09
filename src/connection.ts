import type { Characteristic, Peripheral } from '@stoprocent/noble';
import type { GattUuid } from './protocol.js';

/** Upper bound for connect, discovery and the work itself. BLE calls can otherwise hang forever. */
const TRANSACTION_TIMEOUT_MS = 30_000;
const DISCONNECT_TIMEOUT_MS = 5_000;
/** Keep the link up briefly after the last operation so bursts reuse one connection. */
const IDLE_DISCONNECT_MS = 5_000;

export interface Gatt {
  has(uuid: GattUuid): boolean;
  read(uuid: GattUuid): Promise<Buffer>;
  write(uuid: GattUuid, data: Buffer): Promise<void>;
}

const withTimeout = <T>(promise: Promise<T>, ms: number, message: string) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });

/**
 * Every device shares one Bluetooth adapter, and many adapters reject a second
 * connection attempt while one is in flight. One queue for all devices keeps
 * every GATT operation strictly sequential.
 */
let adapterQueue: Promise<unknown> = Promise.resolve();

const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
  const result = adapterQueue.then(run);
  adapterQueue = result.catch(() => undefined);
  return result;
};

/**
 * On-demand BLE link to one Gardena device.
 *
 * The device is battery powered and accepts a single central, so we connect only
 * while there is work to do.
 */
export class GardenaConnection {
  private characteristics?: Map<string, Characteristic>;
  private idleTimer?: NodeJS.Timeout;

  constructor(private readonly peripheral: Peripheral) {
    peripheral.on('disconnect', () => {
      this.characteristics = undefined;
    });
  }

  transaction<T>(work: (gatt: Gatt) => Promise<T>): Promise<T> {
    clearTimeout(this.idleTimer);
    return enqueue(async () => {
      try {
        const run = async () => work(await this.gatt());
        return await withTimeout(run(), TRANSACTION_TIMEOUT_MS, 'Timed out talking to device');
      } catch (error) {
        await this.close();
        throw error;
      } finally {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => void this.disconnect(), IDLE_DISCONNECT_MS);
      }
    });
  }

  disconnect() {
    clearTimeout(this.idleTimer);
    return enqueue(() => this.close());
  }

  private async close() {
    this.characteristics = undefined;
    if (this.peripheral.state === 'connecting') this.peripheral.cancelConnect();
    if (this.peripheral.state !== 'disconnected') {
      await withTimeout(this.peripheral.disconnectAsync(), DISCONNECT_TIMEOUT_MS, 'Timed out disconnecting').catch(
        () => undefined,
      );
    }
  }

  private async gatt(): Promise<Gatt> {
    const characteristics = this.characteristics ?? (await this.connect());
    const find = (uuid: GattUuid) => {
      const characteristic = characteristics.get(uuid);
      if (!characteristic) throw new Error(`Device has no characteristic ${uuid}`);
      return characteristic;
    };
    return {
      has: (uuid) => characteristics.has(uuid),
      read: (uuid) => find(uuid).readAsync(),
      write: (uuid, data) => find(uuid).writeAsync(data, false),
    };
  }

  private async connect() {
    if (this.peripheral.state !== 'connected') await this.peripheral.connectAsync();
    const { characteristics } = await this.peripheral.discoverAllServicesAndCharacteristicsAsync();
    // First match wins; the UUIDs we use are unique across the device's services.
    this.characteristics = new Map(characteristics.toReversed().map((c) => [c.uuid, c]));
    return this.characteristics;
  }
}
