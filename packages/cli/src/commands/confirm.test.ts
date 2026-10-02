import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { fakeCliUi } from '@cupboard/cli-ui/testing';
import { InvalidStorePathError } from '@cupboard/nix-store/errors';
import { cacheNameSchema, type CacheScope } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	type UploadConfirmedPathInput,
	uploadConfirmMaxPaths,
	type UploadConfirmResponse,
	uploadConfirmResponseSchema
} from '@cupboard/protocol/upload';
import type { ResultRow } from '@cupboard/reporter';
import { maxTransientRetries } from '@cupboard/shared/retry';
import { Command } from 'commander';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { describe, expect, it, onTestFinished } from 'vitest';

import { cliExitCode } from '../cli.ts';
import { recordingCacheScopedClient } from '../client/cache-scoped.test-support.ts';
import type { TokenProvider } from '../client/credentials.ts';
import {
	AdminApiTransientError,
	CliAbortError,
	ConfirmIncompleteError,
	PathsNotConfirmedError,
	ScopeForbiddenError,
	SessionRejectedError
} from '../errors.ts';

import {
	type ConfirmClient,
	registerConfirmCommand,
	runConfirm
} from './confirm.ts';

function inputFailure(error: unknown): unknown {
	if (!(error instanceof Error)) {
		return error;
	}
	return {
		name: error.name,
		message: error.message,
		cause: error.cause,
		exitCode: cliExitCode(error, 130)
	};
}

function expectConfirmIncomplete(
	error: unknown
): asserts error is ConfirmIncompleteError {
	expect(error).toBeInstanceOf(ConfirmIncompleteError);
}

const appPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const runtimePath = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime';
const appHash = StorePath.hash(appPath);
const runtimeHash = StorePath.hash(runtimePath);
const defaultCache: CacheScope = { kind: 'default' };
const namedCache: CacheScope = {
	kind: 'named',
	name: cacheNameSchema.parse('pr-1')
};

function confirmClient(response: UploadConfirmResponse): ConfirmClient {
	return {
		confirm: recordingCacheScopedClient(() => Promise.resolve(response))
	};
}

describe('runConfirm', () => {
	it('resolves store paths to hashes and calls confirm against the exact cache', async () => {
		const { ui } = fakeCliUi();
		const confirm = recordingCacheScopedClient(() =>
			Promise.resolve({
				paths: [
					{ storePathHash: appHash, confirmed: true, grace: {} },
					{ storePathHash: runtimeHash, confirmed: true, grace: {} }
				]
			})
		);

		await runConfirm(namedCache, [appPath, runtimePath], ui.reporter(), {
			confirm
		});

		expect(confirm.calls).toStrictEqual([
			{
				cache: namedCache,
				input: {
					cacheName: 'pr-1',
					storePathHashes: [appHash, runtimeHash]
				}
			}
		]);
	});

	it('addresses the default cache by the bare path', async () => {
		const { ui } = fakeCliUi();
		const confirm = recordingCacheScopedClient(() =>
			Promise.resolve({
				paths: [{ storePathHash: appHash, confirmed: true, grace: {} }]
			})
		);

		await runConfirm(defaultCache, [appPath], ui.reporter(), { confirm });

		expect(confirm.calls).toStrictEqual([
			{ cache: defaultCache, input: { storePathHashes: [appHash] } }
		]);
	});

	it.each<{
		name: string;
		path: UploadConfirmedPathInput;
		row: ResultRow;
	}>([
		{
			name: 'a confirmed path with a stored deadline',
			path: {
				storePathHash: appHash,
				confirmed: true,
				grace: { retainUntil: '2026-01-02T00:00:00.000Z' }
			},
			row: { label: appHash, value: 'kept until 2026-01-02 00:00 UTC' }
		},
		{
			name: 'a confirmed path without cache grace',
			path: { storePathHash: appHash, confirmed: true, grace: {} },
			row: { label: appHash, value: 'no cache retention grace configured' }
		},
		{
			name: 'an unconfirmed path',
			path: { storePathHash: appHash, confirmed: false },
			row: { label: appHash, value: 'not present' }
		}
	])('reports a row for $name', async ({ path, row }) => {
		const { ui, captured } = fakeCliUi();
		const response = uploadConfirmResponseSchema.parse({ paths: [path] });

		try {
			await runConfirm(
				defaultCache,
				[appPath],
				ui.reporter(),
				confirmClient(response)
			);
		} catch (error: unknown) {
			// An unconfirmed path fails the command after reporting; caught here so
			// the row assertion below still runs for that case.
			expect(error).toBeInstanceOf(PathsNotConfirmedError);
		}

		expect(captured.results).toStrictEqual([
			{ kind: 'confirm-paths', data: response, rows: [row] }
		]);
	});

	it('exits non-zero naming every unconfirmed path when any path is not confirmed', async () => {
		const { ui } = fakeCliUi();
		const response = uploadConfirmResponseSchema.parse({
			paths: [
				{ storePathHash: appHash, confirmed: true, grace: {} },
				{ storePathHash: runtimeHash, confirmed: false }
			]
		});

		let error: unknown;

		try {
			await runConfirm(
				defaultCache,
				[appPath, runtimePath],
				ui.reporter(),
				confirmClient(response)
			);
		} catch (error_: unknown) {
			error = error_;
		}

		expect(error).toBeInstanceOf(PathsNotConfirmedError);

		if (error instanceof PathsNotConfirmedError) {
			expect(error.storePaths).toStrictEqual([runtimePath]);
		}
	});

	it('does not throw when every path confirms', async () => {
		const { ui } = fakeCliUi();
		const response = uploadConfirmResponseSchema.parse({
			paths: [{ storePathHash: appHash, confirmed: true, grace: {} }]
		});

		await expect(
			runConfirm(
				defaultCache,
				[appPath],
				ui.reporter(),
				confirmClient(response)
			)
		).resolves.toBeUndefined();
	});

	it.each([
		{
			kind: 'generic',
			rejection: new Error('the second request failed'),
			exitCode: 1
		},
		{
			kind: 'temporary',
			rejection: new AdminApiTransientError(503, 'SERVICE_UNAVAILABLE'),
			exitCode: 75
		},
		{ kind: 'session', rejection: new SessionRejectedError(), exitCode: 77 },
		{ kind: 'scope', rejection: new ScopeForbiddenError(), exitCode: 77 }
	])(
		'reports completed batches and preserves a $kind failure status',
		async ({ rejection, exitCode }) => {
			const { ui, captured } = fakeCliUi();
			const storePaths = Array.from(
				{ length: uploadConfirmMaxPaths + 2 },
				(_, index) =>
					`/nix/store/${String(index).padStart(32, '0')}-path-${String(index)}`
			);
			let requests = 0;

			let error: unknown;

			try {
				await runConfirm(defaultCache, storePaths, ui.reporter(), {
					confirm: recordingCacheScopedClient((input) => {
						requests += 1;

						if (requests > 1) {
							return Promise.reject(rejection);
						}

						return Promise.resolve(
							uploadConfirmResponseSchema.parse({
								paths: input.storePathHashes.map((storePathHash) => ({
									storePathHash,
									confirmed: true,
									grace: {}
								}))
							})
						);
					})
				});
			} catch (error_: unknown) {
				error = error_;
			}

			expectConfirmIncomplete(error);
			expect({
				confirmedBatches: error.confirmedBatches,
				totalBatches: error.totalBatches,
				cause: error.cause,
				exitCode: cliExitCode(error, 130),
				results: captured.results
			}).toStrictEqual({
				confirmedBatches: 1,
				totalBatches: 2,
				cause: rejection,
				exitCode,
				results: [
					{
						kind: 'confirm-paths',
						data: {
							paths: storePaths
								.slice(0, uploadConfirmMaxPaths)
								.map((storePath) => ({
									storePathHash: StorePath.hash(storePath),
									confirmed: true,
									grace: {}
								}))
						},
						rows: storePaths
							.slice(0, uploadConfirmMaxPaths)
							.map((storePath) => ({
								label: StorePath.hash(storePath),
								value: 'no cache retention grace configured'
							}))
					}
				]
			});
		}
	);

	it('preserves an abort after reporting batches that already answered', async () => {
		const { ui, captured } = fakeCliUi();
		const storePaths = Array.from(
			{ length: uploadConfirmMaxPaths + 1 },
			(_, index) =>
				`/nix/store/${String(index).padStart(32, '0')}-path-${String(index)}`
		);
		const abort = new CliAbortError();
		let requests = 0;

		const pending = runConfirm(defaultCache, storePaths, ui.reporter(), {
			confirm: recordingCacheScopedClient((input) => {
				requests += 1;

				if (requests > 1) {
					return Promise.reject(abort);
				}

				return Promise.resolve(
					uploadConfirmResponseSchema.parse({
						paths: input.storePathHashes.map((storePathHash) => ({
							storePathHash,
							confirmed: true,
							grace: {}
						}))
					})
				);
			})
		});

		await expect(pending).rejects.toBe(abort);
		expect(captured.results).toHaveLength(1);
		expect(captured.results[0]?.rows).toHaveLength(uploadConfirmMaxPaths);
	});

	// The server bounds one confirm request, so a closure past the bound goes
	// out as sequential requests and comes back as one report in request
	// order.
	it('splits a closure above the request bound and merges the report', async () => {
		const { ui, captured } = fakeCliUi();
		const storePaths = Array.from(
			{ length: uploadConfirmMaxPaths + 2 },
			(_, index) =>
				`/nix/store/${String(index).padStart(32, '0')}-path-${String(index)}`
		);
		const hashes = storePaths.map((storePath) => StorePath.hash(storePath));
		const calls: string[][] = [];

		await runConfirm(defaultCache, storePaths, ui.reporter(), {
			confirm: recordingCacheScopedClient((input) => {
				calls.push(input.storePathHashes);

				return Promise.resolve(
					uploadConfirmResponseSchema.parse({
						paths: input.storePathHashes.map((storePathHash) => ({
							storePathHash,
							confirmed: true,
							grace: {}
						}))
					})
				);
			})
		});

		expect({
			calls: calls.map((batch) => batch.length),
			firstCallLeadsWith: calls[0]?.[0],
			reportedRows: captured.results[0]?.rows.length
		}).toStrictEqual({
			calls: [uploadConfirmMaxPaths, 2],
			firstCallLeadsWith: hashes[0],
			reportedRows: uploadConfirmMaxPaths + 2
		});
	});
});

describe('confirm command', () => {
	it.each([
		{ status: 403, code: 'FORBIDDEN', exitCode: 77, failedRequests: 1 },
		{
			status: 503,
			code: 'SERVICE_UNAVAILABLE',
			exitCode: 75,
			failedRequests: maxTransientRetries + 1
		}
	])(
		'preserves status $exitCode in the real CLI after a later HTTP $status batch fails',
		async ({ status, code, exitCode, failedRequests }) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-confirm-partial-')
			);
			const storePaths = Array.from(
				{ length: uploadConfirmMaxPaths + 1 },
				(_, index) =>
					`/nix/store/${String(index).padStart(32, '0')}-path-${String(index)}`
			);
			const confirmed = storePaths
				.slice(0, uploadConfirmMaxPaths)
				.map((storePath) => ({
					storePathHash: StorePath.hash(storePath),
					confirmed: true,
					grace: {}
				}));
			const calls: { method: string | undefined; url: string | undefined }[] =
				[];
			const server = createServer((request, response) => {
				calls.push({ method: request.method, url: request.url });
				request.resume();
				response.writeHead(calls.length === 1 ? 200 : status, {
					'content-type': 'application/json',
					'retry-after': '0'
				});
				response.end(
					JSON.stringify(
						calls.length === 1
							? { paths: confirmed }
							: { defined: true, code, status, message: 'later batch refused' }
					)
				);
			});
			try {
				await new Promise<void>((resolve) => {
					server.listen(0, '127.0.0.1', resolve);
				});
				const address = server.address();
				if (address === null || typeof address === 'string') {
					throw new Error('The fixture did not obtain a TCP port');
				}
				const target = `http://127.0.0.1:${String(address.port)}/t/acme`;
				const payload = Buffer.from(
					JSON.stringify({ iss: target, aud: target, exp: 4_000_000_000 })
				).toString('base64url');
				const tokenDirectory = path.join(directory, 'cupboard', 'tokens');
				await mkdir(tokenDirectory, { recursive: true });
				await writeFile(
					path.join(
						tokenDirectory,
						createHash('sha256').update(target).digest('hex')
					),
					JSON.stringify({ accessToken: `e30.${payload}.signature` }),
					{ mode: 0o600 }
				);
				const resultFile = path.join(directory, 'result.jsonl');
				const child = spawn(
					process.execPath,
					[
						'--experimental-transform-types',
						'--disable-warning=ExperimentalWarning',
						path.resolve(import.meta.dirname, '../main.ts'),
						'--output-mode',
						'json',
						'--result-file',
						resultFile,
						'confirm',
						target,
						...storePaths
					],
					{
						env: { ...process.env, CI: 'true', XDG_CONFIG_HOME: directory },
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
				expect(
					{
						status: actualStatus,
						stdout,
						result: await readFile(resultFile, 'utf8'),
						calls
					},
					stderr
				).toStrictEqual({
					status: exitCode,
					stdout: '',
					result: `${JSON.stringify({ kind: 'confirm-paths', data: { paths: confirmed } })}\n`,
					calls: Array.from({ length: failedRequests + 1 }, () => ({
						method: 'POST',
						url: '/t/acme/uploads/confirm'
					}))
				});
			} finally {
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
				await rm(directory, { recursive: true, force: true });
			}
		},
		30_000
	);
	it.each(['argument', 'file'] as const)(
		'exits with usage status for an invalid %s store path before requesting OIDC authority',
		async (source) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-confirm-status-')
			);
			const manifest = path.join(directory, 'paths.txt');
			const value = source === 'file' ? 'pr-1' : '/nix/store/invalid';
			try {
				await writeFile(manifest, `${appPath}\n${value}\n`);
				const child = spawn(
					process.execPath,
					[
						'--experimental-transform-types',
						'--disable-warning=ExperimentalWarning',
						path.resolve(import.meta.dirname, '../main.ts'),
						'--output-mode',
						'json',
						'confirm',
						'http://127.0.0.1:1/t/acme',
						'--github-oidc',
						...(source === 'file' ? ['--paths-file', manifest] : [value])
					],
					{
						env: {
							...process.env,
							CI: 'true',
							XDG_CONFIG_HOME: directory,
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
					events: stderr
						.trim()
						.split('\n')
						.map((line): unknown => JSON.parse(line))
				}).toStrictEqual({
					status: 2,
					stdout: '',
					events: [
						{
							event: 'error',
							name: 'ConfirmPathInputError',
							causes: [`InvalidStorePathError: Invalid store path: ${value}`],
							message: `Invalid store path '${value}' in ${source === 'file' ? `--paths-file ${manifest}, line 2` : 'the command arguments'}. Pass an absolute store path with a 32-character Nix hash and a name.`
						}
					]
				});
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
		30_000
	);

	it.each([
		{ name: 'file-only default cache', suffix: '', positionals: [] },
		{
			name: 'file-only named cache URL',
			suffix: '/cache/pr-1',
			positionals: []
		},
		{ name: 'direct and file paths', suffix: '', positionals: [appPath] }
	])('confirms $name', async ({ suffix, positionals }) => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-confirm-paths-')
		);
		const manifest = path.join(directory, 'paths.txt');
		const calls: { url: string; body: unknown }[] = [];
		const authenticated: CacheScope[] = [];
		const token: TokenProvider = {
			get: () => Promise.resolve('test-token'),
			refresh: () => Promise.resolve('test-token')
		};
		const server = setupServer(
			http.post('*', async ({ request }) => {
				calls.push({ url: request.url, body: await request.json() });
				return HttpResponse.json({
					paths: [...positionals, runtimePath].map((entry) => ({
						storePathHash: StorePath.hash(entry),
						confirmed: true,
						grace: {}
					}))
				});
			})
		);
		const resultFile = path.join(directory, 'results.jsonl');
		const program = new Command().exitOverride().option('--result-file <path>');
		registerConfirmCommand(
			program,
			{},
			{
				authenticate: (client) => {
					authenticated.push(client.cache);
					return Promise.resolve(token);
				}
			}
		);
		server.listen({ onUnhandledRequest: 'error' });
		try {
			await writeFile(manifest, `\n ${runtimePath} \r\n\n`);
			await program.parseAsync(
				[
					'--result-file',
					resultFile,
					'confirm',
					`https://cupboard.example.workers.dev/t/acme${suffix}`,
					...positionals,
					'--paths-file',
					manifest
				],
				{ from: 'user' }
			);
			const hashes = [...positionals, runtimePath].map((entry) =>
				StorePath.hash(entry)
			);
			expect({
				authenticated,
				calls,
				results: await readFile(resultFile, 'utf8')
			}).toStrictEqual({
				authenticated: [suffix === '' ? defaultCache : namedCache],
				calls: [
					{
						url: `https://cupboard.example.workers.dev/t/acme${suffix}/uploads/confirm`,
						body: { storePathHashes: hashes }
					}
				],
				results: `${JSON.stringify({ kind: 'confirm-paths', data: { paths: hashes.map((storePathHash) => ({ storePathHash, confirmed: true, grace: {} })) } })}\n`
			});
		} finally {
			server.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each(['pr-1', `${runtimePath}\npr-1`, `\n${runtimePath}\r\npr-1`])(
		'rejects invalid manifest content before authentication: %s',
		async (contents) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-confirm-invalid-')
			);
			const manifest = path.join(directory, 'paths.txt');
			const authenticated: CacheScope[] = [];
			const program = new Command().exitOverride().configureOutput({
				writeErr() {
					return;
				}
			});
			registerConfirmCommand(
				program,
				{},
				{
					authenticate: (client) => {
						authenticated.push(client.cache);
						return Promise.reject(new Error('authentication must not start'));
					}
				}
			);
			try {
				await writeFile(manifest, contents);
				const pending = program.parseAsync(
					[
						'confirm',
						'https://cupboard.example.workers.dev/t/acme',
						appPath,
						'--paths-file',
						manifest
					],
					{ from: 'user' }
				);
				let error: unknown;
				try {
					await pending;
				} catch (error_) {
					error = error_;
				}
				expect(inputFailure(error)).toStrictEqual({
					name: 'ConfirmPathInputError',
					message: `Invalid store path 'pr-1' in --paths-file ${manifest}, line ${String(contents.split('\n').length)}. Pass an absolute store path with a 32-character Nix hash and a name.`,
					cause: new InvalidStorePathError('pr-1'),
					exitCode: 2
				});
				expect(authenticated).toStrictEqual([]);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	);

	it('rejects a path that is not a store path before authenticating', async () => {
		const tokenProviderRequests: CacheScope[] = [];
		const fixedToken: TokenProvider = {
			get: () => Promise.resolve('test-token'),
			refresh: () => Promise.resolve('test-token')
		};
		const program = new Command();
		program.exitOverride();
		program.configureOutput({
			writeErr() {
				return;
			},
			writeOut() {
				return;
			}
		});
		registerConfirmCommand(
			program,
			{},
			{
				authenticate: (client) => {
					tokenProviderRequests.push(client.cache);

					return Promise.resolve(fixedToken);
				}
			}
		);

		let result: unknown;
		try {
			await program.parseAsync(
				[
					'confirm',
					'--github-oidc',
					'https://cache.example.workers.dev/t/acme',
					'./result'
				],
				{ from: 'user' }
			);
		} catch (error: unknown) {
			result = error;
		}

		expect({
			result: inputFailure(result),
			tokenProviderRequests
		}).toStrictEqual({
			result: {
				name: 'ConfirmPathInputError',
				message:
					"Invalid store path './result' in the command arguments. Pass an absolute store path with a 32-character Nix hash and a name.",
				cause: new InvalidStorePathError('./result'),
				exitCode: 2
			},
			tokenProviderRequests: []
		});
	});
});
