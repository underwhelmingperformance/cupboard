import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { StatusCodes } from 'http-status-codes';
import { Agent, fetch as undiciFetch } from 'undici';
import { describe, expect, it } from 'vitest';

import {
	InsecureWorkerUrlError,
	InvalidWorkerUrlBaseError,
	InvalidWorkerUrlError,
	UnreachableHostError
} from '../errors.ts';

import {
	keepAliveFetch,
	parseWorkerUrl,
	reachableFetcher,
	resilientFetcher
} from './transport.ts';

describe('parseWorkerUrl', () => {
	it.each([
		['a bare host', 'https://cupboard.example.workers.dev'],
		['a tenant path', 'https://cupboard.example.workers.dev/t/acme']
	])('accepts %s', (_name, value) => {
		expect(parseWorkerUrl(value).host).toBe('cupboard.example.workers.dev');
	});

	it.each([
		['a bare host', 'https://cupboard.example.workers.dev///', '/'],
		[
			'a tenant path',
			'https://cupboard.example.workers.dev/t/acme///',
			'/t/acme'
		]
	])('removes redundant trailing slashes from %s', (_name, value, pathname) => {
		expect(parseWorkerUrl(value).pathname).toBe(pathname);
	});

	it.each([
		['localhost', 'http://localhost:8787/t/acme'],
		['127.0.0.1', 'http://127.0.0.1:8787/t/acme'],
		['the IPv6 loopback address', 'http://[::1]:8787/t/acme']
	])('accepts plain HTTP to %s', (_name, value) => {
		expect(parseWorkerUrl(value).href).toBe(value);
	});

	it.each([
		['a public host', 'http://cupboard.example.workers.dev/t/acme'],
		[
			'a host that starts with localhost',
			'http://localhost.example.test/t/acme'
		],
		['a private address', 'http://10.0.0.1:8787/t/acme']
	])('rejects plain HTTP to %s', (_name, value) => {
		let thrown: unknown;

		try {
			parseWorkerUrl(value);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toStrictEqual(new InsecureWorkerUrlError(value));
	});

	it('rejects a malformed URL with a typed usage error', () => {
		expect(() => parseWorkerUrl('not a url')).toThrow(InvalidWorkerUrlError);
	});

	it.each([
		['an FTP scheme', 'ftp://cupboard.example.workers.dev/t/acme'],
		['a file scheme', 'file:///tmp/cupboard'],
		['a mail scheme', 'mailto:cupboard@example.test'],
		['a query string', 'https://cupboard.example.workers.dev/t/acme?tab=keys'],
		['a fragment', 'https://cupboard.example.workers.dev/t/acme#copied'],
		['an embedded username', 'https://ci@cupboard.example.workers.dev/t/acme'],
		[
			'embedded credentials',
			'https://ci:secret@cupboard.example.workers.dev/t/acme'
		]
	])('rejects %s in a Worker URL', (_name, value) => {
		expect(() => parseWorkerUrl(value)).toThrow(
			new InvalidWorkerUrlBaseError()
		);
	});
});

// Leaves a Unix socket file without a listener, so a connection to it is
// refused. The socket is in a private directory, so no other process can start
// listening on it.
async function refusingSocket(directory: string): Promise<string> {
	const socketPath = path.join(directory, 'server.sock');
	const child = spawn(
		process.execPath,
		[
			'-e',
			`require('node:net').createServer().listen(${JSON.stringify(socketPath)}, () => process.stdout.write('ready'))`
		],
		{ stdio: ['ignore', 'pipe', 'inherit'] }
	);
	await once(child.stdout, 'data');
	// SIGKILL stops the child before Node removes the socket file.
	child.kill('SIGKILL');
	await once(child, 'exit');

	return socketPath;
}

describe('resilientFetcher', () => {
	it('retries a replay-unsafe request after a refused connection and returns the success', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-refused-'));
		const socketPath = await refusingSocket(directory);
		const agent = new Agent({ connect: { socketPath } });
		let requests = 0;
		const server = createServer((_request, response) => {
			requests += 1;
			response.end('ok');
		});
		const failures: unknown[] = [];
		const viaSocket: typeof fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : input.toString();

			try {
				const response = await undiciFetch(url, {
					method: init?.method,
					dispatcher: agent
				});

				return new Response(await response.text(), {
					status: response.status
				});
			} catch (error) {
				failures.push(error);

				// The server starts accepting connections after the first refusal.
				if (failures.length === 1) {
					await rm(socketPath);
					server.listen(socketPath);
					await once(server, 'listening');
				}

				throw error;
			}
		};

		try {
			const response = await resilientFetcher('replay-unsafe', viaSocket)(
				'http://cupboard.test/token',
				{ method: 'POST', redirect: 'manual' }
			);

			expect({
				status: response.status,
				body: await response.text(),
				requests,
				failures: failures.map((failure) =>
					failure instanceof TypeError &&
					failure.cause instanceof Error &&
					'code' in failure.cause &&
					'syscall' in failure.cause
						? { code: failure.cause.code, syscall: failure.cause.syscall }
						: failure
				)
			}).toStrictEqual({
				status: StatusCodes.OK,
				body: 'ok',
				requests: 1,
				failures: [{ code: 'ECONNREFUSED', syscall: 'connect' }]
			});
		} finally {
			server.close();
			await agent.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe('reachableFetcher', () => {
	const ok = new Response('body');

	it('passes a successful response through unchanged', async () => {
		const fetcher = reachableFetcher(() => Promise.resolve(ok));

		expect(await fetcher('https://cupboard.example.workers.dev')).toBe(ok);
	});

	it('translates a rejected TypeError into a host-named unreachable error', async () => {
		const cause = new TypeError('fetch failed', {
			cause: Object.assign(
				new Error('getaddrinfo ENOTFOUND cupboard.example.workers.dev'),
				{ code: 'ENOTFOUND' }
			)
		});
		const fetcher = reachableFetcher(() => Promise.reject(cause));

		let error: unknown;
		try {
			await fetcher('https://cupboard.example.workers.dev/pubkey');
			error = 'resolved';
		} catch (error_: unknown) {
			error = error_;
		}

		expect(error).toBeInstanceOf(UnreachableHostError);

		if (error instanceof UnreachableHostError) {
			expect({ cause: error.cause, host: error.host }).toStrictEqual({
				cause,
				host: 'cupboard.example.workers.dev'
			});
		}
	});

	it('lets a non-network error propagate unchanged', async () => {
		const failure = new Error('boom');
		const fetcher = reachableFetcher(() => Promise.reject(failure));

		await expect(fetcher('https://cupboard.example.workers.dev')).rejects.toBe(
			failure
		);
	});
});

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
