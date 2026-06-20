import {
	BinaryFuseConstructionFailedError,
	BinaryFuseConstructionIndexOutOfBoundsError,
	BinaryFuseFilterInvalidError
} from '../../errors.ts';

import {
	mulhi,
	multiply64LowHigh,
	multiply64LowLow,
	shiftRightLow,
	splitmix64,
	writeSeededMurmur64
} from './arithmetic.ts';
import type { Geometry, HashedKeys, SerialisedHeader } from './types.ts';

// A binary fuse8 filter: a static, immutable approximate-membership structure
// with no false negatives and a ~0.39% false-positive rate at ~9 bits/key. It
// is built once from the complete key set and queried read-only, which is
// exactly how admission uses it (rebuilt wholesale each cron tick, never
// mutated in place).
//
// This uses Graf and Lemire's peel/back-fill construction: keys are peeled from
// slots they alone occupy, then fingerprints are back-filled in reverse peel
// order so each key's three slots XOR to its fingerprint. Construction can fail
// for an unlucky seed and is retried with a fresh one.

const maxConstructionAttempts = 100;

const magic = 0x46_55_53_45;
const version = 1;

const fnvOffsetHigh = 0xcb_f2_9c_e4;
const fnvOffsetLow = 0x84_22_23_25;
const fnvPrimeHigh = 0x00_00_01_00;
const fnvPrimeLow = 0x00_00_01_b3;
const initialSeedHigh = 0x72_6b_2b_9d;
const initialSeedLow = 0x43_8b_9d_4d;

const checksumBytes = 4;
const headerBytes = checksumBytes + 4 + 4 + 8 + 6 * 4;

interface Word64Scratch {
	high: number;
	low: number;
}

// FNV-1a over everything past the 4-byte checksum field: an integrity guard so
// a corrupted artifact (a bit flip, a partial KV write) is rejected at
// deserialise and the caller falls open, rather than reading false negatives
// out of a structurally valid but wrong filter and 404ing live tenants.
function bodyChecksum(bytes: Uint8Array): number {
	let hash = 0x81_1c_9d_c5;

	for (const byte of bytes.subarray(checksumBytes)) {
		hash = Math.imul(hash ^ byte, 0x01_00_01_93);
	}

	return hash >>> 0;
}

function fnvByteHigh(high: number, low: number, byte: number): number {
	const nextLow = (low ^ byte) >>> 0;

	return multiply64LowHigh(high, nextLow, fnvPrimeHigh, fnvPrimeLow);
}

function fnvByteLow(low: number, byte: number): number {
	return multiply64LowLow((low ^ byte) >>> 0, fnvPrimeLow);
}

function writeStringKey(value: string, output: Word64Scratch): void {
	let high = fnvOffsetHigh;
	let low = fnvOffsetLow;

	// `TextEncoder` replaces lone surrogates with U+FFFD. `codePointAt()` exposes
	// them as raw surrogate code units, so they need the same normalisation here.
	for (let offset = 0; offset < value.length; offset += 1) {
		const unit = value.codePointAt(offset) ?? 0;
		let codePoint = unit;

		if (unit > 0xff_ff) {
			offset += 1;
		} else if (unit >= 0xd8_00 && unit <= 0xdf_ff) {
			codePoint = 0xff_fd;
		}

		if (codePoint <= 0x7f) {
			const nextHigh = fnvByteHigh(high, low, codePoint);
			low = fnvByteLow(low, codePoint);
			high = nextHigh;
			continue;
		}

		if (codePoint <= 0x07_ff) {
			const first = 0xc0 | (codePoint >> 6);
			const second = 0x80 | (codePoint & 0x3f);
			let nextHigh = fnvByteHigh(high, low, first);
			low = fnvByteLow(low, first);
			high = nextHigh;
			nextHigh = fnvByteHigh(high, low, second);
			low = fnvByteLow(low, second);
			high = nextHigh;
			continue;
		}

		if (codePoint <= 0xff_ff) {
			const first = 0xe0 | (codePoint >> 12);
			const second = 0x80 | ((codePoint >> 6) & 0x3f);
			const third = 0x80 | (codePoint & 0x3f);
			let nextHigh = fnvByteHigh(high, low, first);
			low = fnvByteLow(low, first);
			high = nextHigh;
			nextHigh = fnvByteHigh(high, low, second);
			low = fnvByteLow(low, second);
			high = nextHigh;
			nextHigh = fnvByteHigh(high, low, third);
			low = fnvByteLow(low, third);
			high = nextHigh;
			continue;
		}

		const first = 0xf0 | (codePoint >> 18);
		const second = 0x80 | ((codePoint >> 12) & 0x3f);
		const third = 0x80 | ((codePoint >> 6) & 0x3f);
		const fourth = 0x80 | (codePoint & 0x3f);
		let nextHigh = fnvByteHigh(high, low, first);
		low = fnvByteLow(low, first);
		high = nextHigh;
		nextHigh = fnvByteHigh(high, low, second);
		low = fnvByteLow(low, second);
		high = nextHigh;
		nextHigh = fnvByteHigh(high, low, third);
		low = fnvByteLow(low, third);
		high = nextHigh;
		nextHigh = fnvByteHigh(high, low, fourth);
		low = fnvByteLow(low, fourth);
		high = nextHigh;
	}

	output.high = high;
	output.low = low;
}

function fingerprint(high: number, low: number): number {
	return (high ^ low) & 0xff;
}

function geometryFor(size: number): Geometry {
	// The segment length is a power of two, which is what makes the slot XOR stay
	// within a segment band.
	const arity = 3;
	const segmentLength =
		size === 0
			? 4
			: Math.min(
					1 << Math.floor(Math.log(size) / Math.log(3.33) + 2.25),
					262_144
				);
	const sizeFactor =
		size <= 1
			? 0
			: Math.max(1.125, 0.875 + 0.25 * (Math.log(1e6) / Math.log(size)));
	const capacity = size <= 1 ? 0 : Math.round(size * sizeFactor);
	const initSegmentCount =
		Math.floor((capacity + segmentLength - 1) / segmentLength) - (arity - 1);
	let arrayLength = (initSegmentCount + arity - 1) * segmentLength;
	let segmentCount = Math.floor(
		(arrayLength + segmentLength - 1) / segmentLength
	);
	segmentCount = segmentCount <= arity - 1 ? 1 : segmentCount - (arity - 1);
	const segmentCountLength = segmentCount * segmentLength;
	arrayLength = segmentCountLength + (arity - 1) * segmentLength;

	return {
		segmentLength,
		segmentLengthMask: segmentLength - 1,
		segmentCount,
		segmentCountLength,
		arrayLength
	};
}

// The three slot positions for a hash, each in its own segment band. The single
// function is used for both construction and query, so the two can never
// disagree. The XOR by a within-segment value keeps each position inside its
// band, so all three stay below `arrayLength`.
function slot(
	index: number,
	high: number,
	low: number,
	geometry: Geometry
): number {
	const base = mulhi(high, low, geometry.segmentCountLength);
	const shifted =
		index === 0
			? 0
			: (index === 1 ? shiftRightLow(high, low, 18) : low) &
				geometry.segmentLengthMask;

	return (base + index * geometry.segmentLength) ^ shifted;
}

function isPowerOfTwo(value: number): boolean {
	return value > 0 && (value & (value - 1)) === 0;
}

function validateGeometry(
	geometry: Geometry,
	fingerprintLength: number,
	keyCount: number
): void {
	const expected = geometryFor(keyCount);

	if (
		!isPowerOfTwo(geometry.segmentLength) ||
		geometry.segmentLength > 262_144 ||
		geometry.segmentLengthMask !== geometry.segmentLength - 1 ||
		geometry.segmentCountLength === 0 ||
		geometry.segmentCount === 0 ||
		geometry.segmentCountLength !==
			geometry.segmentCount * geometry.segmentLength ||
		geometry.segmentCountLength % geometry.segmentLength !== 0 ||
		geometry.arrayLength !==
			geometry.segmentCountLength + 2 * geometry.segmentLength ||
		geometry.segmentLength !== expected.segmentLength ||
		geometry.segmentLengthMask !== expected.segmentLengthMask ||
		geometry.segmentCount !== expected.segmentCount ||
		geometry.segmentCountLength !== expected.segmentCountLength ||
		geometry.arrayLength !== expected.arrayLength ||
		fingerprintLength !== geometry.arrayLength
	) {
		throw new BinaryFuseFilterInvalidError();
	}
}

function assertConstructionIndex(length: number, index: number): void {
	if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
		throw new BinaryFuseConstructionIndexOutOfBoundsError();
	}
}

function readConstructionWord(values: Uint32Array, index: number): number {
	assertConstructionIndex(values.length, index);
	const value = values[index];

	if (value === undefined) {
		throw new BinaryFuseConstructionIndexOutOfBoundsError();
	}

	return value;
}

function readConstructionByte(values: Uint8Array, index: number): number {
	assertConstructionIndex(values.length, index);
	const value = values[index];

	if (value === undefined) {
		throw new BinaryFuseConstructionIndexOutOfBoundsError();
	}

	return value;
}

function writeConstructionByte(
	values: Uint8Array,
	index: number,
	value: number
): void {
	assertConstructionIndex(values.length, index);
	values[index] = value;
}

function hashedKeys(values: readonly string[]): HashedKeys {
	const highs = new Uint32Array(values.length);
	const lows = new Uint32Array(values.length);
	const seen = new Map<number, Set<number>>();
	const key = { high: 0, low: 0 };
	let length = 0;

	for (const value of values) {
		writeStringKey(value, key);
		const { high, low } = key;
		let lowSet = seen.get(high);

		// Deduplicating after hashing is safe for this filter: equal 64-bit keys
		// produce the same three slots and fingerprint, so keeping both copies
		// would only make peeling harder without changing membership answers.
		if (lowSet === undefined) {
			lowSet = new Set<number>();
			seen.set(high, lowSet);
		} else if (lowSet.has(low)) {
			continue;
		}

		lowSet.add(low);
		highs[length] = high;
		lows[length] = low;
		length += 1;
	}

	return { highs, lows, length };
}

function hasValue(
	value: string,
	seedHigh: number,
	seedLow: number,
	geometry: Geometry,
	fingerprints: Uint8Array,
	keyScratch: Word64Scratch,
	hashHighScratch: Uint32Array,
	hashLowScratch: Uint32Array
): boolean {
	writeStringKey(value, keyScratch);
	writeSeededMurmur64(
		hashHighScratch,
		hashLowScratch,
		0,
		keyScratch.high,
		keyScratch.low,
		seedHigh,
		seedLow
	);

	const hashHigh = hashHighScratch[0];
	const hashLow = hashLowScratch[0];

	if (hashHigh === undefined || hashLow === undefined) {
		throw new BinaryFuseFilterInvalidError();
	}

	const f = fingerprint(hashHigh, hashLow);
	const slots = [
		slot(0, hashHigh, hashLow, geometry),
		slot(1, hashHigh, hashLow, geometry),
		slot(2, hashHigh, hashLow, geometry)
	];

	let combined = f;

	for (const position of slots) {
		const value = fingerprints[position];

		if (value === undefined) {
			throw new BinaryFuseFilterInvalidError();
		}

		combined ^= value;
	}

	return combined === 0;
}

/**
 * Static approximate-membership filter with no false negatives for successfully
 * built keys and an expected false-positive rate of about 1/256.
 */
export class BinaryFuse8 {
	/**
	 * Restores a filter produced by {@link BinaryFuse8.serialise}.
	 */
	static deserialise(bytes: Uint8Array): BinaryFuse8 {
		if (bytes.byteLength < headerBytes) {
			throw new BinaryFuseFilterInvalidError();
		}

		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

		if (
			view.getUint32(4, true) !== magic ||
			view.getUint32(8, true) !== version ||
			view.getUint32(0, true) !== bodyChecksum(bytes)
		) {
			throw new BinaryFuseFilterInvalidError();
		}

		const header: SerialisedHeader = {
			seedLow: view.getUint32(12, true),
			seedHigh: view.getUint32(16, true),
			geometry: {
				segmentLength: view.getUint32(24, true),
				segmentLengthMask: view.getUint32(28, true),
				segmentCount: view.getUint32(32, true),
				segmentCountLength: view.getUint32(36, true),
				arrayLength: view.getUint32(40, true)
			},
			keyCount: view.getUint32(20, true)
		};
		const fingerprints = bytes.subarray(headerBytes);

		validateGeometry(header.geometry, fingerprints.byteLength, header.keyCount);

		return new BinaryFuse8(
			header.seedHigh,
			header.seedLow,
			header.geometry,
			Uint8Array.from(fingerprints),
			header.keyCount
		);
	}

	/**
	 * Builds a filter over the given values.
	 */
	static build(values: readonly string[]): BinaryFuse8 {
		const keys = hashedKeys(values);
		const geometry = geometryFor(keys.length);
		let rngHigh = initialSeedHigh;
		let rngLow = initialSeedLow;

		for (let attempt = 0; attempt < maxConstructionAttempts; attempt += 1) {
			const seeded = splitmix64(rngHigh, rngLow);
			rngHigh = seeded.nextHigh;
			rngLow = seeded.nextLow;
			const built = tryBuild(keys, geometry, seeded.high, seeded.low);

			if (built !== undefined) {
				return new BinaryFuse8(
					seeded.high,
					seeded.low,
					geometry,
					built,
					keys.length
				);
			}
		}

		throw new BinaryFuseConstructionFailedError();
	}

	private readonly keyScratch: Word64Scratch = { high: 0, low: 0 };
	private readonly hashHighScratch: Uint32Array = new Uint32Array(1);
	private readonly hashLowScratch: Uint32Array = new Uint32Array(1);

	private constructor(
		private readonly seedHigh: number,
		private readonly seedLow: number,
		private readonly geometry: Geometry,
		private readonly fingerprints: Uint8Array,
		private readonly keyCount: number
	) {}

	/**
	 * Returns whether a value is probably in the built set.
	 */
	has(value: string): boolean {
		if (this.keyCount === 0) {
			return false;
		}

		return hasValue(
			value,
			this.seedHigh,
			this.seedLow,
			this.geometry,
			this.fingerprints,
			this.keyScratch,
			this.hashHighScratch,
			this.hashLowScratch
		);
	}

	/**
	 * Encodes the filter into the local checked binary format.
	 */
	serialise(): Uint8Array {
		const buffer = new Uint8Array(headerBytes + this.fingerprints.length);
		const view = new DataView(buffer.buffer);
		view.setUint32(4, magic, true);
		view.setUint32(8, version, true);
		view.setUint32(12, this.seedLow, true);
		view.setUint32(16, this.seedHigh, true);
		view.setUint32(20, this.keyCount, true);
		view.setUint32(24, this.geometry.segmentLength, true);
		view.setUint32(28, this.geometry.segmentLengthMask, true);
		view.setUint32(32, this.geometry.segmentCount, true);
		view.setUint32(36, this.geometry.segmentCountLength, true);
		view.setUint32(40, this.geometry.arrayLength, true);
		buffer.set(this.fingerprints, headerBytes);
		view.setUint32(0, bodyChecksum(buffer), true);

		return buffer;
	}
}

// One construction attempt for a fixed seed. Returns the fingerprint array on
// success, or undefined if the keys could not all be peeled (caller retries
// with a new seed).
function tryBuild(
	keys: HashedKeys,
	geometry: Geometry,
	seedHigh: number,
	seedLow: number
): Uint8Array | undefined {
	const size = keys.length;
	const { arrayLength } = geometry;
	const slotState = new Uint32Array(arrayLength);
	const slotHashHigh = new Uint32Array(arrayLength);
	const slotHashLow = new Uint32Array(arrayLength);
	const hashesHigh = new Uint32Array(size);
	const hashesLow = new Uint32Array(size);

	// Each slot stores its incident-key count in bits 2..31 and the XOR of
	// incident slot indices in bits 0..1. A singleton slot therefore reveals
	// which of the key's three slots it is.
	for (let entry = 0; entry < size; entry += 1) {
		writeSeededMurmur64(
			hashesHigh,
			hashesLow,
			entry,
			readConstructionWord(keys.highs, entry),
			readConstructionWord(keys.lows, entry),
			seedHigh,
			seedLow
		);
	}

	for (let entry = 0; entry < size; entry += 1) {
		const hashHigh = readConstructionWord(hashesHigh, entry);
		const hashLow = readConstructionWord(hashesLow, entry);

		for (let index = 0; index < 3; index += 1) {
			const position = slot(index, hashHigh, hashLow, geometry);
			const state = readConstructionWord(slotState, position);
			const storedHigh = readConstructionWord(slotHashHigh, position);
			const storedLow = readConstructionWord(slotHashLow, position);

			slotState[position] = (state + 4) ^ index;
			slotHashHigh[position] = storedHigh ^ hashHigh;
			slotHashLow[position] = storedLow ^ hashLow;
		}
	}

	const stackHashHigh = new Uint32Array(size);
	const stackHashLow = new Uint32Array(size);
	const stackSlotIndex = new Uint8Array(size);
	let stackSize = 0;

	// The peel stack records singleton slots in removal order. Fingerprints are
	// assigned later in reverse order, when the other two slots for a key have
	// already been fixed.
	const alone: number[] = [];
	let slotPosition = -1;
	for (const state of slotState) {
		slotPosition += 1;
		if (state >> 2 === 1) {
			alone.push(slotPosition);
		}
	}

	while (alone.length > 0) {
		const position = alone.pop();

		if (position === undefined) {
			continue;
		}

		const state = readConstructionWord(slotState, position);

		if (state >> 2 !== 1) {
			continue;
		}

		const hashHigh = readConstructionWord(slotHashHigh, position);
		const hashLow = readConstructionWord(slotHashLow, position);
		const slotIndex = state & 3;
		stackHashHigh[stackSize] = hashHigh;
		stackHashLow[stackSize] = hashLow;
		stackSlotIndex[stackSize] = slotIndex;
		stackSize += 1;

		// Remove the peeled key from its other two slots, which may leave them
		// alone in turn. The peeled slot itself is finalised, so it is left.
		const peelOtherSlot = (index: number): void => {
			if (index === slotIndex) {
				return;
			}

			const other = slot(index, hashHigh, hashLow, geometry);
			const otherState = readConstructionWord(slotState, other);
			const otherHigh = readConstructionWord(slotHashHigh, other);
			const otherLow = readConstructionWord(slotHashLow, other);

			const nextState = (otherState - 4) ^ index;
			slotState[other] = nextState;
			slotHashHigh[other] = otherHigh ^ hashHigh;
			slotHashLow[other] = otherLow ^ hashLow;

			if (nextState >> 2 === 1) {
				alone.push(other);
			}
		};

		for (let index = 0; index < 3; index += 1) {
			peelOtherSlot(index);
		}
	}

	if (stackSize !== size) {
		return undefined;
	}

	const fingerprints = new Uint8Array(arrayLength);

	for (let entry = stackSize - 1; entry >= 0; entry -= 1) {
		const hashHigh = readConstructionWord(stackHashHigh, entry);
		const hashLow = readConstructionWord(stackHashLow, entry);
		const slotIndex = readConstructionByte(stackSlotIndex, entry);

		const p0 = slot(0, hashHigh, hashLow, geometry);
		const p1 = slot(1, hashHigh, hashLow, geometry);
		const p2 = slot(2, hashHigh, hashLow, geometry);
		let value = fingerprint(hashHigh, hashLow);

		// Choose the stored byte so that
		//
		// ```
		// fingerprint(hash) ^ fp[p0] ^ fp[p1] ^ fp[p2] === 0
		// ```
		//
		// for this key.
		if (slotIndex !== 0) {
			value ^= readConstructionByte(fingerprints, p0);
		}

		if (slotIndex !== 1) {
			value ^= readConstructionByte(fingerprints, p1);
		}

		if (slotIndex !== 2) {
			value ^= readConstructionByte(fingerprints, p2);
		}

		const position = slotIndex === 0 ? p0 : slotIndex === 1 ? p1 : p2;
		writeConstructionByte(fingerprints, position, value);
	}

	return fingerprints;
}
