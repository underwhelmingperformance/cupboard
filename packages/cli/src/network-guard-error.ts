/**
 * A destination that the loopback guard can refuse: a host and port outside
 * the loopback interface, or an argument to `connect` that the guard could not
 * read. `rendered` describes that argument for a reader; nothing depends on
 * its shape.
 */
export type RefusedDestination =
	| { readonly kind: 'host'; readonly host: string; readonly port: number }
	| { readonly kind: 'unreadable'; readonly rendered: string };

/**
 * A connection attempt that the loopback guard refused. `origin` is the full
 * name of the test that made the attempt, or `undefined` when the attempt came
 * from outside any test.
 *
 * The class lives here rather than in `network-guard-test-setup.ts` because
 * that module installs the guard as a top-level side effect and exports
 * nothing, as a Vitest setup file should.
 */
export class NonLoopbackConnectionError extends Error {
	constructor(
		public readonly origin: string | undefined,
		public readonly destination: RefusedDestination
	) {
		super(
			`${describeOrigin(origin)} tried to connect to ${describeDestination(destination)}. CLI tests cannot connect beyond the loopback interface: serve the fixture from 127.0.0.1 or a unix socket, or stub the client.`
		);
		this.name = 'NonLoopbackConnectionError';
	}
}

function describeOrigin(origin: string | undefined): string {
	if (origin === undefined) {
		return 'Code outside any test';
	}

	return `The test "${origin}"`;
}

function describeDestination(destination: RefusedDestination): string {
	if (destination.kind === 'unreadable') {
		return `an unreadable destination (${destination.rendered})`;
	}

	return `${destination.host}:${String(destination.port)}`;
}
