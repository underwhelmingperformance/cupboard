/**
 * Serialises JSON with object keys sorted at every level.
 *
 * Arrays retain their declared order because deployment manifests use array
 * order for migrations and transitions.
 */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
	}

	if (typeof value === 'object' && value !== null) {
		const entries = Object.entries(value)
			.toSorted(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);

		return `{${entries.join(',')}}`;
	}

	if (
		value === undefined ||
		typeof value === 'function' ||
		typeof value === 'symbol'
	) {
		throw new TypeError('The value is not representable as canonical JSON');
	}

	return JSON.stringify(value);
}
