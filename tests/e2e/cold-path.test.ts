import { describe, expect, it } from 'vitest';

import { CupboardClient } from '../../packages/cli/src/client.ts';
import { implicitPinName } from '../../packages/shared/src/retention.ts';
import { StorePath } from '../../packages/shared/src/store-path.ts';
import { CupboardTestServer } from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';

describe('cold-path retention TTL', () => {
	it('expires implicit pins under the cold-path default but leaves named roots permanent', () =>
		withTemporaryDirectory('cupboard-e2e-cold-', async (directory) => {
			const server = await CupboardTestServer.start(directory, {
				bindings: { CUPBOARD_COLD_PATH_TTL_SECONDS: '3600' }
			});

			try {
				const client = new CupboardClient(server.url, server.uploadFetcher());
				const token = await server.ownerAdminToken();
				const storePath = `/nix/store/${'0'.repeat(32)}-app`;

				const pin = await client.setRoot(
					token,
					implicitPinName(StorePath.hash(storePath)),
					{ targets: [storePath] }
				);
				const named = await client.setRoot(token, 'github:owner/repo/main', {
					targets: [storePath]
				});

				expect({
					pinExpires: pin.expiresAt !== undefined,
					namedExpires: named.expiresAt !== undefined
				}).toStrictEqual({ pinExpires: true, namedExpires: false });
			} finally {
				await server.stop();
			}
		}));
});
