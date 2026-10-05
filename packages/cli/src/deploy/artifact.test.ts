import {
	mkdir,
	mkdtemp,
	open,
	readFile,
	rm,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

import { buildEmbeddedPayload } from './artifact.ts';
import type { Bundler } from './bundle.ts';

vi.mock('./build-version.ts', () => ({
	resolveBuildVersion: () => Promise.resolve('current-version')
}));

it('publishes new deployment build-info without changing an existing reader', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'cupboard-artifact-info-'));
	const server = path.join(root, 'packages/server');
	const info = path.join(server, 'src/build-info.generated.ts');
	const oldSource = 'export const buildVersion = "previous-version";\n';
	try {
		await mkdir(path.join(server, 'src'), { recursive: true });
		await mkdir(path.join(server, 'drizzle-d1'));
		await Promise.all([
			writeFile(info, oldSource),
			writeFile(path.join(server, 'wrangler.jsonc'), '{}'),
			writeFile(path.join(server, 'wrangler.tenant.jsonc'), '{}'),
			writeFile(
				path.join(server, 'drizzle-d1/0000_fixture.sql'),
				'CREATE TABLE fixture (id);'
			)
		]);
		const reader = await open(info, 'r');
		try {
			const bundles: Bundler = {
				bundle: (_entry, mainModule) =>
					Promise.resolve({ mainModule, code: 'worker-code' })
			};
			const payload = await buildEmbeddedPayload(root, bundles);
			expect({
				previousReader: await reader.readFile('utf8'),
				currentReader: await readFile(info, 'utf8'),
				payload
			}).toStrictEqual({
				previousReader: oldSource,
				currentReader: 'export const buildVersion = "current-version";\n',
				payload: {
					controlSource: '{}',
					tenantSource: '{}',
					controlBundle: { mainModule: 'worker.js', code: 'worker-code' },
					tenantBundle: { mainModule: 'tenant-worker.js', code: 'worker-code' },
					d1Migrations: [
						{
							name: '0000_fixture.sql',
							sha256:
								'ba2bf23a35e00f7030db66d1eb8674ce9f20fe6a3d580e76cd9be213b573e3ec',
							statements: ['CREATE TABLE fixture (id);']
						}
					],
					buildVersion: 'current-version'
				}
			});
		} finally {
			await reader.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
