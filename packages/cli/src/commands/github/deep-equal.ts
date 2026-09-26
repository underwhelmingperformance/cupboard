export function isDeepEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) {
		return true;
	}

	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => isDeepEqual(value, right[index]))
		);
	}

	if (
		typeof left !== 'object' ||
		typeof right !== 'object' ||
		left === null ||
		right === null
	) {
		return false;
	}

	const leftEntries = Object.entries(left);
	const rightEntries = new Map<string, unknown>(Object.entries(right));

	return (
		leftEntries.length === rightEntries.size &&
		leftEntries.every(
			([key, value]) =>
				rightEntries.has(key) && isDeepEqual(value, rightEntries.get(key))
		)
	);
}
