import * as hap from '@homebridge/hap-nodejs';
import type { PlatformAccessory } from 'homebridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AccessoryContext, GardenaValveAccessory } from '../src/accessory.js';
import type { GardenaConnection, Gatt } from '../src/connection.js';
import type { GardenaPlatform } from '../src/platform.js';
import { encodeInt32, GattUuid } from '../src/protocol.js';

const POLL_SECONDS = 60;

/** A device that is watering with 10 minutes left, behind a link that can be cut. */
const setup = () => {
  const device = new Map<string, Buffer>([
    [GattUuid.valveState, Buffer.from([1])],
    [GattUuid.remainingOpenTime, encodeInt32(600)],
    [GattUuid.batteryLevel, Buffer.from([80])],
  ]);
  const gatt: Gatt = {
    has: (uuid) => device.has(uuid),
    read: async (uuid) => device.get(uuid)!,
    write: async (uuid, data) => void device.set(uuid, data),
  };
  const link = { up: true };
  const connection = {
    transaction: async <T>(work: (gatt: Gatt) => Promise<T>) => {
      if (!link.up) throw new Error('out of range');
      return work(gatt);
    },
    disconnect: async () => {},
  } as unknown as GardenaConnection;

  const accessory = Object.assign(new hap.Accessory('Tap', hap.uuid.generate('tap')), {
    context: { device: { address: 'aa:bb' } } satisfies AccessoryContext,
  }) as unknown as PlatformAccessory<AccessoryContext>;
  const platform = {
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    api: { hap, updatePlatformAccessories: vi.fn() },
  } as unknown as GardenaPlatform;

  const handler = new GardenaValveAccessory(platform, accessory);
  const valve = accessory.getService(hap.Service.Valve)!;
  const active = valve.getCharacteristic(hap.Characteristic.Active);
  return { handler, device, link, connection, platform, active, valve };
};

describe('GardenaValveAccessory', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows No Response until the device has been read', async () => {
    const { handler, connection, active, valve } = setup();
    await expect(active.handleGetRequest()).rejects.toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    handler.attach(connection, POLL_SECONDS);
    await vi.advanceTimersByTimeAsync(0);

    await expect(active.handleGetRequest()).resolves.toBe(1);
    await expect(valve.getCharacteristic(hap.Characteristic.RemainingDuration).handleGetRequest()).resolves.toBe(600);
    await handler.shutdown();
  });

  it('goes No Response after repeated failed polls and recovers when the device returns', async () => {
    const { handler, connection, link, active } = setup();
    handler.attach(connection, POLL_SECONDS);
    await vi.advanceTimersByTimeAsync(0);

    link.up = false;
    await vi.advanceTimersByTimeAsync(2 * POLL_SECONDS * 1000);
    await expect(active.handleGetRequest()).resolves.toBe(1);

    await vi.advanceTimersByTimeAsync(POLL_SECONDS * 1000);
    await expect(active.handleGetRequest()).rejects.toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    link.up = true;
    await vi.advanceTimersByTimeAsync(POLL_SECONDS * 1000);
    await expect(active.handleGetRequest()).resolves.toBe(1);
    await handler.shutdown();
  });

  it('writes the chosen duration to start watering', async () => {
    const { handler, connection, device, valve, active } = setup();
    device.set(GattUuid.valveState, Buffer.from([0]));
    device.set(GattUuid.remainingOpenTime, encodeInt32(0));
    handler.attach(connection, POLL_SECONDS);
    await vi.advanceTimersByTimeAsync(0);

    await valve.getCharacteristic(hap.Characteristic.SetDuration).handleSetRequest(300);
    await active.handleSetRequest(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(device.get(GattUuid.remainingOpenTime)).toEqual(encodeInt32(300));
    await handler.shutdown();
  });

  it('reverts the tile when starting fails', async () => {
    const { handler, connection, link, device, active, platform } = setup();
    device.set(GattUuid.valveState, Buffer.from([0]));
    device.set(GattUuid.remainingOpenTime, encodeInt32(0));
    handler.attach(connection, POLL_SECONDS);
    await vi.advanceTimersByTimeAsync(0);

    link.up = false;
    await active.handleSetRequest(1);
    await vi.advanceTimersByTimeAsync(0);

    await expect(active.handleGetRequest()).resolves.toBe(0);
    expect(platform.log.error).toHaveBeenCalledWith(expect.stringContaining('Failed to start'));
    await handler.shutdown();
  });

  it('stops polling a device without the classic valve service', async () => {
    const { handler, connection, device, platform, active } = setup();
    device.delete(GattUuid.valveState);
    handler.attach(connection, POLL_SECONDS);
    await vi.advanceTimersByTimeAsync(3 * POLL_SECONDS * 1000);

    expect(platform.log.error).toHaveBeenCalledTimes(1);
    await expect(active.handleGetRequest()).rejects.toBe(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    await handler.shutdown();
  });
});
