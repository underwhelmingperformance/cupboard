// Bind pass-through methods to the host object because their implementations
// depend on the receiver.
export function passThrough(target: object, property: PropertyKey): unknown {
	const value: unknown = Reflect.get(target, property, target);

	if (typeof value !== 'function') {
		return value;
	}

	const bound: unknown = value.bind(target);

	return bound;
}
