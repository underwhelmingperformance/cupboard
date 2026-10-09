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

it('reads each database migration directory from its binding', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'cupboard-artifact-d1-'));
	const server = path.join(root, 'packages/server');
	try {
		await mkdir(path.join(server, 'src'), { recursive: true });
		await mkdir(path.join(server, 'shared-migrations'));
		await mkdir(path.join(server, 'control-migrations'));
		await Promise.all([
			writeFile(
				path.join(server, 'wrangler.jsonc'),
				JSON.stringify({
					d1_databases: [
						{
							binding: 'CONTROL_DB',
							database_name: 'control',
							migrations_dir: 'control-migrations'
						}
					]
				})
			),
			writeFile(
				path.join(server, 'wrangler.tenant.jsonc'),
				JSON.stringify({
					d1_databases: [
						{
							binding: 'CUPBOARD_DB',
							database_name: 'shared',
							migrations_dir: 'shared-migrations'
						}
					]
				})
			),
			writeFile(
				path.join(server, 'shared-migrations/0000_shared.sql'),
				'SELECT 1;'
			),
			writeFile(
				path.join(server, 'control-migrations/0000_control.sql'),
				'SELECT 2;'
			)
		]);
		const payload = await buildEmbeddedPayload(root, {
			bundle: (_entry, mainModule) =>
				Promise.resolve({ mainModule, code: 'code' })
		});
		expect({
			shared: payload.d1Migrations,
			sets: payload.d1MigrationSets
		}).toStrictEqual({
			shared: [
				{
					name: '0000_shared.sql',
					sha256:
						'17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a',
					statements: ['SELECT 1;']
				}
			],
			sets: {
				CUPBOARD_DB: [
					{
						name: '0000_shared.sql',
						sha256:
							'17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a',
						statements: ['SELECT 1;']
					}
				],
				CONTROL_DB: [
					{
						name: '0000_control.sql',
						sha256:
							'8e7003d62f9d8cbd28da2f243bb0d215bfd4622c716be09be89a8764d9f4c7cb',
						statements: ['SELECT 2;']
					}
				]
			}
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
