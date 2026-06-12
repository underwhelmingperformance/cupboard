import path from 'node:path';

import { implicitPinName } from '@cupboard/nix/retention';
import { StorePath } from '@cupboard/nix/store-path';
import { describe, expect, it } from 'vitest';

import { pushClientFor } from '../../packages/cli/src/push/push-client.ts';
import { CupboardTestServer } from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { NixStore } from '../support/nix.ts';
import { pushStorePaths } from '../support/push.ts';

const contentAddressedFixture = path.join(
	path.resolve(import.meta.dirname, '../..'),
	'tests/fixtures/simple/source'
);

describe('cold-path retention TTL', () => {
	it('expires implicit pins under the cold-path default but leaves named roots permanent', () =>
		withTemporaryDirectory(
			'cupboard-e2e-cold-',
			async (directory) => {
				const server = await CupboardTestServer.start(directory, {
					bindings: { CUPBOARD_COLD_PATH_TTL_SECONDS: '3600' }
				});

				try {
					const token = await server.ownerAdminToken();
					const client = pushClientFor(server.tenantUrl, token, {
						fetcher: server.uploadFetcher()
					});
					const source = await NixStore.host(
						path.join(directory, 'source-home')
					);
					const storePath = await source.add(contentAddressedFixture);

					// Root activation gates on servability, so the target must be pushed
					// before it can be rooted.
					await pushStorePaths(
						{ client, store: source, workDirectory: directory },
						[storePath]
					);

					const pin = await client.setRoot(
						implicitPinName(StorePath.hash(storePath)),
						{ targets: [storePath] }
					);
					const named = await client.setRoot('github:owner/repo/main', {
						targets: [storePath]
					});

					expect({
						pinExpires: pin.expiresAt !== undefined,
						namedExpires: named.expiresAt !== undefined
					}).toStrictEqual({ pinExpires: true, namedExpires: false });
				} finally {
					await server.stop();
				}
			},
			{ makeWritableBeforeCleanup: true }
		));
});
