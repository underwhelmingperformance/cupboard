import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { StorePath } from '@cupboard/nix-store/store-path';
import {
	uploadPathNegotiationSchema,
	type UploadSkipDecision,
	uploadSkipDecisionSchema
} from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import { CupboardTestServer } from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { NixStore } from '../support/nix.ts';
import { pushStorePaths } from '../support/push.ts';

const cases = [
	{
		label: 'small metadata',
		references: 0,
		distinct: true,
		nameLength: 1,
		pages: 1
	},
	{
		label: 'canonical byte limit',
		references: 10_000,
		distinct: true,
		nameLength: 80,
		pages: 2
	},
	{
		label: 'raw byte limit',
		references: 10_000,
		distinct: false,
		nameLength: 211,
		pages: 2
	}
];

describe('already-present confirmation', () => {
	it.each(cases)(
		'confirms $label through the actual server handshake',
		async (selection) =>
			withTemporaryDirectory(
				'cupboard-present-confirmation-',
				async (directory) => {
					const server = await CupboardTestServer.start(directory);
					try {
						const store = await NixStore.host(path.join(directory, 'home'));
						const paths = await Promise.all(
							[0, 1].map(async (index) => {
								const file = path.join(directory, `input-${String(index)}`);
								await writeFile(file, `confirmation ${String(index)}\n`);
								return store.add(file);
							})
						);
						const credential = await server.ownerAdminToken();
						await pushStorePaths(
							{ client: server.pushClient(credential), store },
							paths
						);

						const client = server.pushClient(credential);
						const selected: UploadSkipDecision[] = [];
						for (const storePath of paths) {
							const info = await store.pathInfo(storePath);
							const metadata = uploadPathNegotiationSchema.parse({
								storePath,
								storePathHash: StorePath.hash(storePath),
								narHash: info.narHash.toString(),
								narSize: info.narSize,
								references: Array.from(
									{ length: selection.references },
									(_, index) =>
										`${String(selection.distinct ? index : 0).padStart(32, '0')}-${'r'.repeat(selection.nameLength)}`
								)
							});
							const plan = await client.negotiate({ paths: [metadata] });
							selected.push(
								...plan.uploads.map((decision) =>
									uploadSkipDecisionSchema.parse(decision)
								)
							);
						}

						const before = server.publicationEntriesSent;
						const requestOffset = server.requests.length;
						const session = await client.openCommitSession?.({});
						try {
							const response = await client.confirmPresent?.(selected);
							expect({
								response,
								publicationEntries: server.publicationEntriesSent - before,
								confirmations: server.requests
									.slice(requestOffset)
									.filter((request) =>
										request.path.endsWith('/uploads/confirm-present')
									)
							}).toStrictEqual({
								response: {
									paths: selected.map((entry) => ({
										storePathHash: entry.storePathHash,
										status: 'confirmed',
										narHash: entry.narHash,
										generation: 0,
										grace: {}
									}))
								},
								publicationEntries: 0,
								confirmations: Array.from({ length: selection.pages }, () => ({
									method: 'POST',
									path: `${server.tenantUrl.pathname}/uploads/confirm-present`,
									status: 200
								}))
							});
						} finally {
							session?.close();
						}
					} finally {
						await server.stop();
					}
				},
				{ makeWritableBeforeCleanup: true }
			)
	);
});
