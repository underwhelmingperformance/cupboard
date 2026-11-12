import path from 'node:path';

import { NarInfo } from '@cupboard/nix-store/narinfo';
import { StorePath } from '@cupboard/nix-store/store-path';
import { expect, it } from 'vitest';

import { CupboardTestServer } from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { NixStore } from '../support/nix.ts';
import { pushStorePaths } from '../support/push.ts';

const root = path.resolve(import.meta.dirname, '../..');
const fixture = path.join(root, 'tests/fixtures/simple/source');

interface WireShape {
	readonly status: number;
	readonly contentLength: string | undefined;
	readonly transferEncoding: string | undefined;
}

interface HeaderReadingResponse {
	readonly status: number;
	readonly headers: { get(name: string): string | null };
}

function wireShape(response: HeaderReadingResponse): WireShape {
	return {
		status: response.status,
		contentLength: response.headers.get('content-length') ?? undefined,
		transferEncoding: response.headers.get('transfer-encoding') ?? undefined
	};
}

it('declares the length of a public narinfo and NAR on the wire', () =>
	withTemporaryDirectory(
		'cupboard-e2e-body-length-',
		async (directory) => {
			const server = await CupboardTestServer.start(directory);

			try {
				const store = await NixStore.host(path.join(directory, 'home'));
				const storePath = await store.add(fixture);

				await pushStorePaths(
					{
						client: server.pushClient(await server.ownerAdminToken()),
						store
					},
					[storePath]
				);

				const narInfoResponse = await server.dispatchGet(
					server.tenantPath(`/${StorePath.hash(storePath)}.narinfo`)
				);
				const narInfoText = await narInfoResponse.text();
				const narInfo = NarInfo.parse(narInfoText);
				const narResponse = await server.dispatchGet(
					server.tenantPath(`/${narInfo.url}`)
				);

				await narResponse.arrayBuffer();

				expect({
					narInfo: wireShape(narInfoResponse),
					nar: wireShape(narResponse)
				}).toStrictEqual({
					narInfo: {
						status: 200,
						contentLength: String(Buffer.byteLength(narInfoText)),
						transferEncoding: undefined
					},
					nar: {
						status: 200,
						contentLength: String(narInfo.fileSize),
						transferEncoding: undefined
					}
				});
			} finally {
				await server.stop();
			}
		},
		{ makeWritableBeforeCleanup: true }
	));
