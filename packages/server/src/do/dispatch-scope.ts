/**
 * Wraps every method on `prototype` so each dispatch runs inside `scope`.
 *
 * A Durable Object applies this to its prototype once. The wrapper then covers
 * every method the runtime can dispatch, including requests, alarms, RPCs and
 * methods added later, so no dispatched method has to open the scope itself.
 *
 * A static initialiser wraps the prototype once. A Proxy over each instance
 * would instead intercept every property read, which the commit fan-out
 * performs constantly, so the prototype is the cheaper place for the wrapper.
 *
 * `scope` must reuse an enclosing scope when one is already open. A method that
 * calls another method of the same object enters a nested scope, and the
 * invocation still has exactly one.
 */
export function wrapDispatchedMethods(
	prototype: object,
	scope: (body: () => unknown) => unknown
): void {
	for (const property of Object.getOwnPropertyNames(prototype)) {
		if (property === 'constructor') {
			continue;
		}

		const descriptor = Object.getOwnPropertyDescriptor(prototype, property);

		if (descriptor === undefined) {
			continue;
		}

		const method: unknown = descriptor.value;

		// Only function-valued data properties represent dispatched methods.
		if (typeof method !== 'function') {
			continue;
		}

		Object.defineProperty(prototype, property, {
			...descriptor,
			value: function (this: unknown, ...parameters: unknown[]): unknown {
				return scope((): unknown => Reflect.apply(method, this, parameters));
			}
		});
	}
}
