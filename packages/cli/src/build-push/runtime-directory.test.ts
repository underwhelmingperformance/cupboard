import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process, { platform } from 'node:process';

import { invocationIdSchema } from '@cupboard/protocol/build';
import { afterEach, describe, expect, it } from 'vitest';

import { SocketPathTooLongError } from '../errors.ts';

import {
	createInvocationRuntimeDirectory,
	createRootLinkDirectory,
	darwinSunPathBytes,
	linuxSunPathBytes,
	planInvocationRuntime,
	removeInvocationRuntimeDirectory,
	socketFileName
} from './runtime-directory.ts';

const invocationId = invocationIdSchema.parse('invocation-1');

// `/cupboard/invocation-1/hook.sock` beneath the base: 10 + 12 + 10 bytes.
const suffixBytes = 32;

function planFor(base: string) {
	const directory = path.join(base, 'cupboard', invocationId);

	return { directory, socketPath: path.join(directory, socketFileName) };
}

describe('planInvocationRuntime', () => {
	it.each([
		{
			name: 'the XDG runtime directory when set',
			environment: {
				XDG_RUNTIME_DIR: '/run/user/1000',
				RUNNER_TEMP: '/runner/tmp'
			},
			expectedBase: '/run/user/1000'
		},
		{
			name: 'RUNNER_TEMP when no XDG runtime directory is set',
			environment: { RUNNER_TEMP: '/runner/tmp' },
			expectedBase: '/runner/tmp'
		},
		{
			name: 'the temporary directory when neither variable is set',
			environment: {},
			expectedBase: '/tmp'
		},
		{
			name: 'the temporary directory when the set variables are empty',
			environment: { XDG_RUNTIME_DIR: '', RUNNER_TEMP: '' },
			expectedBase: '/tmp'
		},
		{
			name: 'the temporary directory when RUNNER_TEMP overruns sun_path',
			environment: { RUNNER_TEMP: `/${'r'.repeat(200)}` },
			expectedBase: '/tmp'
		}
	])('places the endpoint beneath $name', ({ environment, expectedBase }) => {
		const plan = planInvocationRuntime({
			invocationId,
			environment,
			platform: 'linux',
			temporaryDirectory: '/tmp'
		});

		expect(plan).toStrictEqual(planFor(expectedBase));
	});

	// A socket path one byte over the Darwin limit still fits the Linux one,
	// so the same environment plans differently by platform.
	const boundaryBase = `/${'r'.repeat(darwinSunPathBytes - suffixBytes - 1)}`;

	it.each([
		{ plannedPlatform: 'linux' as const, expectedBase: boundaryBase },
		{ plannedPlatform: 'darwin' as const, expectedBase: '/tmp' }
	])(
		'holds a $plannedPlatform boundary path against its own limit',
		({ plannedPlatform, expectedBase }) => {
			const plan = planInvocationRuntime({
				invocationId,
				environment: { RUNNER_TEMP: boundaryBase },
				platform: plannedPlatform,
				temporaryDirectory: '/tmp'
			});

			expect(plan).toStrictEqual(planFor(expectedBase));
		}
	);

	it('refuses when no candidate fits, naming the fallback', () => {
		const temporaryDirectory = `/${'t'.repeat(linuxSunPathBytes)}`;
		let caught: unknown;

		try {
			planInvocationRuntime({
				invocationId,
				environment: { RUNNER_TEMP: `/${'r'.repeat(200)}` },
				platform: 'linux',
				temporaryDirectory
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(SocketPathTooLongError);
		expect(
			caught instanceof SocketPathTooLongError
				? { socketPath: caught.socketPath, limitBytes: caught.limitBytes }
				: undefined
		).toStrictEqual({
			socketPath: planFor(temporaryDirectory).socketPath,
			limitBytes: linuxSunPathBytes
		});
	});
});

describe('invocation runtime directory', () => {
	const bases: string[] = [];

	afterEach(async () => {
		const created = [...bases];
		bases.length = 0;

		await Promise.all(
			created.map((base) => rm(base, { recursive: true, force: true }))
		);
	});

	async function createdPlan() {
		// A short prefix keeps the planned socket path inside the Darwin
		// `sun_path` limit under the platform's deeply nested temporary root.
		const base = await mkdtemp(path.join(tmpdir(), 'cup-rt-'));
		bases.push(base);

		return createInvocationRuntimeDirectory({
			invocationId,
			environment: {},
			temporaryDirectory: base
		});
	}

	it.runIf(platform === 'darwin' || platform === 'linux')(
		'creates the invocation directory owner-only',
		async () => {
			const plan = await createdPlan();
			const created = await stat(plan.directory);

			expect(created.mode & 0o777).toBe(0o700);
		}
	);

	it('removes the invocation directory recursively', async () => {
		const plan = await createdPlan();

		await removeInvocationRuntimeDirectory(plan.directory);

		await expect(stat(plan.directory)).rejects.toMatchObject({
			code: 'ENOENT'
		});
	});

	it.runIf(platform === 'darwin' || platform === 'linux')(
		'removes root directories without a live owner',
		async () => {
			const base = await mkdtemp(path.join(tmpdir(), 'cup-roots-'));
			bases.push(base);
			const parent = path.join(base, 'cupboard');
			const active = path.join(parent, 'active-roots');
			const stale = path.join(parent, 'stale-roots');
			const unknown = path.join(parent, 'unknown-roots');
			const orphanOwner = path.join(parent, '.orphan-roots.cupboard-owner');
			const current = path.join(parent, 'current-roots');
			const activeOwner = path.join(base, 'active.sock');
			const currentOwner = path.join(base, 'current.sock');

			await mkdir(unknown, { recursive: true });
			const activeRoots = await createRootLinkDirectory(active, activeOwner);
			await mkdir(stale, { recursive: true });
			const staleSocket = path.join(base, 'stale.sock');
			const staleOwner = spawn(
				process.execPath,
				[
					'-e',
					String.raw`const { createServer } = require('node:net'); const server = createServer(); server.listen(process.argv[1], () => process.stdout.write('ready\n'));`,
					staleSocket
				],
				{ stdio: ['ignore', 'pipe', 'inherit'] }
			);
			await once(staleOwner.stdout, 'data');
			await symlink(path.join(base, 'orphan.sock'), orphanOwner);
			await symlink(
				staleSocket,
				path.join(parent, '.stale-roots.cupboard-owner')
			);
			staleOwner.kill('SIGKILL');
			await once(staleOwner, 'exit');

			const currentRoots = await createRootLinkDirectory(current, currentOwner);

			try {
				const directories = await readdir(parent);
				const currentDirectory = await stat(current);

				expect({
					directories: directories.toSorted((left, right) =>
						left.localeCompare(right)
					),
					mode: currentDirectory.mode & 0o777
				}).toStrictEqual({
					directories: [
						'.active-roots.cupboard-owner',
						'.current-roots.cupboard-owner',
						'active-roots',
						'current-roots'
					],
					mode: 0o700
				});
			} finally {
				await Promise.all([activeRoots.close(), currentRoots.close()]);
			}
		}
	);

	it('removes every stale root record in order and preserves the first failure', async () => {
		const base = await mkdtemp(path.join(tmpdir(), 'cup-roots-stale-'));
		bases.push(base);
		const parent = path.join(base, 'cupboard');
		const staleDirectories = [
			path.join(parent, 'stale-a-roots'),
			path.join(parent, 'stale-b-roots')
		];
		const orphanOwner = path.join(parent, '.orphan-roots.cupboard-owner');
		const current = path.join(parent, 'current-roots');
		const currentOwner = path.join(base, 'current.sock');
		const failures = {
			directory: new Error('stale directory removal failed'),
			owner: new Error('stale owner removal failed')
		};
		const cleaned: string[] = [];

		for (const staleDirectory of staleDirectories) {
			await mkdir(staleDirectory, { recursive: true });
			await symlink(
				path.join(base, `${path.basename(staleDirectory)}.sock`),
				path.join(parent, `.${path.basename(staleDirectory)}.cupboard-owner`)
			);
		}
		await symlink(path.join(base, 'orphan.sock'), orphanOwner);

		await expect(
			createRootLinkDirectory(current, currentOwner, {
				removeDirectory: async (target) => {
					await rm(target, { recursive: true, force: true });
					cleaned.push(`directory:${path.basename(target)}`);
					if (target === staleDirectories[0]) {
						throw failures.directory;
					}
				},
				removeOwnerFile: async (target) => {
					await rm(target, { force: true });
					cleaned.push(`owner:${path.basename(target)}`);
					if (target.endsWith('.stale-a-roots.cupboard-owner')) {
						throw failures.owner;
					}
				}
			})
		).rejects.toBe(failures.directory);

		expect(cleaned).toStrictEqual([
			'directory:stale-a-roots',
			'owner:.stale-a-roots.cupboard-owner',
			'directory:stale-b-roots',
			'owner:.stale-b-roots.cupboard-owner',
			'owner:.orphan-roots.cupboard-owner'
		]);
	});

	it('runs every close operation and preserves the first cleanup failure', async () => {
		const base = await mkdtemp(path.join(tmpdir(), 'cupboard-roots-cleanup-'));
		bases.push(base);
		const directory = path.join(base, 'roots');
		const ownerSocket = path.join(base, 'owner.sock');
		const failures = {
			close: new Error('owner close failed'),
			directory: new Error('directory removal failed'),
			owner: new Error('owner-file removal failed')
		};
		const cleaned: string[] = [];
		const roots = await createRootLinkDirectory(directory, ownerSocket, {
			closeOwner: async (close) => {
				await close();
				cleaned.push('close');
				throw failures.close;
			},
			removeDirectory: async (target) => {
				await rm(target, { recursive: true, force: true });
				cleaned.push('directory');
				throw failures.directory;
			},
			removeOwnerFile: async (target) => {
				await rm(target, { force: true });
				cleaned.push('owner');
				throw failures.owner;
			}
		});

		await expect(roots.close()).rejects.toBe(failures.close);
		expect(cleaned).toStrictEqual(['close', 'directory', 'owner']);
	});

	it('closes the owner server when setting the socket mode fails', async () => {
		const base = await mkdtemp(path.join(tmpdir(), 'cupboard-roots-mode-'));
		bases.push(base);
		const directory = path.join(base, 'roots');
		const ownerSocket = path.join(base, 'owner.sock');
		const failure = new Error('socket chmod failed');
		const cleaned: string[] = [];

		await expect(
			createRootLinkDirectory(directory, ownerSocket, {
				setOwnerSocketMode: () => Promise.reject(failure),
				closeOwner: async (close) => {
					await close();
					cleaned.push('close');
					throw new Error('close failed');
				},
				removeDirectory: async (target) => {
					await rm(target, { recursive: true, force: true });
					cleaned.push('directory');
					throw new Error('directory removal failed');
				},
				removeOwnerFile: async (target) => {
					await rm(target, { force: true });
					cleaned.push('owner');
					throw new Error('owner-file removal failed');
				}
			})
		).rejects.toBe(failure);

		expect(cleaned).toStrictEqual(['close', 'directory', 'owner']);
		await expect(stat(ownerSocket)).rejects.toMatchObject({ code: 'ENOENT' });
	});
});
