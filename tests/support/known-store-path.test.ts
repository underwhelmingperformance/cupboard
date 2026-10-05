import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { withTemporaryDirectory } from './filesystem.ts';
import { addKnownStorePath } from './known-store-path.ts';
import { NixStore } from './nix.ts';

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
					const known = await addKnownStorePath(workspace, store);
					const info = await store.pathInfo(known.root);

					expect({
						rootExists: existsSync(store.physicalPath(known.root)),
						dependencyExists: existsSync(store.physicalPath(known.dependency)),
						references: info.references
					}).toStrictEqual({
						rootExists: true,
						dependencyExists: true,
						references: [known.dependency]
					});
				}
			);
		});
	}
);
