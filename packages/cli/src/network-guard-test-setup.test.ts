import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { NonLoopbackConnectionError } from './network-guard-error.ts';

// These tests prove that the guard still intercepts what it claims to,
// including the connections `fetch` makes through undici. A release that
// changed the path from `fetch` to `net.Socket.prototype.connect` would leave
// the guard installed but never called, and only a test that tries to connect
// to a refused destination would notice.
//
// The refused destinations cannot reach a real host even when the guard misses
// them: 192.0.2.0/24 is TEST-NET-1, which is reserved for documentation and is
// not routed, and the `.invalid` top-level domain never resolves. A missed
// attempt still fails its assertion, because the connection then throws nothing
// at all, or throws one of Node's own errors in place of the guard's refusal.
const testNetAddress = '192.0.2.1';
const unresolvableName = 'cupboard.invalid';

// How the guard renders an argument it could not read is an implementation
// detail, so the assertion below accepts any string. `expect.any` is typed
// `any`, and naming it here keeps that out of the assertion.
const anyRendering: unknown = expect.any(String);

/**
 * The facts a refusal carries, or the value itself when it is not a refusal, so
 * that a failing assertion reports what did happen.
 */
function guardFacts(failure: unknown): unknown {
	if (!(failure instanceof NonLoopbackConnectionError)) {
		return failure;
	}

	return {
		name: failure.name,
		origin: failure.origin,
		destination: failure.destination
	};
}

/** Makes a fetch request and returns what it rejected with. */
async function fetchFailure(url: string): Promise<unknown> {
	try {
		await fetch(url);
	} catch (error: unknown) {
		return error;
	}

	return undefined;
}

/**
 * Attempts a connection and returns what `connect` threw. A socket that the
 * guard lets through is destroyed at once, so a regressed guard leaves nothing
 * connecting in the background.
 */
function connectionFailure(connect: () => net.Socket): unknown {
	let socket: net.Socket | undefined;

	try {
		socket = connect();
	} catch (error: unknown) {
		return error;
	} finally {
		socket?.destroy();
	}

	return undefined;
}

describe('the loopback guard', () => {
	it('refuses a fetch to a name outside the loopback interface', async ({
		task
	}) => {
		const failure = await fetchFailure(`http://${unresolvableName}/`);

		expect(
			guardFacts(failure instanceof Error ? failure.cause : failure)
		).toStrictEqual({
			name: 'NonLoopbackConnectionError',
			origin: task.fullName,
			destination: { kind: 'host', host: unresolvableName, port: 80 }
		});
	});

	it.for([
		{
			description: 'an address outside loopback',
			connect: (): net.Socket => net.connect(443, testNetAddress),
			destination: { kind: 'host', host: testNetAddress, port: 443 }
		},
		{
			description: 'a name outside loopback',
			connect: (): net.Socket =>
				net.connect({ host: unresolvableName, port: 80 }),
			destination: { kind: 'host', host: unresolvableName, port: 80 }
		}
	])('refuses a socket connection to $description', (testCase, { task }) => {
		expect(guardFacts(connectionFailure(testCase.connect))).toStrictEqual({
			name: 'NonLoopbackConnectionError',
			origin: task.fullName,
			destination: testCase.destination
		});
	});

	// A port of `NaN` is a number, so the type declarations accept it, and the
	// guard refuses it as it refuses every other argument it cannot read. Node
	// would refuse the port itself a moment later, so the assertion also shows
	// that the guard refused the connection first.
	it('refuses a destination it cannot read', ({ task }) => {
		const failure = connectionFailure(() =>
			net.connect({ port: NaN, host: testNetAddress })
		);

		expect(guardFacts(failure)).toStrictEqual({
			name: 'NonLoopbackConnectionError',
			origin: task.fullName,
			destination: { kind: 'unreadable', rendered: anyRendering }
		});
	});

	it('allows a loopback HTTP round trip by address and by name', async () => {
		const server = createServer((_request, response) => {
			response.end('ok');
		});

		server.listen(0, '127.0.0.1');
		await once(server, 'listening');

		try {
			const { port } = z.object({ port: z.number() }).parse(server.address());
			const byAddress = await fetch(`http://127.0.0.1:${String(port)}/`);
			const byName = await fetch(`http://localhost:${String(port)}/`);

			expect([await byAddress.text(), await byName.text()]).toStrictEqual([
				'ok',
				'ok'
			]);
		} finally {
			server.close();
			await once(server, 'close');
		}
	});

	it('allows a unix socket round trip', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-guard-'));
		const server = net.createServer((connection) => {
			connection.end('ok');
		});

		server.listen(path.join(directory, 'socket'));
		await once(server, 'listening');

		try {
			const client = net.connect(path.join(directory, 'socket'));
			const message: unknown = await once(client, 'data');
			const [payload] = z
				.tuple([z.instanceof(Buffer)])
				.rest(z.unknown())
				.parse(message);

			expect(payload.toString()).toBe('ok');
			client.destroy();
		} finally {
			server.close();
			await once(server, 'close');
			await rm(directory, { recursive: true, force: true });
		}
	});
});
