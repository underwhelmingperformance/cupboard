import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { withTemporaryDirectory } from './filesystem.ts';
import { addKnownStorePath, type KnownStorePath } from './known-store-path.ts';
import { NixStore } from './nix.ts';
import * as processFixture from './process.ts';

describe.skipIf(spawnSync('nix-store', ['--version']).status !== 0)(
	'known store paths',
	() => {
		it('registers a root with a genuine store reference without depending on Node packaging', async () => {
			await withTemporaryDirectory(
				'cupboard-known-path-',
				async (workspace) => {
					const store = await NixStore.chroot(
						path.join(workspace, 'store'),
						path.join(workspace, 'home')
					);
					const commands = vi.spyOn(processFixture, 'runCommand');
					let known: KnownStorePath;
					let invocations: readonly string[];
					try {
						known = await addKnownStorePath(workspace, store);
						invocations = commands.mock.calls.map(([command]) => command);
					} finally {
						commands.mockRestore();
					}
					const info = await store.pathInfo(known.root);

					expect({
						invocations,
						rootExists: existsSync(store.physicalPath(known.root)),
						dependencyExists: existsSync(store.physicalPath(known.dependency)),
						references: info.references
					}).toStrictEqual({
						invocations: ['nix'],
						rootExists: true,
						dependencyExists: true,
						references: [known.dependency]
					});
				}
			);
		});
	}
);
