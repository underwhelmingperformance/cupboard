import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { renderActionBundle } from './action-bundles.ts';

const execute = promisify(execFile);

it('bundles TypeScript dependencies reproducibly without runtime installation', async () => {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-action-bundle-')
	);
	const sourcePath = path.join(directory, 'main.ts');
	const outputPath = path.join(directory, 'main.cjs');

	try {
		await writeFile(
			path.join(directory, 'value.ts'),
			'export const value: string = "bundled";\n'
		);
		await writeFile(
			sourcePath,
			'import { value } from "./value.ts";\nprocess.stdout.write(value);\n'
		);
		const contents = await renderActionBundle(sourcePath);
		await writeFile(outputPath, contents);
		await rm(sourcePath);
		await rm(path.join(directory, 'value.ts'));
		const result = await execute(process.execPath, [outputPath], {
			cwd: directory
		});
		expect({
			stdout: result.stdout,
			stderr: result.stderr,
			bundle: await readFile(outputPath, 'utf8')
		}).toStrictEqual({ stdout: 'bundled', stderr: '', bundle: contents });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it('produces identical bundles when called again', async () => {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'cupboard-action-bundle-')
	);
	const sourcePath = path.join(directory, 'post.ts');

	try {
		await writeFile(
			sourcePath,
			'const value: string = "cleanup";\nprocess.stdout.write(value);\n'
		);
		expect(await renderActionBundle(sourcePath)).toBe(
			await renderActionBundle(sourcePath)
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
