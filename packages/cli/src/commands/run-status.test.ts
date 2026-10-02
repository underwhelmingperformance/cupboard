import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';

import { readResourcesSchema } from '@cupboard/protocol/read-access';
import { expect, it, onTestFinished } from 'vitest';

it.each([
	{
		label: 'a missing executable',
		options: [],
		command: ['/cupboard-test-no-executable/command'],
		status: 127,
		stdout: ''
	},
	{
		label: 'a child failure with output',
		options: [],
		command: [
			process.execPath,
			'-e',
			"process.stdout.write('child output'); process.stderr.write('child error'); process.exit(23)"
		],
		status: 23,
		stdout: 'child output'
	},
	{
		label: 'a child signal',
		options: [],
		command: [process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')"],
		status: 143,
		stdout: ''
	},
	{
		label: 'unavailable OIDC authority',
		options: ['--github-oidc'],
		command: [process.execPath, '-e', "process.stdout.write('must not start')"],
		status: 77,
		stdout: ''
	}
])(
	'preserves the CLI status for $label',
	async ({
		options,
		command,
		status: expectedStatus,
		stdout: expectedStdout
	}) => {
		const child = spawn(
			process.execPath,
			[
				'--experimental-transform-types',
				'--disable-warning=ExperimentalWarning',
				path.resolve(import.meta.dirname, '../main.ts'),
				'--output-mode',
				'json',
				'run',
				'http://127.0.0.1:1/t/acme',
				...options,
				'--',
				...command
			],
			{
				env: {
					...process.env,
					ACTIONS_ID_TOKEN_REQUEST_URL: '',
					ACTIONS_ID_TOKEN_REQUEST_TOKEN: ''
				},
				detached: true,
				stdio: ['ignore', 'pipe', 'pipe']
			}
		);
		let isChildClosed = false;
		const closed = new Promise<void>((resolve) => {
			child.once('close', () => {
				isChildClosed = true;
				resolve();
			});
		});
		onTestFinished(async () => {
			if (!isChildClosed && child.pid !== undefined) {
				try {
					process.kill(-child.pid, 'SIGKILL');
				} catch (error) {
					if (
						!(error instanceof Error) ||
						!('code' in error) ||
						error.code !== 'ESRCH'
					) {
						throw error;
					}
				}
			}
			await closed;
		});
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
			stderr += chunk;
		});
		const status = await new Promise<number | null>((resolve, reject) => {
			child.once('error', reject);
			child.once('close', resolve);
		});
		expect({
			status,
			stdout,
			childErrorForwarded: stderr.startsWith('child error')
		}).toStrictEqual({
			status: expectedStatus,
			stdout: expectedStdout,
			childErrorForwarded: expectedStatus === 23
		});
	},
	30_000
);

it.each([
	{
		status: 400,
		error: 'invalid_authorization_details',
		problem: 'read-resources-not-permitted',
		exitCode: 77,
		oversizedIdentity: false
	},
	{
		status: 400,
		error: 'invalid_request',
		problem: 'invalid-read-resources',
		exitCode: 2,
		oversizedIdentity: false
	},
	{
		status: 503,
		error: 'invalid_grant',
		problem: 'stale-refresh-token',
		exitCode: 75,
		oversizedIdentity: false
	},
	...[200, 401, 503].map((status) => ({
		status,
		error: '',
		problem: 'oversized-identity-response',
		exitCode: status === 401 ? 77 : 75,
		oversizedIdentity: true
	}))
])(
	'preserves OAuth $status $problem through the real run command',
	async ({ status, error, problem, exitCode, oversizedIdentity }) => {
		const requests: string[] = [];
		const server = createServer((request, response) => {
			const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
			requests.push(`${request.method ?? ''} ${pathname}`);
			response.setHeader('content-type', 'application/json');
			if (pathname === '/id-token') {
				if (oversizedIdentity) {
					response.statusCode = status;
					response.setHeader('content-length', '1048577');
					response.end('x'.repeat(1_048_577));
					return;
				}
				response.end(JSON.stringify({ value: 'fixture-identity' }));
				return;
			}
			response.statusCode = status;
			response.end(
				JSON.stringify({
					error,
					problem,
					error_description: 'Fixture authority refusal'
				})
			);
		});
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', resolve);
		});
		try {
			const address = server.address();
			if (address === null || typeof address === 'string') {
				throw new Error('The OAuth fixture did not listen on a TCP port.');
			}
			const origin = `http://127.0.0.1:${String(address.port)}`;
			const child = spawn(
				process.execPath,
				[
					'--experimental-transform-types',
					'--disable-warning=ExperimentalWarning',
					path.resolve(import.meta.dirname, '../main.ts'),
					'--output-mode',
					'json',
					'run',
					`${origin}/t/acme`,
					'--github-oidc',
					'--',
					process.execPath,
					'-e',
					"process.stdout.write('must not start')"
				],
				{
					env: {
						...process.env,
						ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/id-token`,
						ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-token'
					},
					detached: true,
					stdio: ['ignore', 'pipe', 'pipe']
				}
			);
			let isChildClosed = false;
			const closed = new Promise<void>((resolve) => {
				child.once('close', () => {
					isChildClosed = true;
					resolve();
				});
			});
			onTestFinished(async () => {
				if (!isChildClosed && child.pid !== undefined) {
					try {
						process.kill(-child.pid, 'SIGKILL');
					} catch (error) {
						if (
							!(error instanceof Error) ||
							!('code' in error) ||
							error.code !== 'ESRCH'
						) {
							throw error;
						}
					}
				}
				await closed;
			});
			let stdout = '';
			let stderr = '';
			child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
				stderr += chunk;
			});
			const actualStatus = await new Promise<number | null>(
				(resolve, reject) => {
					child.once('error', reject);
					child.once('close', resolve);
				}
			);
			expect({
				status: actualStatus,
				stdout,
				hasRefusal: stderr.includes('Fixture authority refusal'),
				requests
			}).toStrictEqual({
				status: exitCode,
				stdout: '',
				hasRefusal: !oversizedIdentity,
				requests: [
					...(oversizedIdentity ? [] : ['GET /id-token']),
					...Array.from({ length: status === 503 ? 5 : 1 }, () =>
						oversizedIdentity ? 'GET /id-token' : 'POST /t/acme/token'
					)
				]
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		}
	},
	30_000
);

it.each([
	{ mode: 'content', external: false, audience: 'custom-audience' },
	{ mode: 'metadata', external: false, audience: 'custom-audience' },
	{ mode: 'content', external: true, audience: 'custom-audience' },
	{ mode: 'metadata', external: true, audience: 'custom-audience' },
	{ mode: 'content', external: false, audience: '  custom-audience  ' },
	{ mode: 'content', external: false, audience: ' '.repeat(3) },
	{ mode: 'content', external: false, audience: '\u{A0}custom-audience\u{A0}' }
] as const)(
	'passes $mode caches through the real CLI without including an explicit external tenant: $external, with exact audience $audience',
	async ({ mode, external, audience }) => {
		const acquisitions: unknown[] = [];
		const audiences: string[] = [];
		const server = createServer((request, response) => {
			const url = new URL(request.url ?? '/', 'http://localhost');
			response.setHeader('content-type', 'application/json');
			if (url.pathname === '/identity') {
				audiences.push(url.searchParams.get('audience') ?? '');
				response.end(JSON.stringify({ value: 'identity' }));
				return;
			}
			let body = '';
			request.setEncoding('utf8').on('data', (chunk: string) => {
				body += chunk;
			});
			request.on('end', () => {
				const resources: unknown = JSON.parse(
					new URLSearchParams(body).get('read_resources') ?? '[]'
				);
				acquisitions.push(resources);
				response.end(
					JSON.stringify({
						access_token: 'access',
						token_type: 'Bearer',
						expires_in: 900,
						authorization_details: [],
						read_resources: readResourcesSchema
							.parse(resources)
							.map((resource) => ({
								...resource,
								state: { kind: 'existing', access: 'public', priority: 40 }
							}))
					})
				);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', resolve);
		});
		try {
			const address = server.address();
			if (address === null || typeof address === 'string') {
				throw new Error('Expected a TCP address');
			}
			const tenant = `http://127.0.0.1:${String(address.port)}/t/acme`;
			const flag =
				mode === 'content' ? '--read-cache' : '--read-cache-metadata';
			const child = spawn(
				process.execPath,
				[
					'--experimental-transform-types',
					'--disable-warning=ExperimentalWarning',
					path.resolve(import.meta.dirname, '../main.ts'),
					'--output-mode',
					'json',
					'run',
					`${tenant}/cache/builds`,
					'--github-oidc',
					'--audience',
					audience,
					...(mode === 'metadata' ? ['--cache-metadata'] : []),
					flag,
					`${tenant}/cache/falcon`,
					flag,
					tenant,
					'--',
					process.execPath,
					'-e',
					"process.stdout.write('child')"
				],
				{
					env: {
						...process.env,
						NIX_CONFIG: `substituters =\nextra-substituters = ${external ? `http://cupboard:partner%2Fsecret@127.0.0.1:${String(address.port)}/t/partner/cache/deps` : ''}\nnetrc-file = /cupboard-test-missing-netrc`,
						ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${String(address.port)}/identity`,
						ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'secret'
					},
					detached: true,
					stdio: ['ignore', 'pipe', 'pipe']
				}
			);
			let isChildClosed = false;
			const closed = new Promise<void>((resolve) => {
				child.once('close', () => {
					isChildClosed = true;
					resolve();
				});
			});
			onTestFinished(async () => {
				if (!isChildClosed && child.pid !== undefined) {
					try {
						process.kill(-child.pid, 'SIGKILL');
					} catch (error) {
						if (
							!(error instanceof Error) ||
							!('code' in error) ||
							error.code !== 'ESRCH'
						) {
							throw error;
						}
					}
				}
				await closed;
			});
			let stdout = '';
			child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.resume();
			const status = await new Promise<number | null>((resolve, reject) => {
				child.once('error', reject);
				child.once('close', resolve);
			});
			expect({ status, stdout, acquisitions, audiences }).toStrictEqual({
				status: 0,
				stdout: 'child',
				acquisitions: [
					[
						{
							type: 'cupboard_cache',
							cache: { kind: 'named', name: 'builds' },
							mode
						},
						{
							type: 'cupboard_cache',
							cache: { kind: 'named', name: 'falcon' },
							mode
						},
						{ type: 'cupboard_cache', cache: { kind: 'default' }, mode }
					]
				],
				audiences: [audience]
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error === undefined) {
						resolve();
						return;
					}
					reject(error);
				});
			});
		}
	},
	30_000
);
