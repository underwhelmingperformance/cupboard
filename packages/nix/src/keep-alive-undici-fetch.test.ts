import { createServer, type Server } from 'node:http';

import {
	Agent,
	type Dispatcher,
	getGlobalDispatcher,
	setGlobalDispatcher
} from 'undici';
import { afterEach, describe, expect, it } from 'vitest';

import { proxiedFetch } from './proxy.ts';
import { fetchPublicObject } from './public-nar-access.ts';
import { openSubstituters } from './substituter.ts';

interface CountingServer {
	readonly port: number;
	readonly connectionsServed: number[];
}

const servers: Server[] = [];
const originalDispatcher = getGlobalDispatcher();
const dispatchers: Dispatcher[] = [];

afterEach(async () => {
	setGlobalDispatcher(originalDispatcher);
	await Promise.all(dispatchers.splice(0).map((agent) => agent.close()));
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => {
			server.close(() => {
				resolve();
			});
		});
	}
});

async function serveCountingConnections(): Promise<CountingServer> {
	const connectionsServed: number[] = [];
	const numbers = new WeakMap<object, number>();
	let connectionCount = 0;
	const server = createServer((request, response) => {
		connectionsServed.push(numbers.get(request.socket) ?? 0);
		response.end('StoreDir: /nix/store\n');
	});
	server.on('connection', (socket) => {
		connectionCount += 1;
		numbers.set(socket, connectionCount);
	});
	servers.push(server);
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new TypeError('The server has no TCP address');
	}

	return { port: address.port, connectionsServed };
}

// The public reach policy rejects loopback addresses, so the test requests a
// public-looking host name and redirects the connection to the loopback server.
function sendToLoopback(port: number): Dispatcher.DispatchInterceptor {
	return (dispatch) => (options, handler) =>
		dispatch(
			{ ...options, origin: `http://127.0.0.1:${String(port)}` },
			handler
		);
}

describe('undici fetchers reuse an idle connection', () => {
	it('sends document reads that follow each other over one connection', async () => {
		const { port, connectionsServed } = await serveCountingConnections();

		for (let query = 0; query < 4; query += 1) {
			await openSubstituters([`http://127.0.0.1:${String(port)}`], {});
		}

		expect(connectionsServed).toStrictEqual([1, 1, 1, 1]);
	});

	it('sends public object reads that follow each other over one connection', async () => {
		const { port, connectionsServed } = await serveCountingConnections();
		const loopbackDispatcher = new Agent().compose(sendToLoopback(port));
		dispatchers.push(loopbackDispatcher);
		setGlobalDispatcher(loopbackDispatcher);
		const signal = new AbortController().signal;

		for (let read = 0; read < 4; read += 1) {
			const response = await fetchPublicObject(
				new URL('http://cache.example/nar/app'),
				{ signal }
			);
			await response.text();
		}

		expect(connectionsServed).toStrictEqual([1, 1, 1, 1]);
	});

	it('sends document reads through a proxy over one connection', async () => {
		const { port, connectionsServed } = await serveCountingConnections();
		const fetcher = proxiedFetch({
			http_proxy: `http://127.0.0.1:${String(port)}`
		});
		if (fetcher === undefined) {
			throw new Error('The proxy settings did not create a fetcher');
		}

		for (let query = 0; query < 4; query += 1) {
			await openSubstituters(['http://cache.example'], { fetch: fetcher });
		}

		expect(connectionsServed).toStrictEqual([1, 1, 1, 1]);
	});
});
