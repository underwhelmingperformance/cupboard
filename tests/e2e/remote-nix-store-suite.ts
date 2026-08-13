import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	rootNameSchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import { buildReceiptV3Schema } from '@cupboard/protocol/build';
import {
	parseReporterResults,
	type Reporter,
	type ReporterResultEvent
} from '@cupboard/reporter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { attestAction } from '../../actions/src/commands/attest.ts';
import {
	buildCohortAction,
	runNixBuildWithResults,
	runNixCopy,
	runNixDerivationShow,
	runWithLocalDerivationRoots,
	type WithLocalDerivationRoots
} from '../../actions/src/commands/build-cohort.ts';
import type { runCupboard } from '../../actions/src/cupboard-run.ts';
import {
	RemoteCohortBuildFailedError,
	SubjectNarHashMovedError
} from '../../actions/src/errors.ts';
import { writeCachedSession } from '../../packages/cli/src/auth/token-store.ts';
import { buildProgram as buildCliProgram } from '../../packages/cli/src/cli.ts';
import { tenantRpc } from '../../packages/cli/src/client/orpc.ts';
import { PublicationCollection } from '../../packages/cli/src/push/publication.ts';
import { runPush } from '../../packages/cli/src/push/push.ts';
import { Nix } from '../../packages/nix/src/nix.ts';
import { NixDaemonRemoteError } from '../../packages/nix/src/nix-daemon.ts';
import { createProcessNixDaemonConnector } from '../../packages/nix/src/nix-daemon-process.ts';
import type { NixDerivedPathString } from '../../packages/nix/src/nix-store.ts';
import { settleCleanups } from '../support/cleanup.ts';
import { CupboardTestServer } from '../support/cupboard-server.ts';
import {
	makeWritable,
	temporaryRoot,
	withTemporaryDirectory
} from '../support/filesystem.ts';
import { isolatedEnvironment } from '../support/nix.ts';
import { CommandFailedError, runCommand } from '../support/process.ts';
import {
	type NixSshStoreFixture,
	startNixSshStore
} from '../support/remote-nix-store.ts';

interface RemoteNixStoreFixtureState {
	store?: NixSshStoreFixture;
	hostEnvironment?: NodeJS.ProcessEnv;
	nixEnvironment?: NodeJS.ProcessEnv;
	localStoreRoot?: string;
	workspace?: string;
}

const fixture: RemoteNixStoreFixtureState = {};
const prepareSshTransport = path.resolve('actions/prepare/ssh-transport.sh');
const isolatedNixConfig = [
	'experimental-features = nix-command flakes',
	'substituters =',
	'builders =',
	'sandbox = false'
].join('\n');
const rejectingUnknownHostSshOptions = [
	'-oBatchMode=yes',
	'-oStrictHostKeyChecking=yes',
	'-oUserKnownHostsFile=/dev/null',
	'-oGlobalKnownHostsFile=/dev/null',
	'-oKnownHostsCommand=none'
].join(' ');

function remoteStore(): NixSshStoreFixture {
	const store = fixture.store;

	if (store === undefined) {
		throw new Error('The remote Nix store was not started');
	}

	return store;
}

const withFixtureLocalDerivationRoots: WithLocalDerivationRoots = (
	derivations,
	use,
	signal
) => {
	const storeRoot = fixture.localStoreRoot;

	if (storeRoot === undefined) {
		throw new Error('The isolated local Nix store was not prepared');
	}

	return runWithLocalDerivationRoots(derivations, use, signal, {
		openNix: (options) =>
			Nix.openForAvailability(undefined, {
				...options,
				storeUri: 'ssh-ng://fixture-local-store',
				connect: createProcessNixDaemonConnector('nix', [
					'daemon',
					'--stdio',
					'--store',
					`local?root=${storeRoot}`
				])
			})
	});
};

function fixtureLocalStoreUri(): string {
	const storeRoot = fixture.localStoreRoot;

	if (storeRoot === undefined) {
		throw new Error('The isolated local Nix store was not prepared');
	}

	return `local?root=${storeRoot}`;
}

const runFixtureNixDerivationShow: typeof runNixDerivationShow = (
	installables,
	signal,
	isRecursive
) =>
	runNixDerivationShow(installables, signal, isRecursive, {
		evalStore: fixtureLocalStoreUri()
	});

function replaceProcessEnvironment(environment: NodeJS.ProcessEnv): void {
	for (const name of Object.keys(process.env)) {
		Reflect.deleteProperty(process.env, name);
	}

	Object.assign(process.env, environment);
}

async function withHostEnvironment<T>(run: () => Promise<T>): Promise<T> {
	const hostEnvironment = fixture.hostEnvironment;
	const nixEnvironment = fixture.nixEnvironment;

	if (hostEnvironment === undefined || nixEnvironment === undefined) {
		throw new Error('The remote Nix store environment was not prepared');
	}

	replaceProcessEnvironment(hostEnvironment);

	try {
		return await run();
	} finally {
		replaceProcessEnvironment(nixEnvironment);
	}
}

/** Declares the real SSH-backed remote-store cases. */
export function describeRemoteNixStore(): void {
	describe('remote Nix store end to end', () => {
		beforeAll(async () => {
			fixture.hostEnvironment = { ...process.env };
			fixture.store = await startNixSshStore();
			fixture.workspace = await mkdtemp(
				path.join(temporaryRoot, 'cupboard-remote-local-store-')
			);
			const home = path.join(fixture.workspace, 'home');
			const storeRoot = path.join(fixture.workspace, 'store');
			await mkdir(storeRoot, { recursive: true });
			fixture.localStoreRoot = storeRoot;
			fixture.nixEnvironment = {
				...(await isolatedEnvironment(home)),
				NIX_CONFIG: isolatedNixConfig,
				NIX_REMOTE: `local?root=${storeRoot}`
			};
			replaceProcessEnvironment(fixture.nixEnvironment);
		}, 300_000);

		afterAll(async () => {
			const hostEnvironment = fixture.hostEnvironment;

			if (hostEnvironment !== undefined) {
				replaceProcessEnvironment(hostEnvironment);
			}

			await settleCleanups(
				[
					() => fixture.store?.close() ?? Promise.resolve(),
					() => removeFixtureWorkspace(fixture.workspace)
				],
				'Remote Nix store fixture cleanup failed'
			);
		}, 60_000);

		it('isolates every local Nix process in a temporary store and configuration', async () => {
			const storeRoot = fixture.localStoreRoot;

			if (storeRoot === undefined) {
				throw new Error('The isolated local Nix store was not prepared');
			}

			await withTemporaryDirectory(
				'cupboard-remote-isolation-',
				async (directory) => {
					const source = path.join(directory, 'source');
					const contents = 'remote-store suite local isolation\n';
					await writeFile(source, contents);
					const added = await runCommand('nix', ['store', 'add-file', source]);
					const storePath = storePathSchema.parse(added.stdout.trim());

					expect({
						environmentNames: Object.keys(process.env).toSorted(byCodeUnit),
						storedContents: await readFile(
							path.join(storeRoot, storePath),
							'utf8'
						)
					}).toStrictEqual({
						environmentNames: [
							'HOME',
							'NIX_CONFIG',
							'NIX_CONF_DIR',
							'NIX_REMOTE',
							'NIX_USER_CONF_FILES',
							'PATH',
							'TMPDIR'
						],
						storedContents: contents
					});
				}
			);
		});

		it('streams a remote build while its temporary root protects it from GC', async () => {
			const store = remoteStore();
			const system = await store.exec([
				'nix',
				'eval',
				'--raw',
				'--impure',
				'--expr',
				'builtins.currentSystem'
			]);
			await withTemporaryDirectory(
				'cupboard-remote-flake-',
				async (directory) => runRemoteBuild(directory, system, store)
			);
		});

		it('rejects a host key that does not identify the remote store', async () => {
			const store = remoteStore();
			const nix = Nix.openForAvailability(undefined, {
				storeUri: store.mismatchedHostKeyStoreUri,
				overrides: { substituters: '' }
			});

			await withSshOptions(undefined, () =>
				expect(nix.queryValidPaths([])).rejects.toBeInstanceOf(
					NixDaemonRemoteError
				)
			);
		});

		it('uses job-scoped SSH credentials independently of the store URI', async () => {
			const store = remoteStore();

			await withSshOptions(store.environment.NIX_SSHOPTS, async () => {
				const nix = Nix.openForAvailability(undefined, {
					storeUri: store.transportConfiguredStoreUri,
					overrides: { substituters: '' }
				});

				await expect(nix.queryValidPaths([])).resolves.toStrictEqual([]);
			});
		});

		it('uses the prepare action transport for native copy and rejects the wrong host pin', async () => {
			const store = remoteStore();

			await withTemporaryDirectory(
				'cupboard-prepare-ssh-',
				async (directory) => {
					const source = path.join(directory, 'native-copy-source');
					await writeFile(
						source,
						'copied through the prepared SSH transport\n'
					);
					const added = await runCommand('nix', ['store', 'add-file', source]);
					const storePath = added.stdout.trim();

					await expect(
						runCommand(
							'nix',
							[
								'copy',
								'--to',
								store.transportConfiguredStoreUri,
								'--',
								storePath
							],
							{
								env: {
									...process.env,
									NIX_SSHOPTS: rejectingUnknownHostSshOptions
								}
							}
						)
					).rejects.toBeInstanceOf(CommandFailedError);

					const configured = await preparedSshOptions(
						directory,
						store,
						store.transportInputs.knownHosts
					);

					await expect(
						runCommand(
							'nix',
							[
								'copy',
								'--to',
								store.transportConfiguredStoreUri,
								'--',
								storePath
							],
							{ env: { ...process.env, NIX_SSHOPTS: configured } }
						)
					).resolves.toMatchObject({ stdout: '' });

					const mismatchDirectory = path.join(directory, 'mismatch');
					await mkdir(mismatchDirectory);
					const mismatched = await preparedSshOptions(
						mismatchDirectory,
						store,
						store.transportInputs.mismatchedKnownHosts
					);

					await expect(
						runCommand(
							'nix',
							['store', 'ping', '--store', store.transportConfiguredStoreUri],
							{ env: { ...process.env, NIX_SSHOPTS: mismatched } }
						)
					).rejects.toBeInstanceOf(CommandFailedError);
				}
			);
		}, 300_000);

		it('cancels one SSH daemon and reconnects with no remote process left behind', async () => {
			const store = remoteStore();
			const controller = new AbortController();
			const reason = new Error('cancel remote SSH request');
			const blocked = Nix.openForAvailability(undefined, {
				storeUri: store.blockingStoreUri,
				overrides: { substituters: '' },
				signal: controller.signal
			});
			const query = blocked.queryValidPaths([]);

			const started = store.waitForBlockingDaemonEvent('started');
			await expect(started).resolves.toBeUndefined();
			let didQuerySettle = false;
			void query
				.then(() => {
					didQuerySettle = true;
				})
				.catch(() => {
					didQuerySettle = true;
				});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(didQuerySettle).toBe(false);
			const stopped = store.waitForBlockingDaemonEvent('stopped');
			controller.abort(reason);

			await expect(query).rejects.toBe(reason);
			await expect(stopped).resolves.toBeUndefined();

			const reconnected = Nix.openForAvailability(undefined, {
				storeUri: store.storeUri,
				overrides: { substituters: '' }
			});

			await expect(reconnected.queryValidPaths([])).resolves.toStrictEqual([]);
		});

		it('cancels native copy and its remote SSH process tree', async () => {
			const store = remoteStore();

			await withTemporaryDirectory(
				'cupboard-cancel-copy-',
				async (directory) => {
					const source = path.join(directory, 'copy-source');
					await writeFile(source, 'cancelled native copy\n');
					const added = await runCommand('nix', ['store', 'add-file', source]);
					const storePath = storePathSchema.parse(added.stdout.trim());
					const sshDirectory = path.join(directory, 'ssh');
					await mkdir(sshDirectory);
					const sshOptions = await preparedSshOptions(
						sshDirectory,
						store,
						store.transportInputs.knownHosts
					);
					const controller = new AbortController();
					const reason = new Error('cancel native copy');

					await withSshOptions(sshOptions, async () => {
						const started = store.waitForBlockingDaemonEvent('started');
						const copy = runNixCopy(
							[storePath],
							store.blockingTransportConfiguredStoreUri,
							controller.signal
						);

						await expect(started).resolves.toBeUndefined();
						const stopped = store.waitForBlockingDaemonEvent('stopped');
						controller.abort(reason);

						await expect(copy).rejects.toBe(reason);
						await expect(stopped).resolves.toBeUndefined();

						const reconnected = Nix.openForAvailability(undefined, {
							storeUri: store.transportConfiguredStoreUri,
							overrides: { substituters: '' }
						});

						await expect(
							reconnected.queryValidPaths([])
						).resolves.toStrictEqual([]);
					});
				}
			);
		});

		it('cancels an action-level remote cohort before publication', async () => {
			await runCancelledBuildCohort(remoteStore());
		}, 300_000);

		it('publishes and roots an already-valid remote output without claiming it', async () => {
			await runAlreadyValidPublication(remoteStore());
		}, 300_000);

		it('publishes remote outputs across copy-barrier GC and resolves attestation subjects after the store disappears', async () => {
			await runAllSuccessPublicationAndSubjectResolution();
		}, 300_000);

		it('publishes a mixed remote build with a receipt and retention root', async () => {
			await runRemotePublication(remoteStore());
		}, 300_000);
	});
}

async function removeFixtureWorkspace(
	workspace: string | undefined
): Promise<void> {
	if (workspace === undefined) {
		return;
	}

	await makeWritable(workspace);
	await rm(workspace, { force: true, recursive: true });
}

async function preparedSshOptions(
	directory: string,
	store: NixSshStoreFixture,
	knownHosts: string
): Promise<string> {
	const githubEnvironment = path.join(directory, 'github-env');
	await writeFile(githubEnvironment, '');
	await runCommand('bash', [prepareSshTransport, 'configure'], {
		env: {
			...process.env,
			RUNNER_TEMP: directory,
			GITHUB_ENV: githubEnvironment,
			REMOTE: 'false',
			STORE: store.transportConfiguredStoreUri,
			BUILDERS: '',
			BUILDER_SSH_KEY: '',
			BUILDER_SSH_CONFIG: '',
			BUILDER_KNOWN_HOSTS: '',
			STORE_SSH_KEY: store.transportInputs.privateKey,
			STORE_SSH_CONFIG: '',
			STORE_KNOWN_HOSTS: knownHosts,
			STORE_AMBIENT_IDENTITY: 'false'
		}
	});

	const exported = await readFile(githubEnvironment, 'utf8');
	const options = exported
		.split('\n')
		.find((line) => line.startsWith('NIX_SSHOPTS='));

	if (options === undefined) {
		throw new Error('The prepare transport exported no NIX_SSHOPTS');
	}

	return options.slice('NIX_SSHOPTS='.length);
}

async function runRemoteBuild(
	directory: string,
	system: string,
	store: NixSshStoreFixture
): Promise<void> {
	await writeFile(path.join(directory, 'flake.nix'), remoteBuildFlake(system));
	const installable = `path:${directory}#packages.${system}.default`;
	const evaluated = await runFixtureNixDerivationShow(
		[installable],
		undefined,
		false
	);
	const evaluatedPaths = evaluated.map((reported) =>
		absoluteStorePath(reported)
	);
	const [drvPath] = evaluatedPaths;

	if (drvPath === undefined || evaluatedPaths.length !== 1) {
		throw new Error(
			`The tiny fixture evaluated to ${String(evaluatedPaths.length)} derivations`
		);
	}

	const queriedOutputs = await runCommand('nix-store', [
		'--query',
		'--outputs',
		drvPath
	]);
	const outputPath = storePathSchema.parse(queriedOutputs.stdout.trim());
	const target = `${drvPath}^*` as NixDerivedPathString;

	await withSshOptions(undefined, () =>
		runNixBuildWithResults(
			[target],
			'',
			store.storeUri,
			async (results) => {
				const nix = Nix.openForAvailability(undefined, {
					storeUri: store.storeUri,
					overrides: { substituters: '' }
				});
				const copied = await nix.queryValidPaths([drvPath, outputPath]);
				const info = await nix.queryPathInfo(outputPath);
				const closure = await nix.resolveClosure([outputPath]);
				const nar = Buffer.concat(
					await Array.fromAsync(nix.narFromPath(outputPath), (chunk) =>
						Buffer.from(chunk)
					)
				);
				const narHash = NixSha256Hash.fromDigest(
					createHash('sha256').update(nar).digest()
				);

				expect({
					evaluated: evaluatedPaths,
					storeKind: nix.storeKind,
					copied,
					build: results.map((result) => ({
						target: result.target,
						outcome: result.outcome
					})),
					info: {
						storePath: info.storePath,
						deriver: info.deriver,
						references: info.references,
						narSize: info.narSize,
						narHash: info.narHash.toString()
					},
					closure: closure.map((entry) => entry.storePath),
					streamedNar: {
						byteLength: nar.byteLength,
						hash: narHash.toString()
					}
				}).toStrictEqual({
					evaluated: [drvPath],
					storeKind: 'ssh-ng',
					copied: [drvPath, outputPath].toSorted(byCodeUnit),
					build: [
						{
							target,
							outcome: { kind: 'built', outputs: { out: outputPath } }
						}
					],
					info: {
						storePath: outputPath,
						deriver: drvPath,
						references: [],
						narSize: nar.byteLength,
						narHash: narHash.toString()
					},
					closure: [outputPath],
					streamedNar: {
						byteLength: nar.byteLength,
						hash: info.narHash.toString()
					}
				});

				await store.exec(['nix', 'store', 'gc']);
				await expect(nix.queryValidPaths([outputPath])).resolves.toStrictEqual([
					outputPath
				]);
			},
			undefined,
			{
				derivations: [drvPath],
				copy: () =>
					withSshOptions(store.environment.NIX_SSHOPTS, () =>
						runNixCopy([drvPath], store.storeUri)
					)
			}
		)
	);

	await store.exec(['nix', 'store', 'gc']);
	const unrooted = Nix.openForAvailability(undefined, {
		storeUri: store.storeUri,
		overrides: { substituters: '' }
	});
	await expect(unrooted.queryValidPaths([outputPath])).resolves.toStrictEqual(
		[]
	);
}

interface RemotePreparedMember {
	readonly attribute: string;
	readonly derivation: StorePathString;
	readonly installable: string;
	readonly outputs: readonly StorePathString[];
	readonly root: string;
	readonly target: NixDerivedPathString;
}

interface RemoteCohortMember extends RemotePreparedMember {
	readonly output: StorePathString;
}

interface RemotePublicationPlan {
	readonly members: readonly Pick<RemotePreparedMember, 'target'>[];
	readonly server: CupboardTestServer;
	readonly token: string;
	readonly uploadBarrier?: AsyncBarrier;
}

class AsyncBarrier {
	private readonly arrival = Promise.withResolvers<undefined>();
	private readonly continuation = Promise.withResolvers<undefined>();

	readonly arrived = this.arrival.promise;

	async pause(): Promise<void> {
		this.arrival.resolve(undefined);
		await this.continuation.promise;
	}

	release(): void {
		this.continuation.resolve(undefined);
	}
}

async function runCancelledBuildCohort(
	store: NixSshStoreFixture
): Promise<void> {
	await withTemporaryDirectory(
		'cupboard-remote-action-cancel-',
		async (directory) => {
			const flakeDirectory = path.join(directory, 'flake');
			const runDirectory = path.join(directory, 'run');
			await Promise.all([
				mkdir(flakeDirectory, { recursive: true }),
				mkdir(runDirectory, { recursive: true })
			]);
			const system = await store.exec([
				'nix',
				'eval',
				'--raw',
				'--impure',
				'--expr',
				'builtins.currentSystem'
			]);
			await writeFile(
				path.join(flakeDirectory, 'flake.nix'),
				allSuccessPublicationFlake(system)
			);
			const member = await prepareRemotePreparedMember(
				flakeDirectory,
				system,
				'single',
				'cancelled-root'
			);
			const server = await CupboardTestServer.start(
				path.join(directory, 'server')
			);

			try {
				const token = await server.ownerAdminToken();
				const sshDirectory = path.join(directory, 'ssh');
				await mkdir(sshDirectory);
				const sshOptions = await preparedSshOptions(
					sshDirectory,
					store,
					store.transportInputs.knownHosts
				);
				const controller = new AbortController();
				const reason = new Error('cancel action-level remote cohort');
				const receiptFile = path.join(runDirectory, 'receipt.json');
				const outputFile = path.join(runDirectory, 'github-output');
				const plan: RemotePublicationPlan = {
					members: [member],
					server,
					token
				};

				const started = store.waitForBlockingDaemonEvent('started');
				const action = withSshOptions(sshOptions, () =>
					buildCohortAction(
						{
							cohortJson: JSON.stringify({
								key: 'cancelled-remote-action',
								attrs: [member.attribute],
								installables: [member.installable],
								queryInstallables: [member.target],
								expectedPaths: [member.outputs[0]],
								roots: [member.root],
								system,
								os: 'linux',
								remote: true,
								runsOn: 'ubuntu-24.04'
							}),
							url: server.tenantUrl.href,
							cupboardPath: 'in-process-cupboard',
							store: store.blockingTransportConfiguredStoreUri,
							push: 'true',
							receiptFile
						},
						{ RUNNER_TEMP: runDirectory, GITHUB_OUTPUT: outputFile },
						{
							reporter: silentReporter(),
							runCupboard: publicationCupboard(plan),
							withLocalDerivationRoots: withFixtureLocalDerivationRoots,
							runNixDerivationShow: runFixtureNixDerivationShow,
							signal: controller.signal
						}
					)
				);

				await started;
				const stopped = store.waitForBlockingDaemonEvent('stopped');
				controller.abort(reason);

				await expect(action).rejects.toBe(reason);
				await expect(stopped).resolves.toBeUndefined();
				await expect(readFile(receiptFile, 'utf8')).rejects.toMatchObject({
					code: 'ENOENT'
				});
				await expect(readFile(outputFile, 'utf8')).rejects.toMatchObject({
					code: 'ENOENT'
				});

				const roots = await tenantRpc(server.tenantUrl, {
					credential: token
				}).roots.list({ params: { cacheName: '_default' } });
				const validPaths = await withSshOptions(sshOptions, () => {
					const reconnected = Nix.openForAvailability(undefined, {
						storeUri: store.transportConfiguredStoreUri,
						overrides: { substituters: '' }
					});

					return reconnected.queryValidPaths([]);
				});

				expect({
					roots: roots.roots,
					validPaths
				}).toStrictEqual({ roots: [], validPaths: [] });
			} finally {
				await server.stop();
			}
		},
		{ makeWritableBeforeCleanup: true }
	);
}

interface RealPlanningHarness {
	readonly directory: string;
	readonly runs: {
		readonly command: 'cohort' | 'reprobe';
		readonly store: string | undefined;
		readonly results: readonly ReporterResultEvent[];
	}[];
}

async function runAlreadyValidPublication(
	store: NixSshStoreFixture
): Promise<void> {
	await withTemporaryDirectory(
		'cupboard-remote-already-valid-',
		async (directory) => {
			const flakeDirectory = path.join(directory, 'flake');
			const runDirectory = path.join(directory, 'run');
			await Promise.all([
				mkdir(flakeDirectory, { recursive: true }),
				mkdir(runDirectory, { recursive: true })
			]);
			const server = await CupboardTestServer.start(
				path.join(directory, 'server')
			);

			try {
				const system = await store.exec([
					'nix',
					'eval',
					'--raw',
					'--impure',
					'--expr',
					'builtins.currentSystem'
				]);
				await writeFile(
					path.join(flakeDirectory, 'flake.nix'),
					alreadyValidPublicationFlake(system)
				);
				const member = await prepareRemotePublicationMember(
					flakeDirectory,
					system,
					'already',
					'github:owner/repo/remote-already-valid'
				);

				await withSshOptions(undefined, () =>
					runNixBuildWithResults(
						[member.target],
						'',
						store.storeUri,
						() => Promise.resolve(),
						undefined,
						{
							derivations: [member.derivation],
							copy: () =>
								withSshOptions(store.environment.NIX_SSHOPTS, () =>
									runNixCopy([member.derivation], store.storeUri)
								)
						}
					)
				);

				await expect(
					runCommand('nix-store', ['--check-validity', member.output])
				).rejects.toMatchObject({ code: 1 });

				const token = await server.ownerAdminToken();
				const receiptFile = path.join(runDirectory, 'receipt.json');
				const outputFile = path.join(runDirectory, 'github-output');
				const plan: RemotePublicationPlan = {
					members: [member],
					server,
					token
				};

				await withSshOptions(undefined, () =>
					buildCohortAction(
						{
							cohortJson: JSON.stringify({
								key: 'remote-already-valid',
								attrs: [member.attribute],
								installables: [member.installable],
								queryInstallables: [member.target],
								expectedPaths: [member.output],
								roots: [member.root],
								system,
								os: 'linux',
								remote: true,
								runsOn: 'ubuntu-24.04'
							}),
							url: server.tenantUrl.href,
							cupboardPath: 'in-process-cupboard',
							store: store.storeUri,
							push: 'true',
							receiptFile
						},
						{ RUNNER_TEMP: runDirectory, GITHUB_OUTPUT: outputFile },
						{
							reporter: silentReporter(),
							runCupboard: publicationCupboard(plan),
							withLocalDerivationRoots: withFixtureLocalDerivationRoots,
							runNixDerivationShow: runFixtureNixDerivationShow,
							runNixCopy: (paths, storeUri, signal) =>
								withSshOptions(store.environment.NIX_SSHOPTS, () =>
									runNixCopy(paths, storeUri, signal)
								)
						}
					)
				);

				const receipt = buildReceiptV3Schema.parse(
					JSON.parse(await readFile(receiptFile, 'utf8'))
				);
				const rpc = tenantRpc(server.tenantUrl, { credential: token });
				const roots = await rpc.roots.list({
					params: { cacheName: '_default' }
				});
				const rootTargets = await rpc.roots.targets({
					params: { cacheName: '_default', name: member.root },
					query: {}
				});
				const served = await fetch(
					server.tenantPath(`/${StorePath.hash(member.output)}.narinfo`)
				);

				expect({
					receipt,
					served: served.status,
					roots: roots.roots.map((root) => ({
						name: root.name,
						targetCount: root.targetCount
					})),
					rootTargets: rootTargets.targets
				}).toStrictEqual({
					receipt: {
						version: 3,
						paths: [member.output],
						subjects: [],
						uploaded: [member.output]
					},
					served: 200,
					roots: [{ name: member.root, targetCount: 1 }],
					rootTargets: [
						{
							storePathHash: StorePath.hash(member.output),
							storePath: member.output,
							present: true
						}
					]
				});
			} finally {
				await server.stop();
			}
		},
		{ makeWritableBeforeCleanup: true }
	);
}

async function runAllSuccessPublicationAndSubjectResolution(): Promise<void> {
	await withTemporaryDirectory(
		'cupboard-remote-all-success-',
		async (directory) => {
			const flakeDirectory = path.join(directory, 'flake');
			const runDirectory = path.join(directory, 'run');
			const sshDirectory = path.join(directory, 'ssh');
			await Promise.all([
				mkdir(flakeDirectory, { recursive: true }),
				mkdir(runDirectory, { recursive: true }),
				mkdir(sshDirectory, { recursive: true })
			]);

			let store: NixSshStoreFixture | undefined;
			let server: CupboardTestServer | undefined;

			try {
				store = await withHostEnvironment(() => startNixSshStore());
				server = await CupboardTestServer.start(path.join(directory, 'server'));
				const activeStore = store;
				const activeServer = server;
				const sshOptions = await preparedSshOptions(
					sshDirectory,
					activeStore,
					activeStore.transportInputs.knownHosts
				);
				const storeUri = activeStore.transportConfiguredStoreUri;
				const system = await activeStore.exec([
					'nix',
					'eval',
					'--raw',
					'--impure',
					'--expr',
					'builtins.currentSystem'
				]);
				const members = await prepareAllSuccessRemoteCohort(
					flakeDirectory,
					system
				);
				const [single, multiple] = members;

				if (
					single === undefined ||
					multiple === undefined ||
					single.outputs.length !== 1 ||
					multiple.outputs.length !== 2
				) {
					throw new Error(
						'The all-success cohort did not contain one single-output and one two-output member'
					);
				}

				const paths = members
					.flatMap((member) => member.outputs)
					.toSorted(byCodeUnit);
				await expectLocalStoreAbsence(paths);

				const token = await activeServer.ownerAdminToken();
				const receiptFile = path.join(runDirectory, 'receipt.json');
				const outputFile = path.join(runDirectory, 'build-output');
				const uploadBarrier = new AsyncBarrier();
				const plan: RemotePublicationPlan = {
					members,
					server: activeServer,
					token,
					uploadBarrier
				};
				let didCollectLocalBeforeCopy = false;
				let didCollectRemoteDuringUpload = false;

				const publication = withSshOptions(sshOptions, () =>
					buildCohortAction(
						{
							cohortJson: JSON.stringify({
								key: 'remote-all-success',
								attrs: members.map((member) => member.attribute),
								installables: members.map((member) => member.installable),
								queryInstallables: members.map((member) => member.target),
								expectedPaths: [single.outputs[0], undefined],
								roots: members.map((member) => member.root),
								system,
								os: 'linux',
								remote: true,
								runsOn: 'ubuntu-24.04'
							}),
							url: activeServer.tenantUrl.href,
							cupboardPath: 'in-process-cupboard',
							store: storeUri,
							push: 'true',
							receiptFile
						},
						{ RUNNER_TEMP: runDirectory, GITHUB_OUTPUT: outputFile },
						{
							reporter: silentReporter(),
							runCupboard: publicationCupboard(plan),
							withLocalDerivationRoots: withFixtureLocalDerivationRoots,
							runNixDerivationShow: runFixtureNixDerivationShow,
							runNixCopy: async (derivations, storeUri, signal) => {
								await runCommand('nix', ['store', 'gc']);
								didCollectLocalBeforeCopy = true;
								await runNixCopy(derivations, storeUri, signal);
							}
						}
					)
				);
				await uploadBarrier.arrived;

				try {
					await activeStore.exec(['nix', 'store', 'gc']);
					didCollectRemoteDuringUpload = true;
				} finally {
					uploadBarrier.release();
				}

				await publication;

				const receipt = buildReceiptV3Schema.parse(
					JSON.parse(await readFile(receiptFile, 'utf8'))
				);
				const pathInfos = new Map(
					await withSshOptions(sshOptions, async () => {
						const remote = Nix.openForAvailability(undefined, {
							storeUri,
							overrides: { substituters: '' }
						});

						return Promise.all(
							paths.map(async (storePath) => {
								const info = await remote.queryPathInfo(storePath);

								return [storePath, info] as const;
							})
						);
					})
				);
				const expectedSubjects = paths.map((storePath) => {
					const member = members.find(({ outputs }) =>
						outputs.includes(storePath)
					);
					const info = pathInfos.get(storePath);

					if (member === undefined || info === undefined) {
						throw new Error(`Missing all-success evidence for ${storePath}`);
					}

					return {
						storePath,
						narHash: info.narHash.digestHex(),
						derivation: member.derivation,
						buildStore: storeUri,
						verification: 'build-store' as const
					};
				});
				const buildOutput = await readFile(outputFile, 'utf8');
				const buildOutputs = buildOutput
					.split('\n')
					.filter((line) => line.startsWith('receipt-file='));

				expect({
					didCollectLocalBeforeCopy,
					didCollectRemoteDuringUpload,
					receipt,
					receiptOutput: buildOutputs
				}).toStrictEqual({
					didCollectLocalBeforeCopy: true,
					didCollectRemoteDuringUpload: true,
					receipt: {
						version: 3,
						paths,
						subjects: expectedSubjects,
						uploaded: paths
					},
					receiptOutput: [`receipt-file=${receiptFile}`]
				});

				await expectLocalStoreAbsence(paths);
				await withHostEnvironment(() => activeStore.close());
				store = undefined;

				const rpc = tenantRpc(activeServer.tenantUrl, { credential: token });
				const roots = await rpc.roots.list({
					params: { cacheName: '_default' }
				});
				const ownedTargets = await Promise.all(
					members.map(async (member) => {
						const rootTargets = await rpc.roots.targets({
							params: { cacheName: '_default', name: member.root },
							query: {}
						});

						return {
							root: member.root,
							targets: rootTargets.targets.toSorted((left, right) =>
								byCodeUnit(left.storePath, right.storePath)
							)
						};
					})
				);
				const servedStatuses = await Promise.all(
					paths.map(async (storePath) => {
						const response = await fetch(
							activeServer.tenantPath(`/${StorePath.hash(storePath)}.narinfo`)
						);

						return response.status;
					})
				);

				expect({
					roots: roots.roots
						.map((root) => ({
							name: root.name,
							targetCount: root.targetCount
						}))
						.toSorted((left, right) => byCodeUnit(left.name, right.name)),
					ownedTargets: ownedTargets.toSorted((left, right) =>
						byCodeUnit(left.root, right.root)
					),
					servedStatuses
				}).toStrictEqual({
					roots: [
						{ name: multiple.root, targetCount: 2 },
						{ name: single.root, targetCount: 1 }
					].toSorted((left, right) => byCodeUnit(left.name, right.name)),
					ownedTargets: [
						{
							root: multiple.root,
							targets: multiple.outputs
								.toSorted(byCodeUnit)
								.map((storePath) => ({
									storePathHash: StorePath.hash(storePath),
									storePath,
									present: true
								}))
						},
						{
							root: single.root,
							targets: single.outputs.map((storePath) => ({
								storePathHash: StorePath.hash(storePath),
								storePath,
								present: true
							}))
						}
					].toSorted((left, right) => byCodeUnit(left.root, right.root)),
					servedStatuses: paths.map(() => 200)
				});

				const checksumsFile = path.join(runDirectory, 'subjects.txt');
				const attestOutput = path.join(runDirectory, 'attest-output');
				await attestAction(
					{
						receiptFile,
						checksumsFile,
						url: activeServer.tenantUrl.href
					},
					{ RUNNER_TEMP: runDirectory, GITHUB_OUTPUT: attestOutput },
					silentReporter()
				);

				expect({
					checksums: await readFile(checksumsFile, 'utf8'),
					outputs: await readFile(attestOutput, 'utf8')
				}).toStrictEqual({
					checksums: expectedSubjects
						.map(
							(subject) =>
								`${subject.narHash}  ${path.basename(subject.storePath)}\n`
						)
						.join(''),
					outputs: `checksums-file=${checksumsFile}\nsubject-count=${String(paths.length)}\n`
				});

				const rejectedChecksumsFile = path.join(
					runDirectory,
					'tampered-subjects.txt'
				);
				const rejectedOutput = path.join(
					runDirectory,
					'tampered-attest-output'
				);
				const alteredNarHash = NixSha256Hash.fromDigest(
					Buffer.alloc(32, 0xff)
				).toString();
				const tamperedFetch: typeof fetch = async (input, init) => {
					const response = await fetch(input, init);
					const source = await response.text();

					return new Response(
						source.replace(
							/^NarHash: .+$/mu,
							() => `NarHash: ${alteredNarHash}`
						),
						{
							status: response.status,
							headers: response.headers
						}
					);
				};

				await expect(
					attestAction(
						{
							receiptFile,
							checksumsFile: rejectedChecksumsFile,
							url: activeServer.tenantUrl.href
						},
						{ RUNNER_TEMP: runDirectory, GITHUB_OUTPUT: rejectedOutput },
						silentReporter(),
						{ fetch: tamperedFetch }
					)
				).rejects.toBeInstanceOf(SubjectNarHashMovedError);
				await expect(
					readFile(rejectedChecksumsFile, 'utf8')
				).rejects.toMatchObject({ code: 'ENOENT' });
				await expect(readFile(rejectedOutput, 'utf8')).rejects.toMatchObject({
					code: 'ENOENT'
				});
			} finally {
				const storeToClose = store;

				await settleCleanups(
					[
						() =>
							storeToClose === undefined
								? Promise.resolve()
								: withHostEnvironment(() => storeToClose.close()),
						() => server?.stop() ?? Promise.resolve()
					],
					'Remote native-copy fixture cleanup failed'
				);
			}
		},
		{ makeWritableBeforeCleanup: true }
	);
}

async function runRemotePublication(store: NixSshStoreFixture): Promise<void> {
	await withTemporaryDirectory(
		'cupboard-remote-publication-',
		async (directory) => {
			const flakeDirectory = path.join(directory, 'flake');
			const runDirectory = path.join(directory, 'run');
			await Promise.all([
				mkdir(flakeDirectory, { recursive: true }),
				mkdir(runDirectory, { recursive: true })
			]);
			const server = await CupboardTestServer.start(
				path.join(directory, 'server')
			);

			try {
				const system = await store.exec([
					'nix',
					'eval',
					'--raw',
					'--impure',
					'--expr',
					'builtins.currentSystem'
				]);
				const members = await prepareRemotePublicationCohort(
					flakeDirectory,
					system
				);
				const [failed, successful] = members;

				if (successful === undefined || failed === undefined) {
					throw new Error(
						'The mixed remote cohort did not contain two members'
					);
				}

				const token = await server.ownerAdminToken();
				const receiptFile = path.join(runDirectory, 'receipt.json');
				const outputFile = path.join(runDirectory, 'github-output');
				const plan: RemotePublicationPlan = { members, server, token };
				const planning: RealPlanningHarness = {
					directory: path.join(runDirectory, 'real-planning'),
					runs: []
				};
				let actionError: unknown;

				try {
					await withSshOptions(undefined, () =>
						buildCohortAction(
							{
								cohortJson: JSON.stringify({
									key: 'remote-publication',
									attrs: members.map((member) => member.attribute),
									installables: members.map((member) => member.installable),
									queryInstallables: members.map((member) => member.target),
									expectedPaths: members.map((member) => member.output),
									roots: members.map((member) => member.root),
									system,
									os: 'linux',
									remote: true,
									runsOn: 'ubuntu-24.04'
								}),
								url: server.tenantUrl.href,
								cupboardPath: 'in-process-cupboard',
								store: store.storeUri,
								push: 'true',
								receiptFile
							},
							{ RUNNER_TEMP: runDirectory, GITHUB_OUTPUT: outputFile },
							{
								reporter: silentReporter(),
								runCupboard: publicationCupboard(plan, planning),
								withLocalDerivationRoots: withFixtureLocalDerivationRoots,
								runNixDerivationShow: runFixtureNixDerivationShow,
								runNixCopy: (paths, storeUri, signal) =>
									withSshOptions(store.environment.NIX_SSHOPTS, () =>
										runNixCopy(paths, storeUri, signal)
									)
							}
						)
					);
				} catch (error) {
					actionError = error;
				}

				expect(actionError).toBeInstanceOf(RemoteCohortBuildFailedError);

				const remote = Nix.openForAvailability(undefined, {
					storeUri: store.storeUri,
					overrides: { substituters: '' }
				});
				const info = await remote.queryPathInfo(successful.output);
				const receipt = buildReceiptV3Schema.parse(
					JSON.parse(await readFile(receiptFile, 'utf8'))
				);
				const rpc = tenantRpc(server.tenantUrl, { credential: token });
				const roots = await rpc.roots.list({
					params: { cacheName: '_default' }
				});
				const rootTargets = await rpc.roots.targets({
					params: { cacheName: '_default', name: successful.root },
					query: {}
				});
				const successfulNarInfo = server.tenantPath(
					`/${StorePath.hash(successful.output)}.narinfo`
				);
				const failedNarInfo = server.tenantPath(
					`/${StorePath.hash(failed.output)}.narinfo`
				);
				const [served, absent] = await Promise.all([
					fetch(successfulNarInfo),
					fetch(failedNarInfo)
				]);
				const outputs = await readFile(outputFile, 'utf8');

				expect({
					actionError:
						actionError instanceof RemoteCohortBuildFailedError
							? {
									name: actionError.name,
									failures: actionError.failures.map((failure) => ({
										target: failure.target,
										outcome: failure.outcome
									}))
								}
							: undefined,
					receipt,
					served: served.status,
					failed: absent.status,
					roots: roots.roots.map((root) => ({
						name: root.name,
						targetCount: root.targetCount
					})),
					rootTargets: rootTargets.targets,
					receiptOutput: outputs.includes(`receipt-file=${receiptFile}\n`),
					planning: planning.runs
				}).toStrictEqual({
					actionError: {
						name: 'RemoteCohortBuildFailedError',
						failures: [{ target: failed.target, outcome: 'permanent-failure' }]
					},
					receipt: {
						version: 3,
						paths: [successful.output],
						subjects: [
							{
								storePath: successful.output,
								narHash: info.narHash.digestHex(),
								derivation: successful.derivation,
								buildStore: store.storeUri,
								verification: 'build-store'
							}
						],
						terminalFailure: {
							kind: 'target-build',
							failedTargets: [failed.target]
						},
						uploaded: [successful.output]
					},
					served: 200,
					failed: 404,
					roots: [{ name: successful.root, targetCount: 1 }],
					rootTargets: [
						{
							storePathHash: StorePath.hash(successful.output),
							storePath: successful.output,
							present: true
						}
					],
					receiptOutput: true,
					planning: [
						{
							command: 'cohort',
							store: store.storeUri,
							results: publicationPlanResults(members)
						},
						{
							command: 'reprobe',
							store: undefined,
							results: publicationReprobeResults(members)
						}
					]
				});
			} finally {
				await server.stop();
			}
		},
		{ makeWritableBeforeCleanup: true }
	);
}

async function prepareRemotePublicationCohort(
	directory: string,
	system: string
): Promise<readonly RemoteCohortMember[]> {
	await writeFile(
		path.join(directory, 'flake.nix'),
		remotePublicationFlake(system)
	);

	const members: RemoteCohortMember[] = [];

	for (const { name, root } of [
		{ name: 'failure', root: 'github:owner/repo/remote-failure' },
		{ name: 'success', root: 'github:owner/repo/remote-success' }
	]) {
		members.push(
			await prepareRemotePublicationMember(directory, system, name, root)
		);
	}

	return members;
}

async function prepareAllSuccessRemoteCohort(
	directory: string,
	system: string
): Promise<readonly RemotePreparedMember[]> {
	await writeFile(
		path.join(directory, 'flake.nix'),
		allSuccessPublicationFlake(system)
	);

	const members: RemotePreparedMember[] = [];

	for (const { name, root } of [
		{ name: 'single', root: 'github:owner/repo/remote-single' },
		{ name: 'multiple', root: 'github:owner/repo/remote-multiple' }
	]) {
		members.push(
			await prepareRemotePreparedMember(directory, system, name, root)
		);
	}

	return members;
}

async function prepareRemotePublicationMember(
	directory: string,
	system: string,
	name: string,
	root: string
): Promise<RemoteCohortMember> {
	const member = await prepareRemotePreparedMember(
		directory,
		system,
		name,
		root
	);
	const [output] = member.outputs;

	if (output === undefined || member.outputs.length !== 1) {
		throw new Error(
			`${member.attribute} declared ${String(member.outputs.length)} outputs; expected exactly one`
		);
	}

	return { ...member, output };
}

async function prepareRemotePreparedMember(
	directory: string,
	system: string,
	name: string,
	root: string
): Promise<RemotePreparedMember> {
	const attribute = `packages.${system}.${name}`;
	const installable = `path:${directory}#${attribute}`;
	const evaluated = await runFixtureNixDerivationShow(
		[installable],
		undefined,
		false
	);
	const derivations = evaluated.map((reported) => absoluteStorePath(reported));
	const [derivation] = derivations;

	if (derivation === undefined || derivations.length !== 1) {
		throw new Error(
			`${attribute} evaluated to ${String(derivations.length)} derivations`
		);
	}

	const queried = await runCommand('nix-store', [
		'--query',
		'--outputs',
		derivation
	]);
	const outputs = queried.stdout
		.trim()
		.split(/\s+/u)
		.filter((reported) => reported !== '')
		.map((reported) => storePathSchema.parse(reported))
		.toSorted(byCodeUnit);

	if (outputs.length === 0) {
		throw new Error(`${attribute} declared no outputs`);
	}

	return {
		attribute,
		derivation,
		installable,
		outputs,
		root,
		target: `${derivation}^*` as NixDerivedPathString
	};
}

// Miniflare cannot serve Cloudflare's temporary S3 endpoint, so the test
// server's PushClient stages streamed bytes into its bound R2 bucket directly.
// Keep the action's argv boundary, but route its push commands through the same
// production push flow with that client. Selected cases run the real CLI planner
// against the SSH store; the remaining publication cases use settled planner
// answers so they can concentrate on their distinct publication outcome.
function publicationCupboard(
	plan: RemotePublicationPlan,
	realPlanning?: RealPlanningHarness
): typeof runCupboard {
	return async (_binaryPath, arguments_) => {
		if (arguments_[1] === 'plan' && arguments_[2] === 'cohort') {
			if (realPlanning !== undefined) {
				return runRealPlanningCommand(plan, realPlanning, 'cohort', arguments_);
			}

			return publicationPlanResults(plan.members);
		}

		if (arguments_[1] === 'plan' && arguments_[2] === 'reprobe') {
			if (realPlanning !== undefined) {
				return runRealPlanningCommand(
					plan,
					realPlanning,
					'reprobe',
					arguments_
				);
			}

			return publicationReprobeResults(plan.members);
		}

		if (arguments_[1] !== 'push') {
			throw new Error(
				`Unexpected in-process cupboard command: ${arguments_.join(' ')}`
			);
		}

		await runPublicationPush(plan, arguments_);

		return [];
	};
}

async function runRealPlanningCommand(
	plan: RemotePublicationPlan,
	harness: RealPlanningHarness,
	command: 'cohort' | 'reprobe',
	arguments_: readonly string[]
): Promise<readonly ReporterResultEvent[]> {
	await mkdir(harness.directory, { recursive: true });
	const resultFile = path.join(harness.directory, `${command}-results.jsonl`);
	const cliArguments = arguments_.filter(
		(argument) => argument !== '--github-oidc'
	);
	const results = await withEnvironmentValue(
		'XDG_CONFIG_HOME',
		path.join(harness.directory, 'config'),
		async () => {
			await writeCachedSession(
				{ accessToken: plan.token },
				plan.server.tenantUrl
			);
			await buildCliProgram().parseAsync(
				['--output-mode', 'json', '--result-file', resultFile, ...cliArguments],
				{ from: 'user' }
			);

			return parseReporterResults(await readFile(resultFile, 'utf8'));
		}
	);

	harness.runs.push({
		command,
		store: optionValue(arguments_, '--store'),
		results
	});

	return results;
}

function publicationReprobeResults(
	members: readonly Pick<RemotePreparedMember, 'target'>[]
): readonly ReporterResultEvent[] {
	return [
		{
			kind: 'plan-reprobe',
			data: {
				buildSet: members.map((member) => member.target),
				withdrawn: []
			}
		}
	];
}

function publicationPlanResults(
	members: readonly Pick<RemotePreparedMember, 'target'>[]
): readonly ReporterResultEvent[] {
	return [
		{
			kind: 'plan-cohort',
			data: {
				partition: {
					attachOnly: [],
					publishByReference: [],
					leftUpstream: [],
					leftUpstreamRejections: [],
					alreadyValid: [],
					buildSet: members.map((member) => member.target),
					counts: {
						willBuild: 0,
						willSubstitute: 0,
						unknown: members.length
					},
					downloadSize: 0,
					narSize: 0,
					unknownCount: members.length,
					unreachableSubstituters: [],
					ceiling: {
						value: 5,
						source: 'untrusted-fallback',
						fallbackReason:
							'the transport preserves the remote daemon options, so it does not send the narinfo-cache-negative-ttl override'
					}
				},
				capacity: { skipped: 'remote-store' }
			}
		}
	];
}

async function runPublicationPush(
	plan: RemotePublicationPlan,
	arguments_: readonly string[]
): Promise<void> {
	const targets = storePathSchema.array().parse(pushTargets(arguments_));
	const storeUri = requiredOption(arguments_, '--store');
	const receiptFile = optionValue(arguments_, '--receipt-file');
	const root = optionValue(arguments_, '--root');
	const publication = PublicationCollection.of({ targets });
	const openedNix = Nix.openForAvailability(undefined, {
		storeUri,
		overrides: { substituters: '' }
	});
	const nix =
		plan.uploadBarrier === undefined
			? openedNix
			: withNarUploadBarrier(openedNix, plan.uploadBarrier);
	const receipt = await runPush(publication, silentReporter(), {
		client: plan.server.pushClient(plan.token),
		nix,
		attest: false,
		...(arguments_.includes('--no-retain') && { retain: false }),
		...(root !== undefined && { root: rootNameSchema.parse(root) }),
		...(receiptFile !== undefined && {
			buildStore: storeUri,
			alreadyHeld: optionValues(arguments_, '--already-held'),
			claimable: optionValues(arguments_, '--claimable')
		})
	});

	if (receiptFile !== undefined) {
		await writeFile(
			receiptFile,
			`${JSON.stringify(receipt, undefined, '\t')}\n`
		);
	}
}

function withNarUploadBarrier(nix: Nix, barrier: AsyncBarrier): Nix {
	return new Proxy(nix, {
		get(target, property) {
			if (property === 'narFromPath') {
				return (storePath: string) =>
					pauseNarStream(target.narFromPath(storePath), barrier);
			}

			const value = Reflect.get(target, property, target) as unknown;

			if (typeof value !== 'function') {
				return value;
			}

			const method = value as (...arguments_: readonly unknown[]) => unknown;

			return method.bind(target);
		}
	});
}

async function* pauseNarStream(
	source: AsyncIterable<Uint8Array>,
	barrier: AsyncBarrier
): AsyncIterable<Uint8Array> {
	let isFirst = true;

	for await (const chunk of source) {
		if (isFirst) {
			isFirst = false;
			await barrier.pause();
		}

		yield chunk;
	}
}

function optionValue(
	arguments_: readonly string[],
	name: string
): string | undefined {
	const index = arguments_.indexOf(name);

	return index === -1 ? undefined : arguments_[index + 1];
}

function requiredOption(arguments_: readonly string[], name: string): string {
	const value = optionValue(arguments_, name);

	if (value === undefined) {
		throw new Error(`The in-process push did not receive ${name}`);
	}

	return value;
}

function optionValues(arguments_: readonly string[], name: string): string[] {
	const values: string[] = [];

	for (const [index, argument] of arguments_.entries()) {
		const value = arguments_[index + 1];

		if (argument === name && value !== undefined) {
			values.push(value);
		}
	}

	return values;
}

function pushTargets(arguments_: readonly string[]): readonly string[] {
	const values = arguments_.slice(3);
	const firstOption = values.findIndex((argument) => argument.startsWith('--'));

	return firstOption === -1 ? values : values.slice(0, firstOption);
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

async function withEnvironmentValue<T>(
	name: string,
	value: string,
	run: () => Promise<T>
): Promise<T> {
	const previous = process.env[name];
	process.env[name] = value;

	try {
		return await run();
	} finally {
		if (previous === undefined) {
			Reflect.deleteProperty(process.env, name);
		} else {
			process.env[name] = previous;
		}
	}
}

async function withSshOptions<T>(
	value: string | undefined,
	run: () => Promise<T>
): Promise<T> {
	const previous = process.env.NIX_SSHOPTS;

	if (value === undefined) {
		delete process.env.NIX_SSHOPTS;
	} else {
		process.env.NIX_SSHOPTS = value;
	}

	try {
		return await run();
	} finally {
		if (previous === undefined) {
			delete process.env.NIX_SSHOPTS;
		} else {
			process.env.NIX_SSHOPTS = previous;
		}
	}
}

async function expectLocalStoreAbsence(
	storePaths: readonly StorePathString[]
): Promise<void> {
	const validity = await Promise.all(
		storePaths.map(async (storePath) => {
			try {
				await runCommand('nix-store', ['--check-validity', storePath]);

				return { storePath, valid: true };
			} catch (error) {
				if (!(error instanceof CommandFailedError)) {
					throw error;
				}

				return { storePath, valid: false, exitCode: error.code };
			}
		})
	);

	expect(validity).toStrictEqual(
		storePaths.map((storePath) => ({
			storePath,
			valid: false,
			exitCode: 1
		}))
	);
}

function absoluteStorePath(reported: string): StorePathString {
	return storePathSchema.parse(
		reported.startsWith('/nix/store/') ? reported : `/nix/store/${reported}`
	);
}

function remoteBuildFlake(system: string): string {
	return `{
		outputs = { self }: {
			packages."${system}".default = derivation {
				name = "cupboard-remote-store-e2e";
				system = "${system}";
				builder = "/bin/sh";
				args = [ "-c" "printf %s cupboard-remote-store > \\"$out\\"" ];
			};
		};
	}\n`;
}

function remotePublicationFlake(system: string): string {
	return `{
		outputs = { self }: {
			packages."${system}" = {
				success = derivation {
					name = "cupboard-remote-publication-success";
					system = "${system}";
					builder = "/bin/sh";
					args = [ "-c" "printf %s published-remotely > \\"$out\\"" ];
				};
				failure = derivation {
					name = "cupboard-remote-publication-failure";
					system = "${system}";
					builder = "/bin/sh";
					args = [ "-c" "exit 1" ];
				};
			};
		};
	}\n`;
}

function alreadyValidPublicationFlake(system: string): string {
	return `{
		outputs = { self }: {
			packages."${system}".already = derivation {
				name = "cupboard-remote-publication-already-valid";
				system = "${system}";
				builder = "/bin/sh";
				args = [ "-c" "printf %s already-valid-remotely > \\"$out\\"" ];
			};
		};
	}\n`;
}

function allSuccessPublicationFlake(system: string): string {
	return `{
		outputs = { self }: {
			packages."${system}" = {
				single = derivation {
					name = "cupboard-remote-publication-single";
					system = "${system}";
					builder = "/bin/sh";
					args = [ "-c" "printf %s single-output > \\"$out\\"" ];
				};
				multiple = derivation {
					name = "cupboard-remote-publication-multiple";
					system = "${system}";
					outputs = [ "out" "dev" ];
					builder = "/bin/sh";
					args = [ "-c" "printf %s primary-output > \\"$out\\"; printf %s development-output > \\"$dev\\"" ];
				};
			};
		};
	}\n`;
}
