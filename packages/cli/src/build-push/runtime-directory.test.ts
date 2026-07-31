import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { platform } from 'node:process';

import { invocationIdSchema } from '@cupboard/protocol/build';
import { afterEach, describe, expect, it } from 'vitest';

import { SocketPathTooLongError } from '../errors.ts';

import {
	createInvocationRuntimeDirectory,
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
});
