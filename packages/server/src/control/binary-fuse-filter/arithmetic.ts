// JavaScript bitwise operators work on 32-bit words, so every 64-bit value in
// the filter is represented as an unsigned high/low pair.

const murmurConstantAHigh = 0xff_51_af_d7;
const murmurConstantALow = 0xed_55_8c_cd;
const murmurConstantBHigh = 0xc4_ce_b9_fe;
const murmurConstantBLow = 0x1a_85_ec_53;
const splitmixIncrementHigh = 0x9e_37_79_b9;
const splitmixIncrementLow = 0x7f_4a_7c_15;
const splitmixConstantAHigh = 0xbf_58_47_6d;
const splitmixConstantALow = 0x1c_e4_e5_b9;
const splitmixConstantBHigh = 0x94_d0_49_bb;
const splitmixConstantBLow = 0x13_31_11_eb;

export function addLow(leftLow: number, rightLow: number): number {
	return (leftLow + rightLow) >>> 0;
}

export function addHigh(
	leftHigh: number,
	leftLow: number,
	rightHigh: number,
	rightLow: number
): number {
	const low = addLow(leftLow, rightLow);
	const carry = low < leftLow ? 1 : 0;

	return (leftHigh + rightHigh + carry) >>> 0;
}

export function shiftRightHigh(high: number, bits: number): number {
	if (bits === 0) {
		return high;
	}

	if (bits < 32) {
		return high >>> bits;
	}

	return 0;
}

export function shiftRightLow(high: number, low: number, bits: number): number {
	if (bits === 0) {
		return low;
	}

	if (bits < 32) {
		return ((low >>> bits) | (high << (32 - bits))) >>> 0;
	}

	if (bits === 32) {
		return high;
	}

	return high >>> (bits - 32);
}

function multiply32To64High(left: number, right: number): number {
	const leftLow = left & 0xff_ff;
	const leftHigh = left >>> 16;
	const rightLow = right & 0xff_ff;
	const rightHigh = right >>> 16;

	// Some 16-bit products exceed 2^31 and come back from Math.imul as negative;
	// the final shifts and masks intentionally read those values modulo 2^32.
	const lowProduct = Math.imul(leftLow, rightLow);
	let middle = (lowProduct >>> 16) + Math.imul(leftHigh, rightLow);
	const carry = middle >>> 16;
	middle = (middle & 0xff_ff) + Math.imul(leftLow, rightHigh);

	return (Math.imul(leftHigh, rightHigh) + carry + (middle >>> 16)) >>> 0;
}

function multiply32To64Low(left: number, right: number): number {
	const leftLow = left & 0xff_ff;
	const leftHigh = left >>> 16;
	const rightLow = right & 0xff_ff;
	const rightHigh = right >>> 16;

	const lowProduct = Math.imul(leftLow, rightLow);
	let middle = (lowProduct >>> 16) + Math.imul(leftHigh, rightLow);
	middle = (middle & 0xff_ff) + Math.imul(leftLow, rightHigh);

	return (((middle & 0xff_ff) << 16) | (lowProduct & 0xff_ff)) >>> 0;
}

export function multiply64LowHigh(
	leftHigh: number,
	leftLow: number,
	rightHigh: number,
	rightLow: number
): number {
	const lowProductHigh = multiply32To64High(leftLow, rightLow);
	const cross =
		(Math.imul(leftLow, rightHigh) + Math.imul(leftHigh, rightLow)) >>> 0;

	return (lowProductHigh + cross) >>> 0;
}

export function multiply64LowLow(leftLow: number, rightLow: number): number {
	return multiply32To64Low(leftLow, rightLow);
}

export function writeMurmur64(
	outputHighs: Uint32Array,
	outputLows: Uint32Array,
	index: number,
	high: number,
	low: number
): void {
	let hashHigh = high;
	let hashLow = low;

	// Murmur's finaliser is a sequence of xor-shifts and 64-bit multiplications.
	// The shifted high and low halves must both be computed from the same input
	// word before either half is overwritten.
	let shiftedHigh = shiftRightHigh(hashHigh, 33);
	let shiftedLow = shiftRightLow(hashHigh, hashLow, 33);
	hashHigh = (hashHigh ^ shiftedHigh) >>> 0;
	hashLow = (hashLow ^ shiftedLow) >>> 0;
	let nextHigh = multiply64LowHigh(
		hashHigh,
		hashLow,
		murmurConstantAHigh,
		murmurConstantALow
	);
	let nextLow = multiply64LowLow(hashLow, murmurConstantALow);
	hashHigh = nextHigh;
	hashLow = nextLow;

	shiftedHigh = shiftRightHigh(hashHigh, 33);
	shiftedLow = shiftRightLow(hashHigh, hashLow, 33);
	hashHigh = (hashHigh ^ shiftedHigh) >>> 0;
	hashLow = (hashLow ^ shiftedLow) >>> 0;
	nextHigh = multiply64LowHigh(
		hashHigh,
		hashLow,
		murmurConstantBHigh,
		murmurConstantBLow
	);
	nextLow = multiply64LowLow(hashLow, murmurConstantBLow);
	hashHigh = nextHigh;
	hashLow = nextLow;

	shiftedHigh = shiftRightHigh(hashHigh, 33);
	shiftedLow = shiftRightLow(hashHigh, hashLow, 33);
	hashHigh = (hashHigh ^ shiftedHigh) >>> 0;
	hashLow = (hashLow ^ shiftedLow) >>> 0;
	outputHighs[index] = hashHigh >>> 0;
	outputLows[index] = hashLow >>> 0;
}

export function writeSeededMurmur64(
	outputHighs: Uint32Array,
	outputLows: Uint32Array,
	index: number,
	keyHigh: number,
	keyLow: number,
	seedHigh: number,
	seedLow: number
): void {
	writeMurmur64(
		outputHighs,
		outputLows,
		index,
		addHigh(keyHigh, keyLow, seedHigh, seedLow),
		addLow(keyLow, seedLow)
	);
}

export function splitmix64(
	stateHigh: number,
	stateLow: number
): {
	readonly high: number;
	readonly low: number;
	readonly nextHigh: number;
	readonly nextLow: number;
} {
	const nextHigh = addHigh(
		stateHigh,
		stateLow,
		splitmixIncrementHigh,
		splitmixIncrementLow
	);
	const nextLow = addLow(stateLow, splitmixIncrementLow);
	let high = nextHigh;
	let low = nextLow;

	let shiftedHigh = shiftRightHigh(high, 30);
	let shiftedLow = shiftRightLow(high, low, 30);
	high = (high ^ shiftedHigh) >>> 0;
	low = (low ^ shiftedLow) >>> 0;
	let multipliedHigh = multiply64LowHigh(
		high,
		low,
		splitmixConstantAHigh,
		splitmixConstantALow
	);
	let multipliedLow = multiply64LowLow(low, splitmixConstantALow);
	high = multipliedHigh;
	low = multipliedLow;

	shiftedHigh = shiftRightHigh(high, 27);
	shiftedLow = shiftRightLow(high, low, 27);
	high = (high ^ shiftedHigh) >>> 0;
	low = (low ^ shiftedLow) >>> 0;
	multipliedHigh = multiply64LowHigh(
		high,
		low,
		splitmixConstantBHigh,
		splitmixConstantBLow
	);
	multipliedLow = multiply64LowLow(low, splitmixConstantBLow);
	high = multipliedHigh;
	low = multipliedLow;

	shiftedHigh = shiftRightHigh(high, 31);
	shiftedLow = shiftRightLow(high, low, 31);
	high = (high ^ shiftedHigh) >>> 0;
	low = (low ^ shiftedLow) >>> 0;

	return {
		high,
		low,
		nextHigh,
		nextLow
	};
}

// The high 64 bits of the 96-bit product because `range` is a 32-bit value.
export function mulhi(high: number, low: number, range: number): number {
	const highProductHigh = multiply32To64High(high, range);
	const highProductLow = multiply32To64Low(high, range);
	const lowProductHigh = multiply32To64High(low, range);
	const carry = lowProductHigh + highProductLow > 0xff_ff_ff_ff ? 1 : 0;

	return (highProductHigh + carry) >>> 0;
}
