import { EventEmitter } from 'node:events';
import type { Peripheral } from '@stoprocent/noble';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GardenaConnection } from '../src/connection.js';
import { GattUuid } from '../src/protocol.js';

/** A peripheral exposing the valve state characteristic. `discover` can be swapped to simulate a hang. */
const fakePeripheral = () => {
  const peripheral = Object.assign(new EventEmitter(), {
    state: 'disconnected',
    connectAsync: vi.fn(async () => {
      peripheral.state = 'connected';
    }),
    disconnectAsync: vi.fn(async () => {
      peripheral.state = 'disconnected';
    }),
    cancelConnect: vi.fn(),
    discover: async () => ({
      characteristics: [{ uuid: GattUuid.valveState, readAsync: async () => Buffer.from([1]) }],
    }),
    discoverAllServicesAndCharacteristicsAsync: () => peripheral.discover(),
  });
  return peripheral;
};

const asPeripheral = (fake: ReturnType<typeof fakePeripheral>) => fake as unknown as Peripheral;

describe('GardenaConnection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('times out a hung discovery, disconnects, and keeps serving later requests', async () => {
    const fake = fakePeripheral();
    const working = fake.discover;
    fake.discover = () => new Promise(() => {});
    const connection = new GardenaConnection(asPeripheral(fake));

    const hung = connection.transaction((gatt) => gatt.read(GattUuid.valveState));
    const failure = expect(hung).rejects.toThrow('Timed out talking to device');
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(fake.disconnectAsync).toHaveBeenCalled();

    fake.discover = working;
    await expect(connection.transaction((gatt) => gatt.read(GattUuid.valveState))).resolves.toEqual(Buffer.from([1]));
  });

  it('never runs operations on two devices at the same time', async () => {
    const connections = [new GardenaConnection(asPeripheral(fakePeripheral())), new GardenaConnection(asPeripheral(fakePeripheral()))];
    let running = 0;
    let maxRunning = 0;

    const results = connections.map((connection) =>
      connection.transaction(async () => {
        maxRunning = Math.max(maxRunning, ++running);
        await new Promise((resolve) => setTimeout(resolve, 100));
        running--;
      }),
    );
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all(results);

    expect(maxRunning).toBe(1);
  });

  it('reuses one connection for back to back requests', async () => {
    const fake = fakePeripheral();
    const connection = new GardenaConnection(asPeripheral(fake));

    await connection.transaction((gatt) => gatt.read(GattUuid.valveState));
    await connection.transaction((gatt) => gatt.read(GattUuid.valveState));
    expect(fake.connectAsync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.disconnectAsync).toHaveBeenCalledTimes(1);
  });
});
