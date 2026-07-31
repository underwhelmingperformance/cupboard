import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HookHelperMissingError } from '../errors.ts';

import { hookHelperName, resolveHookHelper } from './helper-resolution.ts';

const bases: string[] = [];

async function installation(): Promise<string> {
	const base = await mkdtemp(path.join(tmpdir(), 'cupboard-install-'));
	bases.push(base);

	return base;
}

afterEach(async () => {
	const created = [...bases];
	bases.length = 0;

	await Promise.all(
		created.map((base) => rm(base, { recursive: true, force: true }))
	);
});

describe('resolveHookHelper', () => {
	it('resolves the helper beside the executable', async () => {
		const base = await installation();
		const helperPath = path.join(base, hookHelperName);
		await writeFile(helperPath, '');

		await expect(
			resolveHookHelper({
				environment: {},
				executablePath: path.join(base, 'cupboard')
			})
		).resolves.toBe(helperPath);
	});

	it('resolves the helper under the sibling libexec directory', async () => {
		const base = await installation();
		const binDirectory = path.join(base, 'bin');
		const libexecDirectory = path.join(base, 'libexec', 'cupboard');
		const helperPath = path.join(libexecDirectory, hookHelperName);
		await mkdir(binDirectory, { recursive: true });
		await mkdir(libexecDirectory, { recursive: true });
		await writeFile(helperPath, '');

		await expect(
			resolveHookHelper({
				environment: {},
				executablePath: path.join(binDirectory, 'cupboard')
			})
		).resolves.toBe(
			path.join(binDirectory, '..', 'libexec', 'cupboard', hookHelperName)
		);
	});

	it('prefers the environment override to the installation layout', async () => {
		const base = await installation();
		const besideExecutable = path.join(base, hookHelperName);
		const overridePath = path.join(base, 'override-relay');
		await writeFile(besideExecutable, '');
		await writeFile(overridePath, '');

		await expect(
			resolveHookHelper({
				environment: { CUPBOARD_HOOK_HELPER: overridePath },
				executablePath: path.join(base, 'cupboard')
			})
		).resolves.toBe(overridePath);
	});

	it.each([
		{
			name: 'an override naming a missing file',
			environment: (base: string) => ({
				CUPBOARD_HOOK_HELPER: path.join(base, 'gone-relay')
			}),
			expectedCandidates: (base: string) => [path.join(base, 'gone-relay')]
		},
		{
			name: 'an installation with no helper anywhere',
			environment: () => ({}),
			expectedCandidates: (base: string) => [
				path.join(base, hookHelperName),
				path.join(base, '..', 'libexec', 'cupboard', hookHelperName)
			]
		}
	])('refuses $name', async ({ environment, expectedCandidates }) => {
		const base = await installation();
		let caught: unknown;

		try {
			await resolveHookHelper({
				environment: environment(base),
				executablePath: path.join(base, 'cupboard')
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(HookHelperMissingError);
		expect(
			caught instanceof HookHelperMissingError ? caught.candidates : undefined
		).toStrictEqual(expectedCandidates(base));
	});
});
