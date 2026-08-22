import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	storeDirectorySchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import type { PublishTarget } from '../../actions/src/publish-plan.ts';
import type {
	DaemonCommandRunner,
	NixDerivedPathString
} from '../../packages/nix/src/index.ts';
import { FakeDaemonChild } from '../../tests/support/fake-daemon-child.ts';
import { FakeDaemonTransport } from '../../tests/support/fake-daemon-transport.ts';

import {
	type CommandRunner,
	createDivertedStoreDirectory,
	createDivertedStorePlanner,
	daemonArguments,
	derivationArguments,
	DerivationNotResolvedError,
	divertedStoreUri,
	NixCommandError,
	parseDerivationPath,
	removeDivertedStore,
	seedArguments
} from './diverted-store.ts';
import type { RealisationPlanner } from './measurement.ts';

const storeDirectory = storeDirectorySchema.parse('/nix/store');
const appDrv = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv'
);
const appOut = storePathSchema.parse(
	'/nix/store/1123456789abcdfghijklmnpqrsvwxyz-app'
);
const substituters = ['https://cache.nixos.org'];
const features = ['--extra-experimental-features', 'nix-command flakes'];
const testDirectoryPrefix = path.join(tmpdir(), 'cupboard-realisation-test-');

const app: PublishTarget = {
	attr: 'app',
	system: 'x86_64-linux',
	os: 'ubuntu-latest',
	remote: false,
	bestEffort: false,
	rootSuffix: 'app',
	outputs: ['out']
};

interface RecordedCommand {
	readonly command: string;
	readonly commandArguments: readonly string[];
}

describe('divertedStoreUri', () => {
	it('keeps the logical store directory and moves only the contents', () => {
		expect(
			divertedStoreUri({ storeDirectory, directory: '/work/measure' })
		).toBe(
			'local?store=%2Fnix%2Fstore&real=%2Fwork%2Fmeasure%2Fstore&state=%2Fwork%2Fmeasure%2Fstate'
		);
	});
});

describe('nix command arguments', () => {
	it('resolves a derivation with the substituter list replaced', () => {
		expect(
			derivationArguments({ flake: 'nixpkgs', attr: 'app', substituters })
		).toStrictEqual([
			'path-info',
			...features,
			'--substituters',
			'https://cache.nixos.org',
			'--derivation',
			'nixpkgs#app'
		]);
	});

	it('seeds the diverted store from the local one', () => {
		expect(
			seedArguments({
				storeUri: 'local?store=/nix/store',
				drvPaths: [appDrv],
				substituters
			})
		).toStrictEqual([
			'copy',
			...features,
			'--substituters',
			'https://cache.nixos.org',
			'--derivation',
			'--no-check-sigs',
			'--to',
			'local?store=/nix/store',
			appDrv
		]);
	});

	it('serves the diverted store over stdio with the substituter list replaced', () => {
		expect(
			daemonArguments({
				storeUri: 'local?store=/nix/store',
				substituters: ['https://cache.nixos.org', 'https://example.test']
			})
		).toStrictEqual([
			'daemon',
			...features,
			'--stdio',
			'--store',
			'local?store=/nix/store',
			'--substituters',
			'https://cache.nixos.org https://example.test'
		]);
	});
});

describe('parseDerivationPath', () => {
	it('returns the first derivation path in Nix output', () => {
		expect(parseDerivationPath('app', `${appDrv}\n`)).toBe(appDrv);
	});

	it.each([
		{ name: 'nothing at all', stdout: '' },
		{ name: 'an output path', stdout: `${appOut}\n` },
		{ name: 'a line that is not a store path', stdout: 'error: no such attr\n' }
	])('rejects $name', ({ stdout }) => {
		expect(() => parseDerivationPath('app', stdout)).toThrow(
			DerivationNotResolvedError
		);
	});
});

const workDirectory = '/work/measure';
const plannerStoreUri = divertedStoreUri({
	storeDirectory,
	directory: workDirectory
});

const idleDaemon: DaemonCommandRunner = () =>
	new FakeDaemonChild(new FakeDaemonTransport({}));

function plannerWith(
	run: CommandRunner,
	spawnDaemon: DaemonCommandRunner = idleDaemon
): RealisationPlanner {
	return createDivertedStorePlanner({
		flake: 'nixpkgs',
		storeDirectory,
		directory: workDirectory,
		substituters,
		run,
		spawnDaemon,
		now: () => 0
	});
}

describe('createDivertedStorePlanner', () => {
	it('evaluates a target that declares no derivation', async () => {
		const commands: RecordedCommand[] = [];
		const planner = plannerWith((command, commandArguments) => {
			commands.push({ command, commandArguments });

			return Promise.resolve({ stdout: `${appDrv}\n`, stderr: '' });
		});

		await expect(planner.resolve(app)).resolves.toStrictEqual({
			drvPath: appDrv,
			evaluationTimeMs: 0
		});
		expect(commands).toStrictEqual([
			{
				command: 'nix',
				commandArguments: derivationArguments({
					flake: 'nixpkgs',
					attr: 'app',
					substituters
				})
			}
		]);
	});

	it('takes a manifest-declared derivation without running nix', async () => {
		const commands: RecordedCommand[] = [];
		const planner = plannerWith((command, commandArguments) => {
			commands.push({ command, commandArguments });

			return Promise.resolve({ stdout: '', stderr: '' });
		});

		await expect(
			planner.resolve({ ...app, rootDrvPath: appDrv })
		).resolves.toStrictEqual({ drvPath: appDrv, evaluationTimeMs: 0 });
		expect(commands).toStrictEqual([]);
	});

	it('copies the seeded derivations into the diverted store', async () => {
		const commands: RecordedCommand[] = [];
		const planner = plannerWith((command, commandArguments) => {
			commands.push({ command, commandArguments });

			return Promise.resolve({ stdout: '', stderr: '' });
		});

		await planner.seed([appDrv]);

		expect(commands).toStrictEqual([
			{
				command: 'nix',
				commandArguments: seedArguments({
					storeUri: plannerStoreUri,
					drvPaths: [appDrv],
					substituters
				})
			}
		]);
	});

	it('runs no command when there is nothing to seed', async () => {
		const commands: RecordedCommand[] = [];
		const planner = plannerWith((command, commandArguments) => {
			commands.push({ command, commandArguments });

			return Promise.resolve({ stdout: '', stderr: '' });
		});

		await planner.seed([]);

		expect(commands).toStrictEqual([]);
	});

	it('wraps a failed Nix command in NixCommandError', async () => {
		const planner = plannerWith(() =>
			Promise.reject(new Error('nix exited with 1'))
		);

		await expect(planner.resolve(app)).rejects.toBeInstanceOf(NixCommandError);
	});

	it('queries the spawned daemon through the store protocol', async () => {
		const target: NixDerivedPathString = `${appDrv}^out`;
		const commands: RecordedCommand[] = [];
		const planner = plannerWith(
			() => Promise.resolve({ stdout: '', stderr: '' }),
			(command, commandArguments) => {
				commands.push({ command, commandArguments });

				return new FakeDaemonChild(
					new FakeDaemonTransport(
						{},
						{
							missing: {
								// The worker protocol spells a derived path with `!`
								// where an installable spells it with `^`.
								expectedTargets: [`${appDrv}!out`],
								willBuild: [appDrv],
								willSubstitute: [appOut],
								unknown: [],
								downloadSize: 1_323_558,
								narSize: 45_943_896
							}
						}
					)
				);
			}
		);

		await expect(planner.plan([target])).resolves.toStrictEqual({
			willBuild: [appDrv],
			willSubstitute: [appOut],
			unknown: [],
			downloadSize: 1_323_558,
			narSize: 45_943_896
		});
		expect(commands).toStrictEqual([
			{
				command: 'nix',
				commandArguments: daemonArguments({
					storeUri: plannerStoreUri,
					substituters
				})
			}
		]);
	});
});

describe('createDivertedStoreDirectory', () => {
	it('creates and owns a fresh default directory', async () => {
		const owned = await createDivertedStoreDirectory();

		expect({
			directory: owned.directory,
			workDirectory: owned.workDirectory,
			workDirectoryEntries: await readdir(owned.workDirectory)
		}).toStrictEqual({
			directory: await realpath(owned.directory),
			workDirectory: owned.workDirectory,
			workDirectoryEntries: [path.basename(owned.directory)]
		});
		await removeDivertedStore(owned);
	});

	it('creates an owned child in a new explicit work directory', async () => {
		const parent = await mkdtemp(testDirectoryPrefix);
		const requested = path.join(parent, 'store');
		const owned = await createDivertedStoreDirectory(requested);

		expect({
			directoryParent: path.dirname(owned.directory),
			directoryNameIsPrivate: path
				.basename(owned.directory)
				.startsWith('.cupboard-store-'),
			workDirectory: owned.workDirectory,
			workDirectoryEntries: await readdir(requested)
		}).toStrictEqual({
			directoryParent: await realpath(requested),
			directoryNameIsPrivate: true,
			workDirectory: requested,
			workDirectoryEntries: [path.basename(owned.directory)]
		});

		await removeDivertedStore(owned);
		await removeDivertedStoreDirectoryForTest(parent);
	});

	it('refuses an existing directory without changing its contents', async () => {
		const directory = await mkdtemp(testDirectoryPrefix);
		const existing = path.join(directory, 'existing');

		await writeFile(existing, 'keep me');

		await expect(createDivertedStoreDirectory(directory)).rejects.toMatchObject(
			{
				code: 'EEXIST'
			}
		);
		await expect(readFile(existing, 'utf8')).resolves.toBe('keep me');

		await removeDivertedStoreDirectoryForTest(directory);
	});

	it('refuses a symlink without changing its target', async () => {
		const parent = await mkdtemp(testDirectoryPrefix);
		const target = path.join(parent, 'target');
		const linked = path.join(parent, 'link');
		const existing = path.join(target, 'existing');

		await mkdir(target);
		await writeFile(existing, 'keep me');
		await symlink(target, linked);

		await expect(createDivertedStoreDirectory(linked)).rejects.toMatchObject({
			code: 'EEXIST'
		});
		await expect(readFile(existing, 'utf8')).resolves.toBe('keep me');

		await removeDivertedStoreDirectoryForTest(parent);
	});

	it('removes a newly created directory when initialisation fails', async () => {
		const parent = await mkdtemp(testDirectoryPrefix);
		const requested = path.join(parent, 'store');
		const failure = new Error('initialisation failed');

		await expect(
			createDivertedStoreDirectory(requested, () => Promise.reject(failure))
		).rejects.toBe(failure);
		await expect(readdir(parent)).resolves.toStrictEqual([]);

		await removeDivertedStoreDirectoryForTest(parent);
	});

	it('preserves the initialisation error when failed cleanup is unsafe', async () => {
		const parent = await mkdtemp(testDirectoryPrefix);
		const requested = path.join(parent, 'store');
		const failure = new Error('initialisation failed');
		let initialisedDirectory: string | undefined;

		await expect(
			createDivertedStoreDirectory(requested, async (owned) => {
				initialisedDirectory = owned.directory;
				await writeFile(
					path.join(owned.directory, '.cupboard-diverted-store'),
					'replaced-token'
				);
				await writeFile(path.join(owned.directory, 'foreign'), 'keep me');

				throw failure;
			})
		).rejects.toBe(failure);

		if (initialisedDirectory === undefined) {
			throw new Error('The test initialiser did not run');
		}

		const [holdingDirectory] = await readdir(requested);

		if (holdingDirectory === undefined) {
			throw new Error('Cleanup did not preserve the claimed directory');
		}

		await expect(
			readFile(
				path.join(requested, holdingDirectory, 'store', 'foreign'),
				'utf8'
			)
		).resolves.toBe('keep me');

		await removeDivertedStoreDirectoryForTest(parent);
	});

	it('refuses a directory replaced before its path is resolved', async () => {
		const parent = await mkdtemp(testDirectoryPrefix);
		const requested = path.join(parent, 'store');
		const displaced = path.join(parent, 'displaced');
		const replacement = path.join(parent, 'replacement');
		const existing = path.join(replacement, 'existing');
		let isSwapped = false;

		await mkdir(replacement);
		await writeFile(existing, 'keep me');

		try {
			let outcome: unknown;

			try {
				outcome = await createDivertedStoreDirectory(
					requested,
					() => Promise.resolve(),
					async (created) => {
						isSwapped = true;
						await rename(created, displaced);
						await symlink(replacement, created);

						return realpath(created);
					}
				);
			} catch (error) {
				outcome = error;
			}

			expect({
				outcome,
				replacementContents: await readFile(existing, 'utf8'),
				isSwapped
			}).toMatchObject({
				outcome: new Error('Refusing a replaced diverted-store directory'),
				replacementContents: 'keep me',
				isSwapped: true
			});
		} finally {
			await removeDivertedStoreDirectoryForTest(parent);
		}
	});

	it('keeps its marker in a private child when the work directory is replaced', async () => {
		const parent = await mkdtemp(testDirectoryPrefix);
		const requested = path.join(parent, 'store');
		const displaced = path.join(parent, 'displaced');
		const replacement = path.join(parent, 'replacement');
		const existing = path.join(replacement, 'existing');

		await mkdir(replacement);
		await writeFile(existing, 'keep me');

		try {
			const owned = await createDivertedStoreDirectory(
				requested,
				undefined,
				realpath,
				undefined,
				async (workDirectory) => {
					await rename(workDirectory, displaced);
					await symlink(replacement, workDirectory);
				}
			);

			expect({
				existing: await readFile(existing, 'utf8'),
				replacementEntries: await readSortedDirectory(replacement),
				privateDirectoryIsPrivate: path
					.basename(owned.directory)
					.startsWith('.cupboard-store-'),
				marker: await readFile(
					path.join(owned.directory, '.cupboard-diverted-store'),
					'utf8'
				)
			}).toStrictEqual({
				existing: 'keep me',
				replacementEntries: [path.basename(owned.directory), 'existing'],
				privateDirectoryIsPrivate: true,
				marker: owned.ownershipToken
			});

			await expect(removeDivertedStore(owned)).rejects.toMatchObject({
				code: 'ENOTDIR'
			});
			expect({
				existing: await readFile(existing, 'utf8'),
				replacementEntries: await readdir(replacement),
				requestedTarget: await realpath(requested),
				displacedEntries: await readdir(displaced)
			}).toStrictEqual({
				existing: 'keep me',
				replacementEntries: ['existing'],
				requestedTarget: await realpath(replacement),
				displacedEntries: []
			});
		} finally {
			await removeDivertedStoreDirectoryForTest(parent);
		}
	});
});

describe('removeDivertedStore', () => {
	it('removes a store whose entries nix left read-only', async () => {
		const parent = await mkdtemp(testDirectoryPrefix);
		const owned = await createDivertedStoreDirectory(
			path.join(parent, 'store-root')
		);
		const storePath = path.join(owned.directory, 'store', 'app');

		await mkdir(storePath);
		await writeFile(path.join(storePath, 'binary'), 'contents');
		await chmod(path.join(storePath, 'binary'), 0o444);
		await chmod(storePath, 0o555);
		await chmod(path.join(owned.directory, 'store'), 0o555);

		await removeDivertedStore(owned);

		await expect(readdir(parent)).resolves.toStrictEqual([]);
		await removeDivertedStoreDirectoryForTest(parent);
	});

	it('does not recursively remove another entry in the work directory', async () => {
		const parent = await mkdtemp(testDirectoryPrefix);
		const requested = path.join(parent, 'store-root');
		const existing = path.join(requested, 'existing');
		const owned = await createDivertedStoreDirectory(requested);

		await writeFile(existing, 'keep me');

		await expect(removeDivertedStore(owned)).rejects.toMatchObject({
			code: 'ENOTEMPTY'
		});
		expect({
			existing: await readFile(existing, 'utf8'),
			workDirectoryEntries: await readdir(requested)
		}).toStrictEqual({
			existing: 'keep me',
			workDirectoryEntries: ['existing']
		});

		await removeDivertedStoreDirectoryForTest(parent);
	});

	it('refuses a directory whose ownership token does not match', async () => {
		const parent = await mkdtemp(testDirectoryPrefix);
		const owned = await createDivertedStoreDirectory(
			path.join(parent, 'store-root')
		);
		const existing = path.join(owned.directory, 'existing');

		await writeFile(existing, 'keep me');
		let outcome: unknown;

		try {
			await removeDivertedStore({
				...owned,
				ownershipToken: 'not-the-token'
			});
		} catch (error) {
			outcome = error;
		}

		if (!(outcome instanceof Error)) {
			throw outcome;
		}

		const recoveryPath = recoveryPathFrom(outcome);

		expect({
			message: outcome.message,
			cause:
				outcome.cause instanceof Error ? outcome.cause.message : outcome.cause,
			existing: await readFile(path.join(recoveryPath, 'existing'), 'utf8')
		}).toStrictEqual({
			message:
				`Refusing to remove unowned directory: ${owned.directory}. ` +
				`The claimed entry remains at ${recoveryPath}; inspect it before moving or removing it.`,
			cause: `Refusing to remove unowned directory: ${owned.directory}`,
			existing: 'keep me'
		});

		await removeDivertedStoreDirectoryForTest(parent);
	});

	it('does not change a replacement claimed in place of the private child', async () => {
		const parent = await mkdtemp(testDirectoryPrefix);
		const requested = path.join(parent, 'store-root');
		const displaced = path.join(parent, 'displaced');
		const replacement = path.join(parent, 'replacement');
		const existing = path.join(replacement, 'existing');
		const owned = await createDivertedStoreDirectory(requested);

		await mkdir(replacement);
		await writeFile(existing, 'keep me');
		await chmod(existing, 0o400);
		await chmod(replacement, 0o500);

		try {
			let outcome: unknown;

			try {
				await removeDivertedStore(owned, async (directory) => {
					await rename(directory, displaced);
					await symlink(replacement, directory);
				});
			} catch (error) {
				outcome = error;
			}

			if (!(outcome instanceof Error)) {
				throw outcome;
			}

			const recoveryPath = recoveryPathFrom(outcome);

			const [replacementStat, existingStat] = await Promise.all([
				stat(replacement),
				stat(existing)
			]);

			expect({
				existing: await readFile(existing, 'utf8'),
				replacementMode: replacementStat.mode & 0o777,
				existingMode: existingStat.mode & 0o777,
				privateTarget: await realpath(recoveryPath),
				parentEntries: await readSortedDirectory(parent)
			}).toStrictEqual({
				existing: 'keep me',
				replacementMode: 0o500,
				existingMode: 0o400,
				privateTarget: await realpath(replacement),
				parentEntries: ['displaced', 'replacement', 'store-root']
			});
		} finally {
			await chmod(replacement, 0o700);
			await chmod(existing, 0o600);
			await removeDivertedStoreDirectoryForTest(parent);
		}
	});

	it('removes entries added to its private child after cleanup verification', async () => {
		const parent = await mkdtemp(testDirectoryPrefix);
		const requested = path.join(parent, 'store-root');
		const owned = await createDivertedStoreDirectory(requested);
		let didHookRun = false;

		await removeDivertedStore(owned, undefined, undefined, async (claimed) => {
			didHookRun = true;
			await writeFile(path.join(claimed, 'late-entry'), 'owned');
		});

		expect({
			didHookRun,
			parentEntries: await readdir(parent)
		}).toStrictEqual({
			didHookRun: true,
			parentEntries: []
		});
		await removeDivertedStoreDirectoryForTest(parent);
	});

	it('preserves a cleanup error when the holding directory is not empty', async () => {
		const parent = await mkdtemp(testDirectoryPrefix);
		const requested = path.join(parent, 'store-root');
		const owned = await createDivertedStoreDirectory(requested);
		const failure = new Error('cleanup failed');
		let outcome: unknown;

		try {
			await removeDivertedStore(owned, undefined, undefined, () =>
				Promise.reject(failure)
			);
		} catch (error) {
			outcome = error;
		}

		if (!(outcome instanceof Error)) {
			throw outcome;
		}

		const recoveryPath = recoveryPathFrom(outcome);

		expect({
			message: outcome.message,
			cause: outcome.cause,
			recoveryPathExists: await isPathPresent(recoveryPath)
		}).toStrictEqual({
			message:
				`cleanup failed. The claimed entry remains at ${recoveryPath}; ` +
				`inspect it before moving or removing it.`,
			cause: failure,
			recoveryPathExists: true
		});

		await removeDivertedStoreDirectoryForTest(parent);
	});

	it('leaves a mismatched claim at its recovery path', async () => {
		const parent = await mkdtemp(testDirectoryPrefix);
		const requested = path.join(parent, 'store-root');
		const displaced = path.join(parent, 'displaced');
		const replacement = path.join(parent, 'replacement');
		const existing = path.join(replacement, 'existing');
		const owned = await createDivertedStoreDirectory(requested);

		await mkdir(replacement);
		await writeFile(existing, 'keep me');

		try {
			let outcome: unknown;

			try {
				await removeDivertedStore(owned, async (directory) => {
					await rename(directory, displaced);
					await rename(replacement, directory);
				});
			} catch (error) {
				outcome = error;
			}

			if (!(outcome instanceof Error)) {
				throw outcome;
			}

			const recoveryPath = recoveryPathFrom(outcome);

			expect({
				originalPathExists: await isPathPresent(owned.directory),
				recoveryContents: await readFile(
					path.join(recoveryPath, 'existing'),
					'utf8'
				)
			}).toStrictEqual({
				originalPathExists: false,
				recoveryContents: 'keep me'
			});
		} finally {
			await removeDivertedStoreDirectoryForTest(parent);
		}
	});

	it('preserves a mismatched claim when the original path is reused', async () => {
		const parent = await mkdtemp(testDirectoryPrefix);
		const requested = path.join(parent, 'store-root');
		const displaced = path.join(parent, 'displaced');
		const replacement = path.join(parent, 'replacement');
		const existing = path.join(replacement, 'existing');
		const occupied = 'the pathname was reused';
		const owned = await createDivertedStoreDirectory(requested);

		await mkdir(replacement);
		await writeFile(existing, 'keep me');

		try {
			let outcome: unknown;

			try {
				await removeDivertedStore(
					owned,
					async (directory) => {
						await rename(directory, displaced);
						await rename(replacement, directory);
					},
					(directory) => writeFile(directory, occupied)
				);
			} catch (error) {
				outcome = error;
			}

			if (!(outcome instanceof Error)) {
				throw outcome;
			}

			const message = outcome.message;
			const recoveryPath = recoveryPathFrom(outcome);

			expect({
				message,
				occupied: await readFile(owned.directory, 'utf8'),
				recoveryContents: await readFile(
					path.join(recoveryPath, 'existing'),
					'utf8'
				)
			}).toStrictEqual({
				message:
					`Refusing a replaced diverted-store directory. The claimed entry remains ` +
					`at ${recoveryPath}; inspect it before moving or removing it.`,
				occupied,
				recoveryContents: 'keep me'
			});
		} finally {
			await removeDivertedStoreDirectoryForTest(parent);
		}
	});
});

async function removeDivertedStoreDirectoryForTest(
	directory: string
): Promise<void> {
	await rm(directory, { recursive: true, force: true });
}

async function readSortedDirectory(directory: string): Promise<string[]> {
	const entries = await readdir(directory);

	return entries.toSorted((left, right) => left.localeCompare(right));
}

async function isPathPresent(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return false;
		}

		throw error;
	}
}

function recoveryPathFrom(error: Error): string {
	const recoveryPath = /remains at (.+); inspect/.exec(error.message)?.[1];

	if (recoveryPath === undefined) {
		throw new Error(`Missing the recovery path in: ${error.message}`);
	}

	return recoveryPath;
}
