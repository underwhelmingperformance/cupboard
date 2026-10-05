import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { writeBuildInfo } from './build-info.ts';

it('leaves identical build-info intact and replaces a changed version', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-build-info-'));
	const target = path.join(directory, 'build-info.ts');
	try {
		await writeBuildInfo(target, 'first');
		const before = await stat(target);
		await writeBuildInfo(target, 'first');
		const unchanged = await stat(target);
		await writeBuildInfo(target, 'second');
		expect({
			unchanged:
				unchanged.ino === before.ino && unchanged.mtimeMs === before.mtimeMs,
			source: await readFile(target, 'utf8')
		}).toStrictEqual({
			unchanged: true,
			source: 'export const buildVersion = "second";\n'
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
