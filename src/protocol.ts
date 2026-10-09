/**
 * Gardena Bluetooth GATT protocol, ported from the reverse-engineered
 * gardena-bluetooth Python library that backs Home Assistant's integration:
 * https://github.com/elupus/gardena-bluetooth/blob/main/gardena_bluetooth/const.py
 *
 * UUIDs are in noble's format: lowercase, no dashes.
 */

export const GARDENA_COMPANY_ID = 0x0426;

const gardena = (short: string) => `98bd${short}0b0e421a84e5ddbf75dc6de4`;

export const GattUuid = {
  valveService: gardena('0f10'),
  /** bool: valve is open. */
  valveState: gardena('0f11'),
  /** int32 seconds. Writing > 0 opens the valve for that long, 0 closes it. */
  remainingOpenTime: gardena('0f13'),
  /** int32 seconds: the duration set on the device for manual watering. */
  manualWateringTime: gardena('0f14'),
  /** int8 percent. */
  batteryLevel: gardena('2a19'),
  /** Standard BLE battery level, exposed by newer firmware. */
  standardBatteryLevel: '2a19',
  modelNumber: '2a24',
  serialNumber: '2a25',
  firmwareVersion: '2a26',
} as const;

export type GattUuid = (typeof GattUuid)[keyof typeof GattUuid];

/** Gardena advertises its Bluetooth SIG company id as the manufacturer data prefix. */
export const isGardenaAdvertisement = (manufacturerData: Buffer | undefined) =>
  manufacturerData !== undefined &&
  manufacturerData.length >= 2 &&
  manufacturerData.readUInt16LE(0) === GARDENA_COMPANY_ID;

export const decodeBool = (data: Buffer) => data.length > 0 && data[0] !== 0;

/** Little-endian signed integer of whatever width the device sends (1 to 6 bytes). */
export const decodeInt = (data: Buffer) => (data.length === 0 ? 0 : data.readIntLE(0, data.length));

export const encodeInt32 = (value: number) => {
  const data = Buffer.alloc(4);
  data.writeInt32LE(Math.round(value));
  return data;
};

export const decodeString = (data: Buffer) => data.toString('latin1').split('\0')[0]!.trim();
