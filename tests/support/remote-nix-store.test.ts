import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { startNixSshStore, stopNixSshStore } from './remote-nix-store.ts';

const failures = vi.hoisted(() => ({
	keygen: new Error('ssh-keygen failed'),
	stop: new Error('the container could not be stopped'),
	removal: new Error('the workspace could not be removed')
}));

vi.mock('./process.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./process.ts')>()),
	runCommand: () => Promise.reject(failures.keygen)
}));

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();

	return {
		...actual,
		rm: async (...arguments_: Parameters<typeof actual.rm>) => {
			await actual.rm(...arguments_);

			throw failures.removal;
		}
	};
});

describe('startNixSshStore', () => {
	it('reports the startup failure when removing the workspace also fails', async () => {
		await expect(startNixSshStore()).rejects.toBe(failures.keygen);
	});
});

describe('stopNixSshStore', () => {
	it.each([
		{
			name: 'the stop failure when removing the workspace also fails',
			stop: () => Promise.reject(failures.stop),
			expected: failures.stop
		},
		{
			name: 'the removal failure after the container stops',
			stop: () => Promise.resolve(),
			expected: failures.removal
		}
	])('reports $name', async ({ stop, expected }) => {
		const workspace = await mkdtemp(path.join(tmpdir(), 'cupboard-stop-'));

		await expect(stopNixSshStore({ stop }, workspace)).rejects.toBe(expected);
	});
});
