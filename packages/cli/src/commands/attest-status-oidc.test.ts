import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import {
	createServer,
	type IncomingMessage,
	type ServerResponse
} from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { attestationInfoCapability } from '@cupboard/protocol/attestations';
import { cacheMetadataCapabilityHeader } from '@cupboard/protocol/cache-metadata';
import { bestEffort } from '@cupboard/shared/cleanup';
import { Command } from 'commander';
import { expect, it, onTestFinished, vi } from 'vitest';

import { abortable } from '../abort.ts';

import { registerAttestStatusCommand } from './attest-status.ts';

it('renews OIDC read access between coverage pages and removes its credential file', async () => {
	const hashes = ['0'.repeat(32), '1'.repeat(32)];
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-status-oidc-'));
	const started = Promise.withResolvers<undefined>();
	const resume = Promise.withResolvers<undefined>();
	const renewed = Promise.withResolvers<undefined>();
	const waits: {
		readonly milliseconds: number;
		readonly resume: VoidFunction;
	}[] = [];
	const requests: (string | undefined)[] = [];
	const audiences: (string | undefined)[] = [];
	const intents: unknown[] = [];
	const handle = async (
		request: IncomingMessage,
		response: ServerResponse
	): Promise<void> => {
		const requestUrl = new URL(request.url ?? '/', url);
		if (requestUrl.pathname === '/job-token') {
			audiences.push(requestUrl.searchParams.get('audience') ?? undefined);
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify({ value: 'signed-identity' }));
			return;
		}
		if (requestUrl.pathname === '/t/acme/token') {
			let body = '';
			for await (const chunk of request) {
				body += String(chunk);
			}
			const form = new URLSearchParams(body);
			intents.push(JSON.parse(form.get('read_resources') ?? 'null'));
			response.setHeader('content-type', 'application/json');
			response.end(
				JSON.stringify({
					access_token: `token-${String(intents.length)}`,
					token_type: 'Bearer',
					expires_in: 310,
					authorization_details: [],
					read_resources: [
						{
							type: 'cupboard_cache',
							cache: { kind: 'default' },
							mode: 'content',
							state: { kind: 'existing', access: 'private', priority: 40 }
						}
					]
				})
			);
			return;
		}
		requests.push(request.headers.authorization);
		if (requestUrl.pathname === '/t/acme/nix-cache-info') {
			response.setHeader(
				cacheMetadataCapabilityHeader,
				attestationInfoCapability
			);
			response.end('StoreDir: /nix/store\n');
			return;
		}
		const isFirst = requests.length === 2;
		if (isFirst) {
			started.resolve(undefined);
			await resume.promise;
		}
		response.setHeader('content-type', 'application/json');
		response.end(
			JSON.stringify({
				scopeVersion: 'current',
				entries: [
					{ storePathHash: isFirst ? hashes[0] : hashes[1], status: 'missing' }
				],
				...(isFirst && { nextIndex: 1 })
			})
		);
	};
	const server = createServer((request, response) => {
		void handle(request, response).catch((error: unknown) => {
			response.destroy(
				error instanceof Error ? error : new Error('Loopback service failed.')
			);
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('Expected a TCP test server.');
	}
	const url = `http://127.0.0.1:${String(address.port)}/t/acme`;
	let now = 0;

	vi.stubEnv('RUNNER_TEMP', directory);
	vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', new URL('/job-token', url).href);
	vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'job-secret');
	vi.stubEnv('CUPBOARD_READ_USER', undefined);
	vi.stubEnv('CUPBOARD_READ_PASSWORD', undefined);
	const controller = new AbortController();
	const program = new Command().exitOverride();
	registerAttestStatusCommand(
		program.command('attest'),
		program,
		{ signal: controller.signal },
		{
			now: () => now,
			wait: (milliseconds, signal) => {
				const pending = Promise.withResolvers<undefined>();
				waits.push({
					milliseconds,
					resume: () => {
						pending.resolve(undefined);
					}
				});
				if (waits.length === 3) {
					renewed.resolve(undefined);
				}
				return abortable(pending.promise, signal);
			}
		}
	);
	const operation = program.parseAsync(
		[
			'attest',
			'status',
			url,
			...hashes.map((hash) => `/nix/store/${hash}-app`),
			'--github-oidc',
			'--audience',
			'https://audience.example'
		],
		{ from: 'user' }
	);
	let cleanupPromise: Promise<void> | undefined;
	const cleanup = (): Promise<void> => {
		cleanupPromise ??= (async () => {
			controller.abort();
			resume.resolve(undefined);
			try {
				await bestEffort(() => operation);
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) => {
					server.close((error) => {
						if (error !== undefined) {
							reject(error);
							return;
						}
						resolve();
					});
				});
			} finally {
				vi.unstubAllEnvs();
				await rm(directory, { recursive: true, force: true });
			}
		})();
		return cleanupPromise;
	};
	onTestFinished(cleanup);
	try {
		await Promise.race([started.promise, operation]);
		const firstWait = waits[0];
		expect(firstWait?.milliseconds).toBe(10_000);
		now = 10_000;
		firstWait?.resume();
		await Promise.race([renewed.promise, operation]);
		expect(intents).toStrictEqual(
			Array.from({ length: 2 }, () => [
				{
					type: 'cupboard_cache',
					cache: { kind: 'default' },
					mode: 'content'
				}
			])
		);
		const [temporary] = await readdir(directory);
		if (temporary === undefined) {
			throw new Error('Expected the protected credential directory.');
		}
		expect(
			await readFile(path.join(directory, temporary, 'netrc'), 'utf8')
		).toContain('token-2');
		resume.resolve(undefined);
		await operation;
		expect({
			requests,
			audiences,
			waits: waits.map(({ milliseconds }) => milliseconds),
			remainingFiles: await readdir(directory)
		}).toStrictEqual({
			requests: ['token-1', 'token-1', 'token-2'].map(
				(token) =>
					`Basic ${Buffer.from(`cupboard-oidc:cupboard-access+jwt:${token}`).toString('base64')}`
			),
			audiences: ['https://audience.example', 'https://audience.example'],
			waits: [10_000, 270_000, 10_000],
			remainingFiles: []
		});
	} finally {
		await cleanup();
	}
});
