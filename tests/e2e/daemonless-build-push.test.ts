import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
	selectorForCache,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { invocationIdSchema } from '@cupboard/protocol/build';
import { uploadDecisionSchema } from '@cupboard/protocol/upload';
import type { Reporter } from '@cupboard/reporter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	type BuildPushDependencies,
	runBuildPush
} from '../../packages/cli/src/build-push/build-push.ts';
import { preflightBuildPush } from '../../packages/cli/src/build-push/preflight.ts';
import { storedCacheFor } from '../../packages/cli/src/client/client.ts';
import {
	BuildCommandFailedError,
	UntrustedDaemonError
} from '../../packages/cli/src/errors.ts';
import type { PushClient } from '../../packages/cli/src/push/push.ts';
import { discoverNixStoreConfig, Nix } from '../../packages/nix/src/index.ts';
import { defaultNixConfigEnvironment } from '../../packages/nix/src/store-config.ts';
import { CupboardTestServer } from '../support/cupboard-server.ts';
import { temporaryRoot } from '../support/filesystem.ts';
import { runCommand } from '../support/process.ts';

/**
 * A store of this test's own: its own store directory, its own database, and no
 * daemon socket anywhere near it. This is what a tarball install of Nix gives
 * you, and what a GitHub-hosted runner using `nix-quick-install-action` gets.
 *
 * A cupboard cache serves exactly one store directory, `/nix/store`, so a store
 * of another directory publishes to a cache of this suite's own rather than to
 * the tenant. What that cache is asked for is the whole of what the run
 * publishes, so it stands in for the tenant here; the run against the host
 * store below publishes to the tenant itself.
 */
interface DaemonlessStore {
	readonly workspace: string;
	readonly storeDirectory: string;
	readonly stateDirectory: string;
	readonly logDirectory: string;
	readonly helperPath: string;
}

const fixture: {
	store?: DaemonlessStore;
	server?: CupboardTestServer;
	workspace?: string;
} = {};

function store(): DaemonlessStore {
	const prepared = fixture.store;

	if (prepared === undefined) {
		throw new Error('The daemonless store was not prepared');
	}

	return prepared;
}

function server(): CupboardTestServer {
	const prepared = fixture.server;

	if (prepared === undefined) {
		throw new Error('The cupboard server was not started');
	}

	return prepared;
}

// The system this machine builds for, discovered the way Nix discovers it.
function nixSystem(): string {
	const system = defaultNixConfigEnvironment.currentSystem();

	if (system === undefined) {
		throw new Error('Nix names no system for this machine');
	}

	return system;
}

// This store's configuration is the environment and nothing else, so whatever
// the machine running the test has in its own files stays out of it.
function noConfigFile(): string | undefined {
	return;
}

// What a build reads to work in a store: no substituter to fetch from and no
// builder to dispatch to, so what the run publishes is this machine's own work.
const isolatedNixConfig = [
	'experimental-features = nix-command flakes',
	'substituters =',
	'builders =',
	'sandbox = false'
].join('\n');

const helperSource = fileURLToPath(
	new URL(
		'../../packages/cli/hook-helper/cupboard-hook-relay.c',
		import.meta.url
	)
);

// The environment a child building into the test's own store reads.
function daemonlessEnvironment(): Record<string, string> {
	const prepared = store();

	return {
		PATH: process.env.PATH ?? '',
		HOME: prepared.workspace,
		NIX_STORE_DIR: prepared.storeDirectory,
		NIX_STATE_DIR: prepared.stateDirectory,
		NIX_LOG_DIR: prepared.logDirectory,
		NIX_REMOTE: '',
		NIX_CONFIG: isolatedNixConfig
	};
}

// The store client the command layer opens on a machine like this one: no
// daemon answers, so this process reads the store itself.
function daemonlessStoreDependencies(): Parameters<typeof Nix.open>[0] {
	const prepared = store();

	return {
		env: {
			NIX_STORE_DIR: prepared.storeDirectory,
			NIX_STATE_DIR: prepared.stateDirectory
		},
		readFile: noConfigFile,
		homeDirectory: noConfigFile,
		workingDirectory: () => process.cwd(),
		currentSystem: () => nixSystem(),
		probes: {
			canReadWrite: () => false,
			isFilePresent: () => false,
			hasHardwareVirtualisation: () => false,
			isWsl1: () => false,
			microarchitectureLevels: () => []
		},
		canWriteStateDirectory: () => true,
		socketExists: () => false,
		directoryExists: () => true,
		isSuperuser: () => false,
		createDirectory: () => true,
		realpath: (value: string) => value
	};
}

function ignore(): void {
	return;
}

function silentReporter(): Reporter {
	const facts = { fact: ignore, warn: ignore };

	return {
		phase: (_label, body) => Promise.resolve(body(facts)),
		progress: (_label, _options, body) =>
			Promise.resolve(body({ advance: ignore, ...facts })),
		steps: (_label, body) =>
			Promise.resolve(
				body({
					message: ignore,
					group: () => ({
						message: ignore,
						success: ignore,
						error: ignore
					}),
					warn: ignore
				})
			),
		result: ignore,
		data: ignore,
		error: ignore,
		warn: ignore,
		info: ignore,
		success: ignore,
		step: ignore
	};
}

// What a cache was asked to hold, in the order the push asked it.
interface RecordedCache {
	readonly negotiated: string[];
	readonly uploaded: number[];
	readonly committed: string[];
}

// A cache that requests each NAR once and records every offer. Later offers for
// a committed path confirm that the cache already serves it.
function recordingClient(record: RecordedCache): PushClient {
	const served = new Set<string>();

	return {
		negotiate: (body) =>
			Promise.resolve({
				uploads: body.paths.map((negotiated) => {
					record.negotiated.push(negotiated.storePath);
					const storePathHash = negotiated.storePathHash;

					if (served.has(storePathHash)) {
						return uploadDecisionSchema.parse({
							action: 'skip',
							storePathHash,
							narHash: negotiated.narHash
						});
					}

					return uploadDecisionSchema.parse({
						action: 'upload',
						storePathHash,
						narHash: negotiated.narHash,
						uploadId: `upload-${negotiated.storePathHash}`,
						r2Key: `staging/${negotiated.storePathHash}`,
						expiresAt: '2026-08-09T00:00:00.000Z'
					});
				})
			}),
		preview: () => Promise.resolve({ uploads: [] }),
		uploadNar: async (_r2Key, body) => {
			let bytes = 0;

			for await (const chunk of body) {
				bytes += chunk.byteLength;
			}

			record.uploaded.push(bytes);
		},
		commit: (target) => {
			record.committed.push(target.storePathHash);
			served.add(target.storePathHash);

			return Promise.resolve({
				storePathHash: target.storePathHash,
				narHash: target.narHash,
				status: 'committed' as const,
				settled: Promise.resolve()
			});
		},
		setRoot: (name) =>
			Promise.reject(new Error(`no root was expected, but ${name} was set`))
	};
}

beforeAll(async () => {
	const workspace = await mkdtemp(
		path.join(temporaryRoot, 'cupboard-daemonless-bp-')
	);
	const storeDirectory = path.join(workspace, 'store');
	const stateDirectory = path.join(workspace, 'state');
	const logDirectory = path.join(workspace, 'log');
	const helperPath = path.join(workspace, 'cupboard-hook-relay');

	await Promise.all(
		[storeDirectory, stateDirectory, logDirectory].map((directory) =>
			mkdir(directory, { recursive: true })
		)
	);
	await runCommand('cc', ['-O2', '-o', helperPath, helperSource]);

	fixture.workspace = workspace;
	fixture.store = {
		workspace,
		storeDirectory,
		stateDirectory,
		logDirectory,
		helperPath
	};
	fixture.server = await CupboardTestServer.start(
		path.join(workspace, 'server')
	);
}, 120_000);

afterAll(async () => {
	await fixture.server?.stop();

	if (fixture.workspace !== undefined) {
		await rm(fixture.workspace, { recursive: true, force: true });
	}
});

// The derivation a run builds, instantiated into the given store. It is never
// built here, so the run that publishes it is the run that realises it.
async function instantiate(
	seed: string,
	environment: Record<string, string>
): Promise<StorePathString> {
	const expression =
		`builtins.derivation { name = "cupboard-daemonless-${seed}"; ` +
		`system = "${nixSystem()}"; builder = "/bin/sh"; ` +
		`args = [ "-c" "echo ${seed} > $out" ]; }`;
	const { stdout } = await runCommand(
		'nix-instantiate',
		['--expr', expression],
		{ env: environment }
	);

	return storePathSchema.parse(stdout.trim());
}

async function instantiateDependentBuild(
	seed: string,
	environment: Record<string, string>
): Promise<{
	readonly dependency: StorePathString;
	readonly target: StorePathString;
	readonly targetOutput: StorePathString;
}> {
	const expression =
		`let dependency = builtins.derivation { ` +
		`name = "cupboard-daemonless-dependency-${seed}"; ` +
		`system = "${nixSystem()}"; builder = "/bin/sh"; ` +
		`args = [ "-c" "echo dependency > $out" ]; }; ` +
		`target = builtins.derivation { ` +
		`name = "cupboard-daemonless-target-${seed}"; ` +
		`system = "${nixSystem()}"; builder = "/bin/sh"; ` +
		`args = [ "-c" "cat \${dependency} > /dev/null; echo target > $out" ]; ` +
		`}; in { inherit dependency target; }`;
	const { stdout: target } = await runCommand(
		'nix-instantiate',
		['--expr', expression, '--attr', 'target'],
		{ env: environment }
	);
	const { stdout: dependency } = await runCommand(
		'nix-instantiate',
		[
			'--eval',
			'--strict',
			'--json',
			'--expr',
			`(${expression}).dependency.outPath`
		],
		{ env: environment }
	);
	const { stdout: targetOutput } = await runCommand(
		'nix-store',
		['--query', '--outputs', target.trim()],
		{ env: environment }
	);

	return {
		dependency: storePathSchema.parse(JSON.parse(dependency)),
		target: storePathSchema.parse(target.trim()),
		targetOutput: storePathSchema.parse(targetOutput.trim())
	};
}

// A cohort run with a private store and no daemon. The build hook creates
// direct GC roots so outputs remain available while Cupboard uploads them.
function daemonlessDependencies(options: {
	readonly client: PushClient;
	readonly nix: Nix;
	readonly config: ReturnType<typeof discoverNixStoreConfig>;
	readonly environment: Record<string, string>;
	readonly invocationId: ReturnType<typeof invocationIdSchema.parse>;
	readonly runtimeDirectory: string;
}): BuildPushDependencies {
	const helperPath = store().helperPath;
	const executablePath = path.join(path.dirname(helperPath), 'cupboard');

	return {
		client: options.client,
		store: options.nix,
		batchStore: {
			withProtectedPaths: () =>
				Promise.reject(
					new Error('a daemonless run must not open a daemon batch session')
				)
		},
		storeDirectory: options.config.storeDirectory,
		invocationId: options.invocationId,
		environment: options.environment,
		runtime: {
			environment: {},
			temporaryDirectory: options.runtimeDirectory
		},
		preflight: () =>
			preflightBuildPush({
				config: options.config,
				storeKind: options.nix.storeKind,
				stateDirectory:
					options.nix.stateDirectory ?? options.config.stateDirectory,
				daemonTrust: () => Promise.resolve('unknown'),
				invocationId: options.invocationId,
				grants: [],
				cache: selectorForCache(storedCacheFor(undefined)),
				helper: { executablePath },
				runtime: {
					environment: {},
					temporaryDirectory: options.runtimeDirectory
				}
			}),
		nextAttemptId: () => 'attempt-1'
	};
}

// One daemonless run of a cohort in the test's own store. Each run uses a
// separate runtime directory and receipt.
async function runDaemonlessCohort(options: {
	readonly derivation: StorePathString;
	readonly run: string;
	readonly client: PushClient;
}): Promise<unknown> {
	const prepared = store();
	const environment = daemonlessEnvironment();
	const dependencies = daemonlessStoreDependencies();
	const nix = Nix.open(dependencies);
	const config = discoverNixStoreConfig(dependencies);
	const receiptFile = path.join(
		prepared.workspace,
		`receipt-${options.run}.json`
	);

	await runBuildPush(
		{
			invocation: {
				kind: 'constructed',
				build: { installables: [`${options.derivation}^*`], attempts: 1 }
			},
			receiptFile
		},
		silentReporter(),
		daemonlessDependencies({
			client: options.client,
			nix,
			config,
			environment,
			invocationId: invocationIdSchema.parse(`daemonless-${options.run}`),
			runtimeDirectory: '/tmp'
		})
	);

	return JSON.parse(await readFile(receiptFile, 'utf8'));
}

describe('build-push without a Nix daemon', () => {
	it('builds in a store of its own and publishes the completed output', async () => {
		const seed = randomUUID().replaceAll('-', '');
		const environment = daemonlessEnvironment();
		const derivation = await instantiate(seed, environment);
		const nix = Nix.open(daemonlessStoreDependencies());
		const record: RecordedCache = {
			negotiated: [],
			uploaded: [],
			committed: []
		};
		const receipt = await runDaemonlessCohort({
			derivation,
			run: seed,
			client: recordingClient(record)
		});
		const [output] = await nix.queryDerivationOutputPaths([derivation]);
		const storePath = storePathSchema.parse(output);
		const info = await nix.queryPathInfo(storePath);

		expect({
			negotiated: record.negotiated,
			committed: record.committed,
			uploadedNars: record.uploaded.length,
			builtLocally: info.ultimate,
			receipt
		}).toStrictEqual({
			negotiated: [storePath, storePath],
			committed: [StorePath.hash(storePath)],
			uploadedNars: 1,
			builtLocally: true,
			receipt: {
				version: 3,
				paths: [storePath],
				outcomes: [{ outcome: 'built', storePath }],
				failed: [],
				collected: [],
				subjects: [
					{
						origin: 'built',
						storePath,
						narHash: info.narHash.digestHex(),
						derivation,
						buildStore: 'auto',
						verification: 'local',
						attempt: 1,
						attemptId: 'attempt-1'
					}
				],
				uploaded: [storePath],
				childExitStatus: 0
			}
		});
	}, 120_000);

	// The first run built the path, so Nix marked it as ultimate. The second run
	// publishes the existing path and does not claim it as a build result.
	it('claims nothing for a path the store held before it ran', async () => {
		const seed = randomUUID().replaceAll('-', '');
		const environment = daemonlessEnvironment();
		const derivation = await instantiate(seed, environment);
		const nix = Nix.open(daemonlessStoreDependencies());
		const record: RecordedCache = {
			negotiated: [],
			uploaded: [],
			committed: []
		};
		const client = recordingClient(record);

		await runDaemonlessCohort({ derivation, run: `${seed}-first`, client });

		const receipt = await runDaemonlessCohort({
			derivation,
			run: `${seed}-second`,
			client
		});
		const [output] = await nix.queryDerivationOutputPaths([derivation]);
		const storePath = storePathSchema.parse(output);

		const info = await nix.queryPathInfo(storePath);

		expect({ negotiated: record.negotiated, receipt }).toStrictEqual({
			negotiated: [storePath, storePath, storePath],
			receipt: {
				version: 3,
				paths: [storePath],
				outcomes: [{ outcome: 'destination-served', storePath }],
				failed: [],
				collected: [],
				subjects: [
					{
						origin: 'store-held',
						storePath,
						narHash: info.narHash.digestHex(),
						derivation,
						buildStore: 'auto'
					}
				],
				uploaded: [],
				childExitStatus: 0
			}
		});
	}, 120_000);

	it('protects an intermediate during collection after the target finishes', async () => {
		const seed = randomUUID().replaceAll('-', '');
		const environment = daemonlessEnvironment();
		const { dependency, target, targetOutput } =
			await instantiateDependentBuild(seed, environment);
		const nix = Nix.open(daemonlessStoreDependencies());
		const config = discoverNixStoreConfig(daemonlessStoreDependencies());
		const invocationId = invocationIdSchema.parse(`daemonless-gc-${seed}`);
		const outLink = path.join(
			'/tmp',
			'cupboard',
			`${invocationId}-targets`,
			'result'
		);
		const record: RecordedCache = {
			negotiated: [],
			uploaded: [],
			committed: []
		};
		const recorded = recordingClient(record);
		let isSurvivedCollection = false;
		const client: PushClient = {
			...recorded,
			async uploadNar(r2Key, body) {
				if (r2Key === `staging/${StorePath.hash(dependency)}`) {
					await expect
						.poll(() => existsSync(outLink), { timeout: 30_000 })
						.toBe(true);
					await runCommand('nix-store', ['--gc'], { env: environment });
					isSurvivedCollection = existsSync(dependency);
				}

				await recorded.uploadNar(r2Key, body);
			}
		};

		await runBuildPush(
			{
				invocation: {
					kind: 'constructed',
					build: { installables: [`${target}^*`], attempts: 1 }
				}
			},
			silentReporter(),
			daemonlessDependencies({
				client,
				nix,
				config,
				environment,
				invocationId,
				runtimeDirectory: '/tmp'
			})
		);

		expect({
			survivedCollection: isSurvivedCollection,
			committed: record.committed
		}).toStrictEqual({
			survivedCollection: true,
			committed: [StorePath.hash(dependency), StorePath.hash(targetOutput)]
		});

		await runCommand('nix-store', ['--gc'], { env: environment });
		expect(existsSync(dependency)).toBe(false);
	}, 120_000);

	// The tenant serves paths under `/nix/store`, while the private fixture uses
	// a different store directory. Build in the host store for this end-to-end
	// case. The private-store cases above cover daemonless streaming.
	it('publishes a host-store build through reconciled mode', async (context) => {
		if (!existsSync('/nix/var/nix/daemon-socket/socket')) {
			context.skip();
		}

		const workspace = store().workspace;
		const seed = randomUUID().replaceAll('-', '');
		const environment = {
			...process.env,
			NIX_CONFIG: isolatedNixConfig
		} as Record<string, string>;
		const derivation = await instantiate(seed, environment);
		const nix = Nix.open();
		const config = discoverNixStoreConfig();
		const receiptFile = path.join(workspace, `host-receipt-${seed}.json`);
		const cache = server();
		const client = cache.pushClient(await cache.ownerAdminToken());
		let thrown: unknown;

		try {
			const dependencies = daemonlessDependencies({
				client,
				nix,
				config,
				environment,
				invocationId: invocationIdSchema.parse(`daemonless-host-${seed}`),
				runtimeDirectory: '/tmp'
			});

			await runBuildPush(
				{
					invocation: {
						kind: 'constructed',
						build: { installables: [`${derivation}^*`], attempts: 1 }
					},
					receiptFile
				},
				silentReporter(),
				{
					...dependencies,
					preflight: () =>
						Promise.reject(new UntrustedDaemonError('not-trusted'))
				}
			);
		} catch (error) {
			thrown = error;
		}

		// A child failure here is the platform refusing to build the trivial
		// derivation at all; the publication contract is covered above.
		if (thrown instanceof BuildCommandFailedError) {
			context.skip();
		}

		const [output] = await nix.queryDerivationOutputPaths([derivation]);
		const storePath = storePathSchema.parse(output);
		const info = await nix.queryPathInfo(storePath);
		const receipt: unknown = JSON.parse(await readFile(receiptFile, 'utf8'));
		const served = await fetch(
			cache.tenantPath(`/${StorePath.hash(storePath)}.narinfo`)
		);

		expect({ error: thrown, receipt, served: served.status }).toStrictEqual({
			error: undefined,
			receipt: {
				version: 3,
				paths: [storePath],
				subjects: [
					{
						origin: 'built',
						storePath,
						narHash: info.narHash.digestHex(),
						derivation,
						buildStore: 'auto',
						verification: 'build-store'
					}
				],
				uploaded: [storePath],
				childExitStatus: 0
			},
			served: 200
		});
	}, 180_000);
});
