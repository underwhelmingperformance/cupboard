import net from 'node:net';
import { inspect } from 'node:util';

import { afterEach, beforeEach } from 'vitest';
import { z } from 'zod';

import {
	NonLoopbackConnectionError,
	type RefusedDestination
} from './network-guard-error.ts';

// Fails any test that opens a connection to something other than the loopback
// interface.
//
// A test that reaches the network depends on the machine it runs on: its DNS
// resolver, the developer's cached Cloudflare credentials, and the real
// deployment those credentials grant access to. It then passes on that machine
// and fails on every other one. The fixtures that legitimately open sockets all
// stay on this machine: the build hook listener uses a unix socket, the login
// and OAuth suites run stub HTTP servers on 127.0.0.1, and the deploy smoke
// test drives workerd over loopback.
//
// Every outbound TCP and unix-socket connection in the process goes through
// `net.Socket.prototype.connect`, so the guard replaces that one method.
// `fetch` reaches it through undici, which calls `net.connect` for HTTP and
// `tls.connect` for HTTPS, and a `TLSSocket` inherits `connect` from
// `net.Socket`. The check also runs before `connect` resolves a hostname, so
// refusing a destination sends no DNS query either.
//
// A connection attempt from outside any test, such as one from a `beforeAll` or
// an `afterAll` hook, is rejected the same way. Its error reports that the
// attempt came from outside any test, and Vitest attributes it to the hook.

const loopbackHost = 'localhost';

// 127.0.0.0/8 is the IPv4 loopback block, `::1` is the IPv6 loopback address,
// and `::ffff:127.0.0.0/104` is the IPv4 block mapped into IPv6.
const loopbackAddresses = new net.BlockList();

loopbackAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
loopbackAddresses.addAddress('::1', 'ipv6');
loopbackAddresses.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');

/**
 * Where a connection attempt is going, as far as the guard can read it. A unix
 * socket is the only destination that is always allowed, so the other kinds are
 * the ones an error can report.
 */
type Destination =
	RefusedDestination | { readonly kind: 'socket-path'; readonly path: string };

/**
 * `connect` takes a port, a socket path, or an options object, in each case
 * with further optional arguments after it. `net.connect` and
 * `net.createConnection` pass a fourth form that the type declarations do not
 * describe, so the guard reads every argument as `unknown`.
 */
type ConnectArguments = [target: unknown, ...rest: unknown[]];

type SocketConnect = (
	this: net.Socket,
	...parameters: ConnectArguments
) => void;

const socketPathOptionsSchema = z.object({ path: z.string() });
// undici gives the port as a string, which Node accepts as readily as a number.
const hostOptionsSchema = z.object({
	port: z.coerce.number(),
	host: z.string().optional()
});

// The test a connection attempt belongs to. A file's tests run one at a time,
// so one name is enough.
//
// Vitest reads a hook's first parameter to find the fixtures it names, so the
// parameter must be an object-destructuring pattern. A plain name fails every
// file whose tests extend the context.
const running: { testName?: string } = {};

beforeEach(({ task }) => {
	running.testName = task.fullName;
});

afterEach(() => {
	running.testName = undefined;
});

const connectToDestination = readSocketConnect();

// The guarded `connect` needs the socket it was called on, so it is written as
// a method of a subclass. Nothing constructs a `GuardedSocket`: the method's
// property descriptor is installed on `net.Socket.prototype` below, which every
// socket in the process inherits from.
class GuardedSocket extends net.Socket {
	override connect(...parameters: ConnectArguments): this {
		const refused = refusedDestination(readDestination(parameters));

		if (refused !== undefined) {
			throw new NonLoopbackConnectionError(running.testName, refused);
		}

		// `connect` returns the socket it was called on.
		connectToDestination.call(this, ...parameters);

		return this;
	}
}

installGuardedConnect();

/**
 * Reads the `connect` implementation the guard delegates to. The property
 * descriptor carries the same function as `net.Socket.prototype.connect`, which
 * the linter rejects as an unbound method reference.
 */
function readSocketConnect(): SocketConnect {
	const value: unknown = Object.getOwnPropertyDescriptor(
		net.Socket.prototype,
		'connect'
	)?.value;

	if (!isSocketConnect(value)) {
		throw new TypeError('net.Socket.prototype.connect is not a function.');
	}

	return value;
}

function isSocketConnect(value: unknown): value is SocketConnect {
	return typeof value === 'function';
}

function installGuardedConnect(): void {
	const guarded = Object.getOwnPropertyDescriptor(
		GuardedSocket.prototype,
		'connect'
	);

	if (guarded === undefined) {
		throw new TypeError('GuardedSocket declares no connect method.');
	}

	// A class method is not enumerable, and the `connect` it replaces is.
	Object.defineProperty(net.Socket.prototype, 'connect', {
		...guarded,
		enumerable: true
	});
}

function readDestination(parameters: ConnectArguments): Destination {
	const [target, second] = parameters;

	if (typeof target === 'number') {
		return { kind: 'host', host: readHost(second), port: target };
	}

	if (typeof target === 'string') {
		return readStringTarget(target, second);
	}

	return readOptions(unwrapNormalisedArguments(target));
}

/**
 * Node reads a string target as a port number when the string parses as a
 * number that is not negative, and as a socket path otherwise.
 */
function readStringTarget(target: string, second: unknown): Destination {
	const port = Number(target);

	if (Number.isNaN(port) || port < 0) {
		return { kind: 'socket-path', path: target };
	}

	return { kind: 'host', host: readHost(second), port };
}

function readHost(second: unknown): string {
	return typeof second === 'string' ? second : loopbackHost;
}

/**
 * `net.connect` and `net.createConnection` normalise their own arguments and
 * then pass `connect` the resulting `[options, listener]` array as a single
 * argument.
 */
function unwrapNormalisedArguments(target: unknown): unknown {
	const parsed = z.array(z.unknown()).safeParse(target);

	return parsed.success ? parsed.data[0] : target;
}

function readOptions(options: unknown): Destination {
	const socketPath = socketPathOptionsSchema.safeParse(options);

	if (socketPath.success) {
		return { kind: 'socket-path', path: socketPath.data.path };
	}

	const host = hostOptionsSchema.safeParse(options);

	if (host.success) {
		return {
			kind: 'host',
			host: host.data.host ?? loopbackHost,
			port: host.data.port
		};
	}

	return { kind: 'unreadable', rendered: inspect(options, { depth: 0 }) };
}

/**
 * The destination to report in the error, or `undefined` when the connection
 * may go ahead. A unix socket cannot leave the machine, so it is always
 * allowed. A destination the guard cannot read is refused as well, because the
 * guard cannot tell whether that connection would stay on loopback.
 */
function refusedDestination(
	destination: Destination
): RefusedDestination | undefined {
	if (destination.kind === 'socket-path') {
		return undefined;
	}

	if (destination.kind === 'unreadable') {
		return destination;
	}

	return isLoopbackHost(destination.host) ? undefined : destination;
}

function isLoopbackHost(host: string): boolean {
	if (net.isIPv4(host)) {
		return loopbackAddresses.check(host, 'ipv4');
	}

	if (net.isIPv6(host)) {
		return loopbackAddresses.check(host, 'ipv6');
	}

	// RFC 6761 reserves `localhost`, and the names under it, for the loopback
	// interface.
	return host === loopbackHost || host.endsWith(`.${loopbackHost}`);
}
