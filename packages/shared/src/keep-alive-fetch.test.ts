import { createServer } from 'node:http';

import { describe, expect, it } from 'vitest';

import { keepAliveFetch } from './keep-alive-fetch.ts';

describe('keepAliveFetch', () => {
	it('sends requests that follow each other over one connection', async () => {
		const served: { method: string; connection: number }[] = [];
		const connections = new WeakMap<object, number>();
		let connectionCount = 0;
		const server = createServer((request, response) => {
			served.push({
				method: request.method ?? '',
				connection: connections.get(request.socket) ?? 0
			});
			request.resume();
			request.on('end', () => {
				response.end('body');
			});
		});
		server.on('connection', (socket) => {
			connectionCount += 1;
			connections.set(socket, connectionCount);
		});

		try {
			await new Promise<void>((resolve) => {
				server.listen(0, '127.0.0.1', resolve);
			});
			const address = server.address();
			if (address === null || typeof address === 'string') {
				throw new TypeError('The server has no TCP address');
			}
			const url = `http://127.0.0.1:${String(address.port)}/`;

			for (const method of ['GET', 'POST', 'GET', 'POST']) {
				const response = await keepAliveFetch(url, {
					method,
					...(method === 'POST' && { body: '{}' })
				});
				await response.text();
			}
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => {
				server.close(() => {
					resolve();
				});
			});
		}

		expect(served).toStrictEqual([
			{ method: 'GET', connection: 1 },
			{ method: 'POST', connection: 1 },
			{ method: 'GET', connection: 1 },
			{ method: 'POST', connection: 1 }
		]);
	});
});
