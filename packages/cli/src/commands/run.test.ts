import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { discoverNixStoreConfig } from '@cupboard/nix';
import { CacheInfo } from '@cupboard/nix-store/cache-info';
import { parseTenantCacheUrl } from '@cupboard/nix-store/cache-url';
import { reuseViewNameSchema } from '@cupboard/protocol/reuse-views';
import { describe, expect, it } from 'vitest';

import { CacheInfoTimeoutError } from '../errors.ts';

import {
	ReadAccessProbeDocumentError,
	runWithReadAccess,
	UnreadableReadCredentialFileError
} from './run.ts';

const execute = promisify(execFile);
const main = fileURLToPath(new URL('../main.ts', import.meta.url));
const mockFetchImport = `--import=data:text/javascript,${encodeURIComponent(
	"globalThis.fetch = () => Promise.resolve(new Response(process.env.CUPBOARD_TEST_CACHE_STATUS === '200' ? process.env.CUPBOARD_TEST_CACHE_INFO : undefined, { status: Number(process.env.CUPBOARD_TEST_CACHE_STATUS) }));"
)}`;
const childScript = String.raw`process.stdout.write('{"ok":true}\n'); process.exitCode = Number(process.env.CUPBOARD_TEST_CHILD_STATUS);`;

describe('cupboard run', () => {
	it('requests only view read access for a reuse view target', async () => {
		const tenantUrl = new URL('https://cupboard.example.workers.dev/t/acme');
		const configuration = discoverNixStoreConfig();
		const probes: string[] = [];
		const grants: unknown[] = [];
		await runWithReadAccess(
			{ tenantUrl, view: reuseViewNameSchema.parse('release') },
			['nix', 'eval'],
			{ githubOidc: true },
			{
				storeConfig: {
					...configuration,
					fileTransfer: {
						...configuration.fileTransfer,
						netrcFile: '/nonexistent/cupboard-view-test-netrc'
					}
				},
				fetcher: (input) => {
					probes.push(input instanceof Request ? input.url : String(input));
					return Promise.resolve(new Response(undefined, { status: 401 }));
				},
				issue: (request) => {
					grants.push(request.authorizationDetails);
					return Promise.resolve({
						user: 'cupboard-oidc',
						password: 'cupboard-access+jwt:example',
						expiresAtMs: Date.now() + 900_000
					});
				},
				runChild: () => Promise.resolve({ status: 0, signal: undefined })
			}
		);

		expect({ probes, grants }).toStrictEqual({
			probes: [
				'https://cupboard.example.workers.dev/t/acme/reuse/release/nix-cache-info'
			],
			grants: [
				[
					{
						type: 'cupboard_view',
						actions: ['view:content-read'],
						view: 'release'
					}
				]
			]
		});
	});

	it('runs a public operation without opening an unreadable configured netrc', async () => {
		const configuration = discoverNixStoreConfig();
		let isOpened = false;
		let didRun = false;
		await runWithReadAccess(
			parseTenantCacheUrl(
				new URL('https://cupboard.example.workers.dev/t/acme')
			),
			['nix', 'eval'],
			{ githubOidc: true },
			{
				storeConfig: configuration,
				readFile: () => {
					isOpened = true;
					return Promise.reject(
						Object.assign(new Error('permission denied'), { code: 'EACCES' })
					);
				},
				fetcher: () =>
					Promise.resolve(new Response(CacheInfo.default.render())),
				runChild: () => {
					didRun = true;
					return Promise.resolve({ status: 0, signal: undefined });
				}
			}
		);
		expect({ isOpened, didRun }).toStrictEqual({
			isOpened: false,
			didRun: true
		});
	});

	it('refuses to mask an unreadable netrc when a private operation needs OIDC', async () => {
		const configuration = discoverNixStoreConfig();
		let wasIssued = false;
		const target = parseTenantCacheUrl(
			new URL('https://cupboard.example.workers.dev/t/acme')
		);
		const operation = runWithReadAccess(
			target,
			['nix', 'eval'],
			{ githubOidc: true },
			{
				storeConfig: configuration,
				readFile: () =>
					Promise.reject(
						Object.assign(new Error('permission denied'), { code: 'EACCES' })
					),
				fetcher: () =>
					Promise.resolve(new Response(undefined, { status: 401 })),
				issue: () => {
					wasIssued = true;
					throw new Error('The exchange must not run');
				},
				runChild: () => Promise.resolve({ status: 0, signal: undefined })
			}
		);
		await expect(operation).rejects.toBeInstanceOf(
			UnreadableReadCredentialFileError
		);
		expect(wasIssued).toBe(false);
	});

	it('uses configured URL credentials with a trailing slash ahead of host netrc', async () => {
		const tenantUrl = new URL('https://cupboard.example.workers.dev/t/acme');
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-run-'));
		const netrcFile = path.join(directory, 'netrc');
		const configuration = discoverNixStoreConfig();
		const headers: (string | undefined)[] = [];
		let wasIssued = false;
		let childConfig: string | undefined;

		try {
			await writeFile(
				netrcFile,
				'machine cupboard.example.workers.dev login host password wrong\n'
			);
			await runWithReadAccess(
				parseTenantCacheUrl(tenantUrl),
				['nix', 'eval'],
				{ githubOidc: true },
				{
					environment: { NIX_CONFIG: 'experimental-features = nix-command' },
					storeConfig: {
						...configuration,
						substitution: {
							...configuration.substitution,
							substituters: [
								'https://url:correct@cupboard.example.workers.dev/t/acme/'
							]
						},
						fileTransfer: { ...configuration.fileTransfer, netrcFile }
					},
					fetcher: (_input, init) => {
						const authorization =
							new Headers(init?.headers).get('authorization') ?? undefined;
						headers.push(authorization);
						return Promise.resolve(
							new Response(
								authorization === undefined
									? undefined
									: CacheInfo.default.render(),
								{
									status: authorization === undefined ? 401 : 200
								}
							)
						);
					},
					issue: () => {
						wasIssued = true;
						throw new Error('The configured credential should take precedence');
					},
					runChild: (options) => {
						childConfig = options.environment.NIX_CONFIG;
						return Promise.resolve({ status: 0, signal: undefined });
					}
				}
			);

			expect({ headers, wasIssued, childConfig }).toStrictEqual({
				headers: [
					undefined,
					`Basic ${Buffer.from('url:correct').toString('base64')}`
				],
				wasIssued: false,
				childConfig: 'experimental-features = nix-command'
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('rejects a successful cache-info response with invalid content', async () => {
		const configuration = discoverNixStoreConfig();
		let didRun = false;
		const operation = runWithReadAccess(
			parseTenantCacheUrl(
				new URL('https://cupboard.example.workers.dev/t/acme')
			),
			['nix', 'eval'],
			{ githubOidc: true },
			{
				storeConfig: configuration,
				fetcher: () => Promise.resolve(new Response('<html>login</html>')),
				runChild: () => {
					didRun = true;
					return Promise.resolve({ status: 0, signal: undefined });
				}
			}
		);

		await expect(operation).rejects.toBeInstanceOf(
			ReadAccessProbeDocumentError
		);
		expect(didRun).toBe(false);
	});

	it('times out when a cache-info response body stalls before starting the child', async () => {
		const configuration = discoverNixStoreConfig();
		let didRun = false;
		const operation = runWithReadAccess(
			parseTenantCacheUrl(
				new URL('https://cupboard.example.workers.dev/t/acme')
			),
			['nix', 'eval'],
			{ githubOidc: true },
			{
				storeConfig: configuration,
				probeTimeoutMs: 20,
				fetcher: () =>
					Promise.resolve(
						new Response(
							new ReadableStream<Uint8Array>({
								start(controller) {
									controller.enqueue(
										new TextEncoder().encode('StoreDir: /nix/store\n')
									);
								}
							})
						)
					),
				runChild: () => {
					didRun = true;
					return Promise.resolve({ status: 0, signal: undefined });
				}
			}
		);

		await expect(operation).rejects.toBeInstanceOf(CacheInfoTimeoutError);
		expect(didRun).toBe(false);
	});

	it('installs exact read grants and preserves other Nix credentials during the child', async () => {
		const tenantUrl = new URL('https://cupboard.example.workers.dev/t/acme');
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-run-'));
		const originalNetrc = path.join(directory, 'original.netrc');
		const sourceConfig = discoverNixStoreConfig();
		const issued: unknown[] = [];
		let childEnvironment: NodeJS.ProcessEnv | undefined;
		let temporaryNetrc: string | undefined;
		let contents: string | undefined;

		try {
			await writeFile(
				originalNetrc,
				'machine other.example login another password static\n'
			);
			await runWithReadAccess(
				parseTenantCacheUrl(tenantUrl),
				['nix', 'eval'],
				{ githubOidc: true, reuseView: reuseViewNameSchema.parse('release') },
				{
					environment: { NIX_CONFIG: 'experimental-features = nix-command' },
					storeConfig: {
						...sourceConfig,
						fileTransfer: {
							...sourceConfig.fileTransfer,
							netrcFile: originalNetrc
						}
					},
					fetcher: () =>
						Promise.resolve(new Response(undefined, { status: 401 })),
					issue: (request) => {
						issued.push(request.authorizationDetails);
						return Promise.resolve({
							user: 'cupboard-oidc',
							password: 'cupboard-access+jwt:example',
							expiresAtMs: Date.now() + 900_000
						});
					},
					runChild: async (options) => {
						childEnvironment = options.environment;
						const match = /netrc-file = ([^\n]+)/u.exec(
							options.environment.NIX_CONFIG ?? ''
						);
						temporaryNetrc = match?.[1];
						if (temporaryNetrc === undefined) {
							throw new Error('The child did not receive a netrc-file setting');
						}
						contents = await readFile(temporaryNetrc, 'utf8');
						return { status: 0, signal: undefined };
					}
				}
			);

			expect({
				issued,
				commandConfig: childEnvironment?.NIX_CONFIG?.replace(
					/netrc-file = [^\n]+/u,
					'netrc-file = <temporary>'
				),
				contents,
				removed: temporaryNetrc !== undefined && !existsSync(temporaryNetrc)
			}).toStrictEqual({
				issued: [
					[
						{
							type: 'cupboard_cache',
							actions: ['cache:content-read'],
							cache: { kind: 'default' }
						},
						{
							type: 'cupboard_view',
							actions: ['view:content-read'],
							view: 'release'
						}
					]
				],
				commandConfig:
					'experimental-features = nix-command\nnetrc-file = <temporary>',
				contents:
					'machine cupboard.example.workers.dev login cupboard-oidc password cupboard-access+jwt:example\nmachine other.example login another password static\n',
				removed: true
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		{
			name: 'a public cache and a successful child',
			urlPath: '/t/acme',
			cacheStatus: 200,
			childStatus: 0,
			expectedStatus: 0,
			expectedStdout: '{"ok":true}\n',
			error: undefined
		},
		{
			name: 'a public cache and a failed child',
			urlPath: '/t/acme',
			cacheStatus: 200,
			childStatus: 7,
			expectedStatus: 7,
			expectedStdout: '{"ok":true}\n',
			error: 'Command exited with status 7'
		},
		{
			name: 'a private cache without an OIDC request',
			urlPath: '/t/acme',
			cacheStatus: 401,
			childStatus: 0,
			expectedStatus: 1,
			expectedStdout: '',
			error: 'A private cache or reuse view needs read access'
		},
		{
			name: 'a public reuse view URL',
			urlPath: '/t/acme/reuse/release',
			cacheStatus: 200,
			childStatus: 0,
			expectedStatus: 0,
			expectedStdout: '{"ok":true}\n',
			error: undefined
		}
	])(
		'keeps stdout exclusive to the child for $name in GitHub Actions',
		async (fixture) => {
			const url = `https://cupboard.example.workers.dev${fixture.urlPath}`;
			const arguments_ = [
				mockFetchImport,
				'--experimental-transform-types',
				'--disable-warning=ExperimentalWarning',
				main,
				'run',
				url,
				'--',
				process.execPath,
				'-e',
				childScript
			];
			let actual: {
				readonly status: number;
				readonly stdout: string;
				readonly stderr: string;
			};
			try {
				const output = await execute(process.execPath, arguments_, {
					timeout: 20_000,
					env: {
						...process.env,
						GITHUB_ACTIONS: 'true',
						FORCE_COLOR: '0',
						PRE_COMMIT: '0',
						NIX_USER_CONF_FILES: '',
						NIX_CONFIG: 'netrc-file = /nonexistent/cupboard-run-test-netrc',
						CUPBOARD_TEST_CACHE_STATUS: String(fixture.cacheStatus),
						CUPBOARD_TEST_CACHE_INFO: CacheInfo.default.render(),
						CUPBOARD_TEST_CHILD_STATUS: String(fixture.childStatus)
					}
				});
				actual = { status: 0, ...output };
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!('code' in error) ||
					!('stdout' in error) ||
					!('stderr' in error)
				) {
					throw error;
				}

				actual = {
					status: Number(error.code),
					stdout: String(error.stdout),
					stderr: String(error.stderr)
				};
			}

			expect({
				status: actual.status,
				stdout: actual.stdout,
				hasError:
					fixture.error !== undefined && actual.stderr.includes(fixture.error)
			}).toStrictEqual({
				status: fixture.expectedStatus,
				stdout: fixture.expectedStdout,
				hasError: fixture.error !== undefined
			});
		},
		20_000
	);
});
