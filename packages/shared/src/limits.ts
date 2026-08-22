declare const positiveSafeIntegerBrand: unique symbol;

export type PositiveSafeInteger = number & {
	readonly [positiveSafeIntegerBrand]: true;
};

/**
 * Validates a count used to bound work or allocate workers. The count must be
 * a positive integer that JavaScript can represent exactly.
 */
export function positiveSafeInteger(
	value: number,
	name: string
): PositiveSafeInteger {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}

	return value as PositiveSafeInteger;
}
