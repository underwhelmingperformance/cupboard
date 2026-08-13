import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
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
				executablePath: path.join(base, 'cupboard')
			})
		).resolves.toBe(helperPath);
	});

	it('keeps a symlinked executable paired with its generation helper', async () => {
		const base = await installation();
		const generation = path.join(base, 'generation');
		const executable = path.join(generation, 'cupboard');
		const helper = path.join(generation, hookHelperName);
		const publicExecutable = path.join(base, 'cupboard');
		await mkdir(generation);
		await writeFile(executable, '');
		await writeFile(helper, 'generation helper');
		await writeFile(path.join(base, hookHelperName), 'legacy helper');
		await symlink(executable, publicExecutable);

		await expect(
			resolveHookHelper({ executablePath: publicExecutable })
		).resolves.toBe(await realpath(helper));
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
				executablePath: path.join(binDirectory, 'cupboard')
			})
		).resolves.toBe(
			path.join(binDirectory, '..', 'libexec', 'cupboard', hookHelperName)
		);
	});

	it('refuses an installation with no helper in either layout', async () => {
		const base = await installation();
		let caught: unknown;

		try {
			await resolveHookHelper({
				executablePath: path.join(base, 'cupboard')
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(HookHelperMissingError);
		expect(
			caught instanceof HookHelperMissingError ? caught.candidates : undefined
		).toStrictEqual([
			path.join(base, hookHelperName),
			path.join(base, '..', 'libexec', 'cupboard', hookHelperName)
		]);
	});
});
