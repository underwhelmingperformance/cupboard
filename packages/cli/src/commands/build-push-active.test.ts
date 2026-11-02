import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Nix } from '@cupboard/nix';
import { Derivation } from '@cupboard/nix-store/derivation';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storeDirectorySchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { buildReceiptSchema } from '@cupboard/protocol/build';
import {
	publicationEnsureRequestSchema,
	publicationLookupRequestSchema,
	recordedPublicationSchema
} from '@cupboard/protocol/publication-manifests';
import {
	uploadCapabilitiesHeader,
	uploadDecisionSchema
} from '@cupboard/protocol/upload';
import { parseReporterResults } from '@cupboard/reporter';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { type authenticateForPush } from '../auth/auth.ts';
import type { BuildPushStore } from '../build-push/build-push.ts';
import { buildProgram } from '../cli.ts';
import { CliAbortError, UntrustedDaemonError } from '../errors.ts';
import type { PushClient } from '../push/push.ts';

const mocks = vi.hoisted(() => {
	const configured: string[] = [];
	return {
		authenticate: vi.fn<typeof authenticateForPush>(),
		open: vi.fn<
			() => BuildPushStore &
				Pick<Nix, 'storeDirectory' | 'unknownSettings' | 'storePathOnDisk'>
		>(),
		preflight:
			vi.fn<typeof import('../build-push/preflight.ts').preflightBuildPush>(),
		build:
			vi.fn<
				typeof import('../build-push/supervisor.ts').superviseAttemptedBuild
			>(),
		pushClient: vi.fn<typeof import('../push/push-client.ts').pushClientFor>(),
		readDerivation: vi.fn<BuildPushStore['readDerivation']>(),
		queryValidPathsInfo: vi.fn<BuildPushStore['queryValidPathsInfo']>(),
		resolveClosure: vi.fn<BuildPushStore['resolveClosure']>(),
		rename: vi.fn<typeof import('node:fs/promises').rename>(),
		configured
	};
});

vi.mock('node:fs/promises', async (original) => {
	const fs = await original<typeof import('node:fs/promises')>();
	mocks.rename.mockImplementation(fs.rename);
	return { ...fs, rename: mocks.rename };
});
vi.mock('../auth/auth.ts', async (original) => ({
	...(await original<typeof import('../auth/auth.ts')>()),
	authenticateForPush: mocks.authenticate
}));
vi.mock('@cupboard/nix', async (original) => {
	const nix = await original<typeof import('@cupboard/nix')>();
	return {
		...nix,
		Nix: { open: mocks.open },
		discoverNixStoreConfig: () => {
			const config = nix.discoverNixStoreConfig();
			return {
				...config,
				substitution: { ...config.substitution, substituters: mocks.configured }
			};
		}
	};
});
vi.mock('../build-push/preflight.ts', () => ({
	preflightBuildPush: mocks.preflight
}));
vi.mock('../build-push/supervisor.ts', async (original) => ({
	...(await original<typeof import('../build-push/supervisor.ts')>()),
	superviseAttemptedBuild: mocks.build
}));
vi.mock('../push/push-client.ts', async (original) => ({
	...(await original<typeof import('../push/push-client.ts')>()),
	pushClientFor: mocks.pushClient
}));

const tenant = 'https://cupboard.example.workers.dev/t/acme';
const app = storePathSchema.parse(`/nix/store/${'1'.repeat(32)}-app`);
const drv = storePathSchema.parse(`/nix/store/${'2'.repeat(32)}-app.drv`);
const hash = NixSha256Hash.fromDigest(Buffer.alloc(32, 1));
const publication = recordedPublicationSchema.parse({
	result: {
		cache: { kind: 'named', name: 'source' },
		cacheGeneration: 2,
		storePath: app,
		narHash: hash.toString(),
		generation: 3
	},
	digest: 'a'.repeat(64),
	memberCount: 10_000,
	origin: 'build-selection'
});
const directories: string[] = [];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.configured = [];
	mocks.authenticate.mockResolvedValue({
		get: () => Promise.resolve('token'),
		refresh: () => Promise.resolve('token')
	});
	mocks.preflight.mockRejectedValue(new UntrustedDaemonError('not-trusted'));
	mocks.build.mockResolvedValue({
		exit: { status: 0, signal: undefined },
		attempts: []
	});
	mocks.readDerivation.mockImplementation((value: string) => {
		if (value !== drv) {
			throw new Error('Warm runs must not read the dependency graph');
		}
		return Promise.resolve(
			Derivation.parse(
				`Derive([("out","${app}","","")],[("/nix/store/${'3'.repeat(32)}-tool.drv",["out"])],[],"x86_64-linux","/bin/sh",[],[])`
			)
		);
	});
	const info = {
		storePath: app,
		narHash: hash,
		narSize: 4,
		references: [],
		deriver: drv,
		signatures: [],
		ultimate: true
	};
	mocks.queryValidPathsInfo.mockResolvedValue([info]);
	mocks.resolveClosure.mockResolvedValue([info]);
	mocks.open.mockReturnValue({
		storeDirectory: storeDirectorySchema.parse('/nix/store'),
		storeKind: 'local-filesystem',
		unknownSettings: [],
		storePathOnDisk: (value: string) => value,
		readDerivation: mocks.readDerivation,
		queryValidPathsInfo: mocks.queryValidPathsInfo,
		resolveClosure: mocks.resolveClosure,
		queryValidPaths: (values: readonly string[]) =>
			Promise.resolve(values.filter((value) => value === app)),
		queryDerivationOutputPaths: () => Promise.resolve([app]),
		queryPathInfo: () => Promise.resolve(info),
		narFromPath: vi.fn()
	});
});
afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

async function registeredRun(
	options: {
		legacy?: boolean;
		warmPublication?: typeof publication;
		intermediatePaths?: readonly string[];
		cohortCount?: number;
		cohorts?: readonly { readonly installables: readonly string[] }[];
		unavailablePaths?: readonly string[];
		captureLegacy?: boolean;
		view?: boolean;
		refusal?: boolean;
		runRoot?: boolean;
		targetRoot?: boolean;
		destinationChangesAfterEnsure?: boolean;
		receiptArguments?: readonly string[];
		referenceDependencies?: false;
		ensureResponse?: (
			request: unknown,
			attempt: number
		) => Response | undefined;
	} = {}
) {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-build-push-active-')
	);
	directories.push(directory);
	const receiptFile = path.join(directory, 'receipt.json');
	const resultFile = path.join(directory, 'results.jsonl');
	const cohortsFile = path.join(directory, 'cohorts.json');
	const intermediatePathsFile = path.join(directory, 'intermediates.json');
	if (options.intermediatePaths !== undefined) {
		await writeFile(
			intermediatePathsFile,
			`${options.intermediatePaths.join('\n')}\n`
		);
	}
	await writeFile(
		cohortsFile,
		JSON.stringify({
			cohorts:
				options.cohorts ??
				Array.from({ length: options.cohortCount ?? 1 }, () => ({
					installables: [`${drv}^out`]
				}))
		})
	);
	const selectedPublication = options.warmPublication ?? publication;
	const capturedPublication = {
		...selectedPublication,
		result: {
			...selectedPublication.result,
			cache: { kind: 'named', name: 'builds' },
			cacheGeneration: 4
		},
		memberCount: 1,
		origin: 'legacy-selection'
	};
	const calls: { path: string; body: unknown }[] = [];
	let ensures = 0;
	const client = {
		negotiate: vi.fn<PushClient['negotiate']>((body) =>
			Promise.resolve({
				uploads: body.paths.map((member) =>
					uploadDecisionSchema.parse({
						action: 'skip',
						storePathHash: member.storePathHash,
						narHash: member.narHash
					})
				)
			})
		),
		preview: vi.fn<PushClient['preview']>(),
		uploadNar: vi.fn<PushClient['uploadNar']>(),
		commit: vi.fn<PushClient['commit']>(),
		setRoot: vi.fn<PushClient['setRoot']>()
	} satisfies PushClient;
	mocks.pushClient.mockReturnValue(client);
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(async (input, init) => {
			const request = new Request(input, init);
			const pathname = new URL(request.url).pathname;
			const text = await request.text();
			const body: unknown = text === '' ? undefined : JSON.parse(text);
			calls.push({ path: pathname, body });
			if (pathname.endsWith('/nix-cache-info')) {
				return new Response('', { status: 401 });
			}
			if (pathname.endsWith('/uploads/credential')) {
				return Response.json(
					{
						pushId: 'push-1',
						accessKeyId: 'access',
						secretAccessKey: 'secret',
						sessionToken: 'session',
						endpoint: 'https://r2.test',
						bucket: 'blobs',
						expiresAt: '2099-01-01T00:00:00.000Z'
					},
					{
						headers: options.legacy
							? {}
							: { [uploadCapabilitiesHeader]: 'publication-manifests-v1' }
					}
				);
			}
			if (pathname.endsWith('/publication-results/lookup')) {
				if (options.refusal) {
					return new Response('refused', { status: 403 });
				}
				if (options.captureLegacy) {
					return Response.json({
						entries: [{ kind: 'missing', result: capturedPublication.result }]
					});
				}
				const lookup = publicationLookupRequestSchema.parse(body);
				if (
					lookup.results.every(({ storePath }) =>
						options.unavailablePaths?.includes(storePath)
					)
				) {
					return Response.json({
						entries: lookup.results.map(({ storePath }) => ({
							kind: 'unavailable',
							storePath
						}))
					});
				}
				const isDestinationLookup =
					lookup.source.cache?.kind === 'named' &&
					lookup.source.cache.name === 'builds';
				return Response.json({
					entries: [
						isDestinationLookup
							? options.destinationChangesAfterEnsure && ensures > 0
								? {
										kind: 'recorded',
										publication: {
											...selectedPublication,
											result: {
												...selectedPublication.result,
												cache: { kind: 'named', name: 'builds' },
												cacheGeneration: 4
											}
										},
										complete: true
									}
								: { kind: 'unavailable', storePath: app }
							: {
									kind: 'recorded',
									publication: selectedPublication,
									complete: true
								}
					],
					...(!isDestinationLookup &&
						options.view && {
							sourceSelector: { view: 'release', expectedRevision: 7 }
						})
				});
			}
			if (pathname.endsWith('/publication-results/captures')) {
				return Response.json({
					kind: 'existing',
					publication: capturedPublication
				});
			}
			if (pathname.endsWith('/uploads')) {
				return Response.json({ uploads: [] });
			}
			if (pathname.endsWith('/uploads/plan')) {
				return Response.json({
					cacheGeneration: 4,
					pushExpiresAt: '2099-01-01T00:00:00.000Z',
					uploads: []
				});
			}
			if (pathname.endsWith('/publication-results/ensure')) {
				ensures += 1;
				const response = options.ensureResponse?.(body, ensures);
				if (response !== undefined) {
					return response;
				}
				return Response.json({
					kind: 'complete',
					association: 'existing',
					publication: {
						...(options.captureLegacy
							? capturedPublication
							: selectedPublication),
						result: {
							...selectedPublication.result,
							cache: { kind: 'named', name: 'builds' },
							cacheGeneration: 4
						},
						materialisation: 'complete'
					}
				});
			}
			throw new Error(`Unexpected request ${pathname}`);
		})
	);
	const run = (
		overrides: {
			receiptArguments?: readonly string[];
			referenceDependencies?: false;
			extraArguments?: readonly string[];
			cacheName?: string;
		} = {}
	) => {
		// Recreate the registered command so only durable files survive a restart.
		const program = buildProgram();
		program.exitOverride();
		return program.parseAsync(
			[
				'--output-mode',
				'json',
				'--result-file',
				resultFile,
				'build-push',
				tenant,
				overrides.cacheName ?? 'builds',
				...(options.targetRoot ? ['--root', 'main'] : ['--no-retain']),
				...(options.intermediatePaths === undefined
					? ['--publication-scope', 'outputs']
					: ['--intermediate-paths-file', intermediatePathsFile]),
				'--cohorts-file',
				cohortsFile,
				'--receipt-file',
				receiptFile,
				...(overrides.receiptArguments ??
					options.receiptArguments ?? ['--aggregate-receipt', '3,4']),
				...((overrides.referenceDependencies ??
					options.referenceDependencies) === false
					? ['--no-reference-dependencies']
					: []),
				...(options.runRoot
					? ['--run-root', 'run/123', '--run-root-permanent']
					: []),
				...(overrides.extraArguments ?? [])
			],
			{ from: 'user' }
		);
	};
	return {
		run,
		calls,
		client,
		receiptFile,
		cohortsFile,
		output: () => readFile(resultFile, 'utf8'),
		results: async () =>
			parseReporterResults(await readFile(resultFile, 'utf8')),
		resultKinds: async () =>
			parseReporterResults(await readFile(resultFile, 'utf8')).map(
				(result) => result.kind
			),
		receipt: async () =>
			buildReceiptSchema.parse(JSON.parse(await readFile(receiptFile, 'utf8')))
	};
}

it.each([false, true])(
	'the registered default reuses a warm private source without a dependency graph (view: %s)',
	async (view) => {
		mocks.configured = [
			'https://cache.nixos.org',
			`${tenant}/cache/builds`,
			`${tenant}/${view ? 'reuse/release' : 'cache/source'}`,
			'https://cupboard.example.workers.dev/t/other/cache/private'
		];
		const run = await registeredRun({ view, runRoot: true });
		await run.run();
		expect(await run.receipt()).toMatchObject({
			version: 4,
			paths: [],
			subjects: [],
			publicationSets: [{ memberCount: 10_000, materialisation: 'complete' }]
		});
		expect(await run.resultKinds()).toEqual(['build-summary-v4']);
		expect(mocks.build).not.toHaveBeenCalled();
		expect(mocks.preflight).not.toHaveBeenCalled();
		expect(mocks.readDerivation).toHaveBeenCalledTimes(1);
		expect(mocks.queryValidPathsInfo).not.toHaveBeenCalled();
		expect(mocks.resolveClosure).not.toHaveBeenCalled();
		expect(run.client.preview).not.toHaveBeenCalled();
		expect(run.client.commit).not.toHaveBeenCalled();
		expect(run.client.negotiate).not.toHaveBeenCalled();
		expect(run.calls.filter((call) => call.path.endsWith('/uploads'))).toEqual([
			{
				path: '/t/acme/cache/builds/uploads',
				body: {
					pushId: 'push-1',
					paths: [],
					attachRoot: { name: 'run/123', retention: { kind: 'permanent' } }
				}
			}
		]);
		expect(
			run.calls
				.filter((call) => call.path.endsWith('/publication-results/lookup'))
				.map((call) => call.body)
		).toEqual([
			{
				source: { cache: { kind: 'named', name: 'builds' } },
				results: [{ storePath: app }]
			},
			{
				source: view
					? { selector: { view: 'release' } }
					: { cache: { kind: 'named', name: 'source' } },
				results: [{ storePath: app }]
			}
		]);
		expect(
			run.calls.find((call) =>
				call.path.endsWith('/publication-results/ensure')
			)?.body
		).toMatchObject({
			source: publication,
			runRoot: 'run/123',
			...(view && { sourceSelector: { view: 'release', expectedRevision: 7 } })
		});
		const details = mocks.authenticate.mock.calls.map(
			([, auth]) => auth.authorizationDetails
		);
		expect(details.at(-1)).toEqual(
			expect.arrayContaining([
				{
					type: 'cupboard_cache',
					actions: ['root:attach'],
					cache: { kind: 'named', name: 'builds' },
					root: 'run/123'
				},
				view
					? {
							type: 'cupboard_view',
							actions: ['view:content-read'],
							view: 'release'
						}
					: {
							type: 'cupboard_cache',
							actions: ['cache:content-read'],
							cache: { kind: 'named', name: 'source' }
						}
			])
		);
		expect(JSON.stringify(details)).not.toContain('root:set');
		if (view) {
			expect(JSON.stringify(details)).not.toContain('"name":"source"');
		}
		await run.run();
		const ensureRequests = run.calls.filter((call) =>
			call.path.endsWith('/publication-results/ensure')
		);
		expect(ensureRequests).toHaveLength(2);
		expect(
			publicationEnsureRequestSchema.parse(ensureRequests[1]?.body).requestId
		).not.toBe(
			publicationEnsureRequestSchema.parse(ensureRequests[0]?.body).requestId
		);
		expect(mocks.build).not.toHaveBeenCalled();
	}
);

it.each([
	{ mode: 'negotiated V4', receiptArguments: ['--aggregate-receipt', '3,4'] },
	{ mode: 'explicit V3', receiptArguments: ['--aggregate-receipt-v3'] },
	{
		mode: 'delegated V4',
		receiptArguments: ['--aggregate-receipt', '3,4'],
		referenceDependencies: false as const
	}
])(
	'accepts a configured trailing-slash reuse view through the registered $mode command (modelled Nix/HTTP)',
	async ({ mode, ...options }) => {
		mocks.configured = [
			'https://cache.nixos.org',
			`${tenant}/cache/builds`,
			`${tenant}/reuse/release/`,
			'https://cupboard.example.workers.dev/t/other/cache/private'
		];
		const run = await registeredRun({ ...options, view: true, runRoot: true });
		const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
		try {
			await run.run();
			const isRecorded = mode === 'negotiated V4';
			const anyRequestId: unknown = expect.stringMatching(/^[0-9a-f-]{36}$/u);
			const publicationSets = [
				{
					...publication,
					result: {
						...publication.result,
						cache: { kind: 'named', name: 'builds' },
						cacheGeneration: 4
					},
					materialisation: 'complete'
				}
			];
			expect(await run.receipt()).toEqual(
				isRecorded
					? {
							version: 4,
							paths: [],
							subjects: [],
							childExitStatus: 0,
							publicationSets
						}
					: {
							version: mode === 'explicit V3' ? 3 : 4,
							paths: [app],
							subjects: [
								{
									origin: 'store-held',
									storePath: app,
									narHash: hash.digestHex(),
									buildStore: 'auto',
									derivation: drv
								}
							],
							uploaded: [],
							childExitStatus: 0
						}
			);
			const results = [
				{
					kind: isRecorded ? 'build-summary-v4' : 'build-summary',
					data: {
						mode: isRecorded ? 'streamed' : 'reconciled-local',
						store: '/nix/store',
						targetPaths: 1,
						intermediatePaths: 0,
						queueDepth: 0,
						uploadedPaths: 0,
						skipped: isRecorded ? 0 : 1,
						childExitStatus: 0,
						unconfirmedPaths: [],
						...(isRecorded
							? { version: 4, publicationSets }
							: {
									uploadedBytes: 0,
									pathReferences: [{ storePath: app, references: [] }],
									uploads: [],
									durationMs: 0,
									publication: {
										uploadedPaths: 0,
										reusedBlobs: 0,
										skipped: 1,
										uploadedBytes: 0,
										failures: [],
										paths: [
											{
												storePathHash: StorePath.hash(app),
												storePath: app,
												outcome: 'already-present'
											}
										]
									}
								})
					}
				}
			];
			expect(await run.results()).toEqual(results);
			expect(
				run.calls.filter((call) => call.path.includes('/publication-results/'))
			).toEqual(
				isRecorded
					? [
							{
								path: '/t/acme/cache/builds/publication-results/lookup',
								body: {
									source: { cache: { kind: 'named', name: 'builds' } },
									results: [{ storePath: app }]
								}
							},
							{
								path: '/t/acme/cache/builds/publication-results/lookup',
								body: {
									source: { selector: { view: 'release' } },
									results: [{ storePath: app }]
								}
							},
							{
								path: '/t/acme/cache/builds/publication-results/ensure',
								body: {
									source: publication,
									sourceSelector: { view: 'release', expectedRevision: 7 },
									runRoot: 'run/123',
									expectedDestinationGeneration: 4,
									requestId: anyRequestId
								}
							}
						]
					: []
			);
			expect(
				run.calls.filter((call) => call.path.endsWith('/uploads'))
			).toEqual(
				isRecorded
					? [
							{
								path: '/t/acme/cache/builds/uploads',
								body: {
									pushId: 'push-1',
									paths: [],
									attachRoot: {
										name: 'run/123',
										retention: { kind: 'permanent' }
									}
								}
							}
						]
					: []
			);
			const uploadGrant = {
				type: 'cupboard_cache',
				actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
				cache: { kind: 'named', name: 'builds' }
			};
			const rootGrant = {
				type: 'cupboard_cache',
				actions: ['root:attach'],
				cache: { kind: 'named', name: 'builds' },
				root: 'run/123'
			};
			const readGrant = {
				type: 'cupboard_view',
				actions: ['view:content-read'],
				view: 'release'
			};
			expect(
				mocks.authenticate.mock.calls.map(
					([, auth]) => auth.authorizationDetails
				)
			).toEqual(
				isRecorded
					? [
							[uploadGrant, rootGrant],
							[uploadGrant],
							[uploadGrant, readGrant],
							[uploadGrant, rootGrant],
							[uploadGrant, rootGrant, readGrant]
						]
					: [[uploadGrant, rootGrant]]
			);
			expect(run.client.setRoot.mock.calls).toEqual([]);
			expect(run.client.preview.mock.calls).toEqual([]);
			expect(run.client.commit.mock.calls).toEqual([]);
			expect(run.client.uploadNar.mock.calls).toEqual([]);
			expect(mocks.build).toHaveBeenCalledTimes(isRecorded ? 0 : 1);
			expect(mocks.preflight).toHaveBeenCalledTimes(isRecorded ? 0 : 1);
			expect(run.client.negotiate.mock.calls).toEqual(
				isRecorded
					? []
					: [
							[
								{
									paths: [
										{
											storePathHash: StorePath.hash(app),
											storePath: app,
											narHash: hash.toString(),
											narSize: 4,
											references: [],
											deriver: StorePath.basename(drv)
										}
									],
									attachRoot: {
										name: 'run/123',
										retention: { kind: 'permanent' }
									}
								}
							]
						]
			);
		} finally {
			clock.mockRestore();
		}
	}
);

it.each([false, true])(
	'publishes an explicit intermediate outside a warm selected set through the registered command (failure: %s)',
	async (fails) => {
		const intermediate = storePathSchema.parse(
			`/nix/store/${'4'.repeat(32)}-extra`
		);
		const store = mocks.open();
		const appInfo = await store.queryPathInfo(app);
		const intermediateInfo = {
			...appInfo,
			storePath: intermediate,
			deriver: undefined
		};
		mocks.queryValidPathsInfo.mockImplementation((paths) =>
			Promise.resolve(
				[appInfo, intermediateInfo].filter((info) =>
					paths.includes(info.storePath)
				)
			)
		);
		mocks.resolveClosure.mockImplementation((paths) =>
			Promise.resolve(
				[appInfo, intermediateInfo].filter((info) =>
					paths.includes(info.storePath)
				)
			)
		);
		mocks.open.mockReturnValue({
			...store,
			queryPathInfo: (value) =>
				Promise.resolve(value === app ? appInfo : intermediateInfo)
		});
		mocks.configured = [`${tenant}/cache/source`];
		const run = await registeredRun({
			intermediatePaths: [intermediate],
			warmPublication: { ...publication, memberCount: 1 },
			targetRoot: true,
			runRoot: true
		});
		const cause = new Error('intermediate publication refused');
		run.client.negotiate.mockImplementation((body) =>
			Promise.resolve({
				uploads: body.paths.map((member) =>
					uploadDecisionSchema.parse({
						action:
							member.storePathHash === StorePath.hash(intermediate)
								? 'commit'
								: 'skip',
						storePathHash: member.storePathHash,
						narHash: member.narHash,
						...(member.storePathHash === StorePath.hash(intermediate) && {
							uploadId: 'extra-upload'
						})
					})
				)
			})
		);
		run.client.commit.mockImplementation((target) => {
			if (fails) {
				return Promise.reject(cause);
			}
			return Promise.resolve({
				...target,
				status: 'committed',
				settled: Promise.resolve()
			});
		});
		const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
		try {
			const publicationSets = [
				{
					...publication,
					result: {
						...publication.result,
						cache: { kind: 'named', name: 'builds' },
						cacheGeneration: 4
					},
					memberCount: 1,
					materialisation: 'complete'
				}
			];
			const paths = [app, intermediate].map((storePath) => ({
				storePathHash: StorePath.hash(storePath),
				storePath,
				outcome: storePath === app ? 'already-present' : 'committed'
			}));
			if (fails) {
				await expect(run.run()).rejects.toMatchObject({
					name: 'BuildPublicationFailedError',
					exitCode: 74,
					failedPaths: [StorePath.basename(intermediate)]
				});
				await expect(readFile(run.receiptFile, 'utf8')).rejects.toMatchObject({
					code: 'ENOENT'
				});
				expect(await run.results()).toEqual([
					{
						kind: 'push-summary',
						data: {
							uploadedPaths: 0,
							reusedBlobs: 1,
							skipped: 1,
							uploadedBytes: 0,
							failures: [
								{
									storePathHash: StorePath.hash(intermediate),
									storePath: intermediate,
									stage: 'commit',
									reason: cause.message
								}
							],
							paths: [paths[0]]
						}
					}
				]);
			} else {
				await run.run();
				expect(await run.receipt()).toEqual({
					version: 4,
					paths: [app, intermediate],
					subjects: [app, intermediate].map((storePath) => ({
						origin: 'store-held',
						storePath,
						narHash: hash.digestHex(),
						buildStore: 'auto',
						...(storePath === app && { derivation: drv })
					})),
					uploaded: [intermediate],
					childExitStatus: 0,
					publicationSets
				});
				expect(await run.results()).toEqual([
					{
						kind: 'build-summary-v4',
						data: {
							mode: 'reconciled-local',
							store: '/nix/store',
							targetPaths: 1,
							intermediatePaths: 1,
							queueDepth: 0,
							uploadedPaths: 0,
							uploadedBytes: 0,
							pathReferences: [app, intermediate].map((storePath) => ({
								storePath,
								references: []
							})),
							uploads: [],
							durationMs: 0,
							publication: {
								uploadedPaths: 0,
								reusedBlobs: 1,
								skipped: 1,
								uploadedBytes: 0,
								failures: [],
								paths
							},
							skipped: 2,
							childExitStatus: 0,
							unconfirmedPaths: [],
							version: 4,
							publicationSets
						}
					}
				]);
			}
			expect(
				run.client.negotiate.mock.calls.flatMap(([body]) =>
					body.paths.map((member) => member.storePath)
				)
			).toEqual([app, intermediate]);
			expect(
				run.client.negotiate.mock.calls.map(([body]) => body.attachRoot)
			).toEqual([{ name: 'run/123', retention: { kind: 'permanent' } }]);
			expect(
				run.calls.filter((call) => call.path.endsWith('/uploads'))
			).toEqual([
				{
					path: '/t/acme/cache/builds/uploads',
					body: {
						pushId: 'push-1',
						paths: [],
						attachRoot: { name: 'run/123', retention: { kind: 'permanent' } }
					}
				}
			]);
			expect(run.client.setRoot.mock.calls).toEqual(
				fails
					? []
					: [['main', { targets: [app], retention: { kind: 'inherit' } }]]
			);
			expect(mocks.build).toHaveBeenCalledTimes(1);
			expect(
				run.calls.filter((call) => call.path.endsWith('/captures'))
			).toEqual([]);
		} finally {
			clock.mockRestore();
		}
	}
);

it('the negotiated current consumer keeps legacy publication for a genuinely old server', async () => {
	const run = await registeredRun({ legacy: true });
	await run.run();
	expect(await run.receipt()).toMatchObject({ version: 4, paths: [app] });
	expect(await run.resultKinds()).toEqual(['build-summary']);
	expect(mocks.build).toHaveBeenCalledTimes(1);
	expect(mocks.preflight).toHaveBeenCalledTimes(1);
	expect(run.client.negotiate).toHaveBeenCalledTimes(1);
	expect(run.calls.map((call) => call.path)).toEqual([
		'/t/acme/cache/builds/uploads/credential'
	]);
});

it('the registered default does not build or expand membership after a supported lookup authority refusal', async () => {
	const run = await registeredRun({ refusal: true });
	await expect(run.run()).rejects.toBeDefined();
	expect(mocks.build).not.toHaveBeenCalled();
	expect(mocks.preflight).not.toHaveBeenCalled();
	expect(run.client.preview).not.toHaveBeenCalled();
});

it('the registered default publishes an unrecorded legacy selection once before capturing its exact accepted footprint', async () => {
	const run = await registeredRun({ captureLegacy: true });
	await run.run();
	expect(await run.receipt()).toMatchObject({
		version: 4,
		paths: [app],
		publicationSets: [
			{
				origin: 'legacy-selection',
				memberCount: 1,
				materialisation: 'complete'
			}
		]
	});
	expect(await run.resultKinds()).toEqual(['build-summary-v4']);
	expect(mocks.build).toHaveBeenCalledTimes(1);
	expect(run.client.negotiate).toHaveBeenCalledTimes(1);
	expect(
		run.calls.find((call) =>
			call.path.endsWith('/publication-results/captures')
		)?.body
	).toMatchObject({
		origin: 'legacy-selection',
		memberCount: 1,
		result: { storePath: app, narHash: hash.toString(), generation: 3 }
	});
});

function rootResult(
	name: string,
	targets: readonly string[]
): Awaited<ReturnType<PushClient['setRoot']>> {
	return {
		name,
		expired: false,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		targets: targets.map((storePath) => ({
			storePath,
			storePathHash: StorePath.hash(storePath),
			present: true
		}))
	};
}

it.each([false, true])(
	'preserves the complete registered aggregate root with pending cohorts (warm cohort: %s)',
	async (mixed) => {
		const cold = storePathSchema.parse(`/nix/store/${'3'.repeat(32)}-cold`);
		const coldDrv = storePathSchema.parse(
			`/nix/store/${'4'.repeat(32)}-cold.drv`
		);
		const previous = storePathSchema.parse(
			`/nix/store/${'5'.repeat(32)}-previous`
		);
		const store = mocks.open();
		const coldInfo = {
			storePath: cold,
			narHash: hash,
			narSize: 4,
			references: [],
			deriver: coldDrv,
			signatures: [],
			ultimate: true
		};
		mocks.open.mockReturnValue({
			...store,
			queryValidPaths: (values) => Promise.resolve([...values]),
			queryDerivationOutputPaths: () => Promise.resolve([cold]),
			queryPathInfo: () => Promise.resolve(coldInfo)
		});
		mocks.queryValidPathsInfo.mockResolvedValue([coldInfo]);
		mocks.readDerivation.mockImplementation((value) =>
			Promise.resolve(
				Derivation.parse(
					`Derive([("out","${value === drv ? app : cold}","","")],[],[],"x86_64-linux","/bin/sh",[],[])`
				)
			)
		);
		mocks.configured = [`${tenant}/cache/source`];
		const run = await registeredRun({
			targetRoot: true,
			unavailablePaths: [cold],
			cohorts: [
				{ installables: [`${mixed ? drv : coldDrv}^out`] },
				{ installables: [`${coldDrv}^out`] }
			]
		});
		let rootTargets: readonly string[] = [app, previous];
		run.client.setRoot.mockImplementation((name, body) => {
			rootTargets = body.targets;
			return Promise.resolve(rootResult(name, body.targets));
		});
		run.client.negotiate.mockImplementation((body) =>
			Promise.resolve({
				uploads: body.paths.map((member) =>
					uploadDecisionSchema.parse({
						action: 'commit',
						storePathHash: member.storePathHash,
						narHash: member.narHash,
						uploadId: `upload-${member.storePathHash}`
					})
				)
			})
		);
		const deferred = Promise.withResolvers<undefined>();
		run.client.commit.mockImplementation(
			(target: Parameters<PushClient['commit']>[0]) =>
				Promise.resolve({
					...target,
					status: 'pending',
					settled: deferred.promise
				})
		);
		const output: string[] = [];
		const spies = [
			vi.spyOn(Date, 'now').mockReturnValue(0),
			vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
				output.push(String(chunk));
				return true;
			})
		];
		try {
			await run.run({ extraArguments: ['--no-wait', '--permanent'] });
			const publicationSets = mixed
				? [
						{
							...publication,
							result: {
								...publication.result,
								cache: { kind: 'named', name: 'builds' },
								cacheGeneration: 4
							},
							materialisation: 'complete'
						}
					]
				: [];
			expect(await run.receipt()).toEqual({
				version: 4,
				paths: [],
				subjects: [],
				uploaded: [],
				failed: [],
				collected: [],
				publicationSets
			});
			const warmSummary = {
				kind: 'build-summary-v4',
				data: {
					mode: 'streamed',
					store: '/nix/store',
					targetPaths: 1,
					intermediatePaths: 0,
					queueDepth: 0,
					uploadedPaths: 0,
					skipped: 0,
					childExitStatus: 0,
					unconfirmedPaths: [],
					version: 4,
					publicationSets
				}
			};
			const coldSummary = {
				kind: 'build-summary-v4',
				data: {
					mode: 'reconciled-local',
					store: '/nix/store',
					targetPaths: 1,
					intermediatePaths: 0,
					queueDepth: 0,
					uploadedPaths: 0,
					uploadedBytes: 0,
					pathReferences: [{ storePath: cold, references: [] }],
					uploads: [],
					durationMs: 0,
					publication: {
						uploadedPaths: 0,
						reusedBlobs: 1,
						skipped: 0,
						uploadedBytes: 0,
						failures: [],
						paths: [
							{
								storePathHash: StorePath.hash(cold),
								storePath: cold,
								outcome: 'pending'
							}
						]
					},
					skipped: 0,
					childExitStatus: 0,
					unconfirmedPaths: [],
					version: 4,
					publicationSets: []
				}
			};
			const results = [mixed ? warmSummary : coldSummary, coldSummary];
			expect(await run.results()).toEqual(results);
			expect(await run.output()).toBe(
				`${results.map((result) => JSON.stringify(result)).join('\n')}\n`
			);
			expect(mocks.build).toHaveBeenCalledTimes(mixed ? 1 : 2);
			expect(mocks.preflight).toHaveBeenCalledTimes(mixed ? 1 : 2);
			expect(ensureIds(run.calls)).toHaveLength(mixed ? 1 : 0);
			expect({
				rootTargets,
				rootCalls: run.client.setRoot.mock.calls,
				commits: run.client.commit.mock.calls.map(([target]) => target),
				captures: run.calls.filter((call) => call.path.endsWith('/captures')),
				uploads: run.client.uploadNar.mock.calls
			}).toEqual({
				rootTargets: [app, previous],
				rootCalls: [],
				commits: Array.from({ length: mixed ? 1 : 2 }, () => ({
					uploadId: `upload-${StorePath.hash(cold)}`,
					storePathHash: StorePath.hash(cold),
					narHash: hash.toString(),
					retention: true
				})),
				captures: [],
				uploads: []
			});
			expect(output.join('')).not.toContain('Updating retention root');
		} finally {
			for (const spy of spies) {
				spy.mockRestore();
			}
			deferred.resolve(undefined);
		}
	}
);

it.each([false, true])(
	'replaces the registered aggregate root after explicit empty settlement (warm cohort: %s)',
	async (mixed) => {
		mocks.configured = [`${tenant}/cache/source`];
		const run = await registeredRun({
			targetRoot: true,
			cohorts: [
				{ installables: [mixed ? `${drv}^out` : '.#empty'] },
				{ installables: ['.#empty'] }
			]
		});
		let rootTargets: readonly string[] = [app];
		run.client.setRoot.mockImplementation((name, body) => {
			rootTargets = body.targets;
			return Promise.resolve(rootResult(name, body.targets));
		});
		await run.run({ extraArguments: ['--no-wait', '--ttl', '1h'] });
		expect(await run.receipt()).toEqual({
			version: 4,
			paths: [],
			subjects: [],
			uploaded: [],
			failed: [],
			collected: [],
			publicationSets: mixed
				? [
						{
							...publication,
							result: {
								...publication.result,
								cache: { kind: 'named', name: 'builds' },
								cacheGeneration: 4
							},
							materialisation: 'complete'
						}
					]
				: []
		});
		expect(run.client.commit).not.toHaveBeenCalled();
		expect(run.client.negotiate).not.toHaveBeenCalled();
		expect(mocks.build).toHaveBeenCalledTimes(mixed ? 1 : 2);
		expect({ rootTargets, calls: run.client.setRoot.mock.calls }).toEqual({
			rootTargets: mixed ? [app] : [],
			calls: [
				[
					'main',
					{
						targets: mixed ? [app] : [],
						retention: { kind: 'duration', seconds: 3600 }
					}
				]
			]
		});
	}
);

it('starts fresh intent UUIDs for every cohort after whole-invocation success', async () => {
	mocks.configured = [`${tenant}/cache/source`];
	const run = await registeredRun({ cohortCount: 2 });
	await run.run();
	await run.run();
	const ids = run.calls
		.filter((call) => call.path.endsWith('/publication-results/ensure'))
		.map((call) => publicationEnsureRequestSchema.parse(call.body).requestId);
	expect(ids).toHaveLength(4);
	expect(ids[0]).not.toBe(ids[1]);
	expect(new Set(ids).size).toBe(4);
	expect(mocks.build).not.toHaveBeenCalled();
});

function ensureIds(calls: readonly { path: string; body: unknown }[]) {
	return calls
		.filter((call) => call.path.endsWith('/publication-results/ensure'))
		.map((call) => publicationEnsureRequestSchema.parse(call.body).requestId);
}

it('keeps an ambiguously completed ensure intent until the entire command succeeds, then starts a new retention event', async () => {
	mocks.configured = [`${tenant}/cache/source`];
	const run = await registeredRun({
		ensureResponse: (_request, attempt) =>
			attempt === 1 ? Response.json({ interrupted: true }) : undefined
	});
	await expect(run.run()).rejects.toBeDefined();
	await run.run();
	await run.run();
	const ids = ensureIds(run.calls);
	expect(ids).toHaveLength(3);
	expect(ids[1]).toBe(ids[0]);
	expect(ids[2]).not.toBe(ids[0]);
});

it('keeps successful cohort IDs while another cohort is partial or fails, including across receipt cleanup', async () => {
	mocks.configured = [`${tenant}/cache/source`];
	const run = await registeredRun({
		cohortCount: 2,
		ensureResponse: (_request, attempt) =>
			attempt === 2 || attempt === 4
				? Response.json({ interrupted: true })
				: undefined
	});
	await expect(run.run()).rejects.toBeDefined();
	await expect(run.run()).rejects.toBeDefined();
	await run.run();
	await run.run();
	const ids = ensureIds(run.calls);
	expect(ids).toHaveLength(8);
	expect(ids.slice(2, 4)).toEqual(ids.slice(0, 2));
	expect(ids.slice(4, 6)).toEqual(ids.slice(0, 2));
	expect(ids[6]).not.toBe(ids[0]);
	expect(ids[7]).not.toBe(ids[1]);
});

it.each(['receipt', 'completion'])(
	'retains exact intent IDs after interrupted atomic %s persistence',
	async (step) => {
		mocks.configured = [`${tenant}/cache/source`];
		const run = await registeredRun();
		const rename = mocks.rename.getMockImplementation();
		if (rename === undefined) {
			throw new Error('Missing real rename');
		}
		let hasInterrupted = false;
		mocks.rename.mockImplementation(async (source, destination) => {
			const target = String(destination);
			if (
				!hasInterrupted &&
				target ===
					(step === 'receipt'
						? run.receiptFile
						: `${run.receiptFile}.publication-requests.completed.json`)
			) {
				hasInterrupted = true;
				throw new Error('interrupted persistence');
			}
			await rename(source, destination);
		});
		try {
			await expect(run.run()).rejects.toThrow('interrupted persistence');
			await run.run();
			await run.run();
			const ids = ensureIds(run.calls);
			expect(ids).toHaveLength(3);
			expect(ids[1]).toBe(ids[0]);
			expect(ids[2]).not.toBe(ids[0]);
		} finally {
			mocks.rename.mockImplementation(rename);
		}
	}
);

it.each(['.publication-requests.json', '.publication-requests.completed.json'])(
	'refuses corrupt replay state in %s rather than treating it as a new push',
	async (suffix) => {
		mocks.configured = [`${tenant}/cache/source`];
		const run = await registeredRun();
		await run.run();
		await writeFile(`${run.receiptFile}${suffix}`, '{broken');
		await expect(run.run()).rejects.toBeDefined();
		expect(ensureIds(run.calls)).toHaveLength(1);
	}
);

it('preserves an interrupted new intent even when the preceding invocation completed successfully', async () => {
	mocks.configured = [`${tenant}/cache/source`];
	const run = await registeredRun({
		ensureResponse: (_request, attempt) => {
			if (attempt === 2) {
				throw new CliAbortError();
			}
			return;
		}
	});
	await run.run();
	await expect(run.run()).rejects.toBeInstanceOf(CliAbortError);
	await run.run();
	await run.run();
	const ids = ensureIds(run.calls);
	expect(ids).toHaveLength(4);
	expect(ids[1]).not.toBe(ids[0]);
	expect(ids[2]).toBe(ids[1]);
	expect(ids[3]).not.toBe(ids[1]);
});

it('does not complete any cohort intent when the aggregate root update fails after all ensures succeed', async () => {
	mocks.configured = [`${tenant}/cache/source`];
	const run = await registeredRun({ cohortCount: 2, targetRoot: true });
	run.client.setRoot.mockRejectedValueOnce(new Error('aggregate root failed'));
	await expect(run.run()).rejects.toThrow('aggregate root failed');
	await run.run();
	await run.run();
	const ids = ensureIds(run.calls);
	expect(ids).toHaveLength(6);
	expect(ids.slice(2, 4)).toEqual(ids.slice(0, 2));
	expect(ids[4]).not.toBe(ids[0]);
	expect(ids[5]).not.toBe(ids[1]);
});

it.each([false, true])(
	'replays the original source after successful promotion changes destination lookup and loses completion (view: %s)',
	async (view) => {
		mocks.configured = [`${tenant}/${view ? 'reuse/release' : 'cache/source'}`];
		const run = await registeredRun({
			view,
			destinationChangesAfterEnsure: true,
			ensureResponse: (_request, attempt) =>
				attempt === 1 ? Response.json({ interrupted: true }) : undefined
		});
		await expect(run.run()).rejects.toBeDefined();
		const lookupCount = run.calls.filter((call) =>
			call.path.endsWith('/publication-results/lookup')
		).length;
		await run.run();
		const requests = run.calls
			.filter((call) => call.path.endsWith('/publication-results/ensure'))
			.map((call) => publicationEnsureRequestSchema.parse(call.body));
		expect(requests).toHaveLength(2);
		expect(requests[1]).toEqual(requests[0]);
		expect(
			run.calls.filter((call) =>
				call.path.endsWith('/publication-results/lookup')
			)
		).toHaveLength(lookupCount);
		await run.run();
		expect(ensureIds(run.calls)[2]).not.toBe(ensureIds(run.calls)[0]);
		expect(mocks.build).not.toHaveBeenCalled();
	}
);

it('rejects changing the invocation source configuration during interrupted recovery before remote use', async () => {
	mocks.configured = [`${tenant}/reuse/release`];
	const run = await registeredRun({
		view: true,
		ensureResponse: () => Response.json({ interrupted: true })
	});
	await expect(run.run()).rejects.toBeDefined();
	const before = run.calls.length;
	mocks.configured = [`${tenant}/reuse/changed`];
	await expect(run.run()).rejects.toThrow('different invocation');
	expect(
		run.calls
			.slice(before)
			.filter((call) => call.path.includes('publication-results'))
	).toEqual([]);
	expect(ensureIds(run.calls)).toHaveLength(1);
	expect(mocks.build).not.toHaveBeenCalled();
});

it('replays the pinned selector and fails on source/view drift without selecting another retention intent', async () => {
	mocks.configured = [`${tenant}/reuse/release`];
	const run = await registeredRun({
		view: true,
		destinationChangesAfterEnsure: true,
		ensureResponse: (_request, attempt) =>
			attempt === 1
				? Response.json({ interrupted: true })
				: new Response('view changed', { status: 409 })
	});
	await expect(run.run()).rejects.toBeDefined();
	await expect(run.run()).rejects.toBeDefined();
	const requests = run.calls
		.filter((call) => call.path.endsWith('/publication-results/ensure'))
		.map((call) => publicationEnsureRequestSchema.parse(call.body));
	expect(requests).toHaveLength(2);
	expect(requests[1]).toEqual(requests[0]);
	expect(requests[1]?.sourceSelector).toEqual({
		view: 'release',
		expectedRevision: 7
	});
	expect(mocks.build).not.toHaveBeenCalled();
});

it.each([['--aggregate-receipt-v3'], []])(
	'keeps strict V3 receipt consumers on ordinary publication with no manifest RPC (%j)',
	async (...receiptArguments) => {
		mocks.configured = [`${tenant}/cache/source`];
		const run = await registeredRun({ receiptArguments });
		await run.run();
		expect(await run.receipt()).toMatchObject({ version: 3, paths: [app] });
		expect(await run.receipt()).not.toHaveProperty('publicationSets');
		expect(await run.resultKinds()).toEqual(['build-summary']);
		expect(
			run.calls.filter((call) => call.path.includes('/publication-results/'))
		).toEqual([]);
		expect(mocks.build).toHaveBeenCalledTimes(1);
		expect(run.client.negotiate).toHaveBeenCalledTimes(1);
	}
);

it('does not capture a delegated provisional footprint even when the consumer negotiates V4', async () => {
	mocks.configured = [`${tenant}/cache/source`];
	const run = await registeredRun({ referenceDependencies: false });
	await run.run();
	expect(await run.receipt()).toMatchObject({ version: 4, paths: [app] });
	expect(await run.receipt()).not.toHaveProperty('publicationSets');
	expect(
		run.calls.filter((call) => call.path.includes('/publication-results/'))
	).toEqual([]);
	expect(mocks.build).toHaveBeenCalledTimes(1);
	expect(run.client.negotiate).toHaveBeenCalledTimes(1);
});

it.each([
	'root',
	'retention',
	'sequence',
	'count',
	'cwd',
	'options',
	'destination'
])(
	'refuses unfinished whole-command recovery when outer %s changes',
	async (change) => {
		mocks.configured = [`${tenant}/cache/source`];
		const run = await registeredRun({ cohortCount: 2, targetRoot: true });
		run.client.setRoot.mockRejectedValueOnce(
			new Error('aggregate root failed')
		);
		await expect(run.run()).rejects.toThrow('aggregate root failed');
		const before = run.calls.length;
		const cwd = vi.spyOn(process, 'cwd');
		try {
			switch (change) {
				case 'cwd': {
					cwd.mockReturnValue(path.dirname(run.receiptFile));

					break;
				}
				case 'count': {
					await writeFile(
						run.cohortsFile,
						JSON.stringify({ cohorts: [{ installables: [`${drv}^out`] }] })
					);

					break;
				}
				case 'sequence': {
					await writeFile(
						run.cohortsFile,
						JSON.stringify({
							cohorts: [
								{ installables: [`${drv}^out`] },
								{ installables: ['.#different'] }
							]
						})
					);

					break;
				}
				// No default
			}
			await expect(
				run.run({
					cacheName: change === 'destination' ? 'changed' : 'builds',
					extraArguments:
						change === 'root'
							? ['--root', 'changed']
							: change === 'retention'
								? ['--ttl', '7d']
								: change === 'options'
									? ['--no-wait']
									: []
				})
			).rejects.toThrow('different invocation');
			expect(
				run.calls
					.slice(before)
					.filter((call) => call.path.includes('publication-results'))
			).toEqual([]);
			expect(ensureIds(run.calls)).toHaveLength(2);
			expect(run.client.setRoot).toHaveBeenCalledTimes(1);
			expect(mocks.build).not.toHaveBeenCalled();
		} finally {
			cwd.mockRestore();
		}
	}
);

it.each(
	[1, 2].flatMap((cohortCount) => [
		{ cohortCount, overrides: { receiptArguments: [] } },
		{
			cohortCount,
			overrides: { receiptArguments: ['--aggregate-receipt-v3'] }
		},
		{ cohortCount, overrides: { referenceDependencies: false as const } }
	])
)(
	'refuses ordinary publication over unfinished V4 recovery (%j), but permits it after completion',
	async ({ cohortCount, overrides }) => {
		mocks.configured = [`${tenant}/cache/source`];
		const run = await registeredRun({
			cohortCount,
			ensureResponse: (_request, attempt) =>
				attempt === cohortCount
					? Response.json({ interrupted: true })
					: undefined
		});
		await expect(run.run()).rejects.toBeDefined();
		const before = run.calls.length;
		await expect(run.run(overrides)).rejects.toThrow('unfinished publication');
		expect(run.calls).toHaveLength(before);
		expect(mocks.build).not.toHaveBeenCalled();
		expect(run.client.negotiate).not.toHaveBeenCalled();
		await run.run();
		await run.run(overrides);
		expect(mocks.build).toHaveBeenCalledTimes(cohortCount);
		expect(ensureIds(run.calls)).toHaveLength(cohortCount * 2);
	}
);

it('allows a fresh whole command with changed root semantics only after completion', async () => {
	mocks.configured = [`${tenant}/cache/source`];
	const run = await registeredRun({ cohortCount: 2, targetRoot: true });
	await run.run();
	await run.run({ extraArguments: ['--root', 'changed', '--ttl', '7d'] });
	expect(new Set(ensureIds(run.calls)).size).toBe(4);
	expect(run.client.setRoot).toHaveBeenLastCalledWith(
		'changed',
		expect.objectContaining({
			retention: { kind: 'duration', seconds: 604_800 }
		})
	);
});

it('keeps the fingerprint stable when equivalent receipt negotiation arguments change', async () => {
	mocks.configured = [`${tenant}/cache/source`];
	const run = await registeredRun({
		cohortCount: 2,
		targetRoot: true,
		ensureResponse: (_request, attempt) =>
			attempt === 2 ? Response.json({ interrupted: true }) : undefined
	});
	await expect(run.run()).rejects.toBeDefined();
	await run.run({ receiptArguments: ['--aggregate-receipt', '4,3'] });
	const ids = ensureIds(run.calls);
	expect(ids.slice(2)).toEqual(ids.slice(0, 2));
});

it.each([
	'GITHUB_RUN_ID',
	'GITHUB_RUN_ATTEMPT',
	'GITHUB_SHA',
	'GITHUB_REPOSITORY'
])(
	'refuses unfinished outer command recovery after public %s changes before authentication',
	async (name) => {
		vi.stubEnv(name, 'original');
		try {
			mocks.configured = [`${tenant}/cache/source`];
			const run = await registeredRun({ cohortCount: 2, targetRoot: true });
			run.client.setRoot.mockRejectedValueOnce(
				new Error('aggregate root interrupted')
			);
			await expect(run.run()).rejects.toThrow('aggregate root interrupted');
			const before = structuredClone(run.calls);
			const authentications = mocks.authenticate.mock.calls.length;
			vi.stubEnv(name, 'changed');
			await expect(run.run()).rejects.toThrow('different invocation');
			expect(run.calls).toEqual(before);
			expect(mocks.authenticate).toHaveBeenCalledTimes(authentications);
			expect(mocks.build).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllEnvs();
		}
	}
);
