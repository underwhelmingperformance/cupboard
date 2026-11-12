/**
Wraps every method on `prototype` so each dispatch runs inside `scope`.

A Durable Object applies this to its prototype once. The wrapper then covers
every method the runtime can dispatch, including requests, alarms, RPCs and
methods added later, so no dispatched method has to open the scope itself.

A static initialiser wraps the prototype once. A Proxy over each instance
would instead intercept every property read, which the commit fan-out
performs constantly, so the prototype is the cheaper place for the wrapper.

`scope` must reuse an enclosing scope when one is already open. A method that
calls another method of the same object enters a nested scope, and the
invocation still has exactly one.

`scope` also receives the dispatching object, so it can read
instance-specific configuration. It also receives the dispatched method's
name.

A subclass sets `includeInherited` to wrap the methods that it inherits too.
The wrappers are defined on `prototype` only, so the superclass keeps its own
methods.
*/
export function wrapDispatchedMethods<T extends object>(
	prototype: T,
	scope: (body: () => unknown, receiver: T, method: string) => unknown,
	options: { readonly includeInherited?: boolean } = {}
): void {
	for (const property of dispatchedProperties(prototype, options)) {
		const descriptor = findDescriptor(prototype, property, options);

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
			value: function (this: T, ...parameters: unknown[]): unknown {
				return scope(
					(): unknown => Reflect.apply(method, this, parameters),
					this,
					property
				);
			}
		});
	}
}

/**
Lists the property names of `prototype`, and of the prototypes that it
inherits from when `includeInherited` is set. The list leaves out
`constructor` and everything that `Object.prototype` defines.
*/
function dispatchedProperties(
	prototype: object,
	options: { readonly includeInherited?: boolean }
): Set<string> {
	const names = new Set<string>();

	for (const owner of prototypeChain(prototype, options)) {
		for (const name of Object.getOwnPropertyNames(owner)) {
			names.add(name);
		}
	}

	names.delete('constructor');

	return names;
}

/**
Finds the descriptor that a call to the property reaches. It is the first
descriptor along the chain, which is the descriptor of `prototype` itself
unless `includeInherited` is set.
*/
function findDescriptor(
	prototype: object,
	property: string,
	options: { readonly includeInherited?: boolean }
): PropertyDescriptor | undefined {
	for (const owner of prototypeChain(prototype, options)) {
		const descriptor = Object.getOwnPropertyDescriptor(owner, property);

		if (descriptor !== undefined) {
			return descriptor;
		}
	}

	return undefined;
}

function* prototypeChain(
	prototype: object,
	options: { readonly includeInherited?: boolean }
): Generator<object> {
	let owner: object | undefined = prototype;

	while (owner !== undefined && owner !== Object.prototype) {
		yield owner;

		if (options.includeInherited !== true) {
			return;
		}

		const parent: unknown = Object.getPrototypeOf(owner);
		owner = typeof parent === 'object' && parent !== null ? parent : undefined;
	}
}
