import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	realpath,
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
	it('takes the first derivation nix printed', () => {
		expect(parseDerivationPath('app', `${appDrv}\n`)).toBe(appDrv);
	});

	it.each([
		{ name: 'nothing at all', stdout: '' },
		{ name: 'an output path', stdout: `${appOut}\n` },
		{ name: 'a line that is not a store path', stdout: 'error: no such attr\n' }
	])('refuses $name', ({ stdout }) => {
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

	it('carries a failed nix command as a typed error', async () => {
		const planner = plannerWith(() =>
			Promise.reject(new Error('nix exited with 1'))
		);

		await expect(planner.resolve(app)).rejects.toBeInstanceOf(NixCommandError);
	});

	it('plans over the store protocol against the daemon it started', async () => {
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
	it('answers with a path no symlink stands in', async () => {
		const parent = await mkdtemp(testDirectoryPrefix);
		const linked = path.join(parent, 'link');

		await mkdir(path.join(parent, 'real'));
		await symlink(path.join(parent, 'real'), linked);

		const directory = await createDivertedStoreDirectory(linked);

		expect(directory).toBe(await realpath(path.join(parent, 'real')));

		await removeDivertedStore(parent);
	});
});

describe('removeDivertedStore', () => {
	it('removes a store whose entries nix left read-only', async () => {
		const directory = await createDivertedStoreDirectory(
			await mkdtemp(testDirectoryPrefix)
		);
		const storePath = path.join(directory, 'store', 'app');

		await mkdir(storePath);
		await writeFile(path.join(storePath, 'binary'), 'contents');
		await chmod(path.join(storePath, 'binary'), 0o444);
		await chmod(storePath, 0o555);
		await chmod(path.join(directory, 'store'), 0o555);

		await removeDivertedStore(directory);

		await expect(readdir(tmpdir())).resolves.not.toContain(
			path.basename(directory)
		);
	});
});
