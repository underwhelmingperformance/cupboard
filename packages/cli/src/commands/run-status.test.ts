import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';

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
