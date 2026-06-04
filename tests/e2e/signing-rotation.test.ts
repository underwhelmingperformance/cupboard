import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CupboardClient } from '../../packages/cli/src/client.ts';
import { NarInfo } from '../../packages/shared/src/narinfo.ts';
import { StorePath } from '../../packages/shared/src/store-path.ts';
import { CupboardTestServer } from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { NixStore, type RealiseOptions } from '../support/nix.ts';
import { pushStorePaths } from '../support/push.ts';

// A distinct, reference-free input-addressed derivation per marker, so each
// push produces a fresh store path the server signs with whatever keys are
// active at that moment.
function rotationDerivation(marker: string): string {
	return [
		'derivation {',
		`  name = "cupboard-rotation-${marker}";`,
		'  system = builtins.currentSystem;',
		'  builder = "/bin/sh";',
		String.raw`  args = [ "-c" "printf %s ${marker} > \"$out\"" ];`,
		'}'
	].join('\n');
}

describe('Nix substitution through a signing-key rotation', () => {
	it('dual-signs new paths in the window and keeps every path verifiable', () =>
		withTemporaryDirectory(
			'cupboard-e2e-rotation-',
			async (directory) => {
				const server = await CupboardTestServer.start(directory);

				try {
					const client = new CupboardClient(
						server.tenantUrl,
						server.uploadFetcher()
					);
					const token = await server.ownerAdminToken();
					const oldKey = await client.publicKey();
					const source = await NixStore.host(
						path.join(directory, 'source-home')
					);
					const push = (storePath: string): Promise<unknown> =>
						pushStorePaths(
							{
								client,
								token: token,
								store: source,
								workDirectory: directory
							},
							[storePath]
						);
					const trusting = (keys: readonly string[]): RealiseOptions => ({
						substituter: server.tenantUrl.toString(),
						trustedPublicKeys: keys,
						requireSigs: true
					});

					const targetOld = await NixStore.chroot(
						path.join(directory, 'target-old'),
						path.join(directory, 'target-old-home')
					);
					const targetNew = await NixStore.chroot(
						path.join(directory, 'target-new'),
						path.join(directory, 'target-new-home')
					);

					// Single-key golden path: a path pushed before any rotation carries
					// one signature and substitutes under the original key.
					const before = await source.build(rotationDerivation('before'));
					await push(before);
					const beforeInfo = await fetchNarInfo(server, before);
					await targetOld.realise(before, trusting([oldKey]));

					// Open the window. A path pushed now is signed by both keys.
					const { rotated, keys } = await client.rotateKey(token);
					const newKey = rotated.publicKey;

					const windowPath = await source.build(rotationDerivation('window'));
					await push(windowPath);
					const windowInfo = await fetchNarInfo(server, windowPath);
					const publishedInWindow = await publishedKeys(server);

					// The window path substitutes under the old key alone and under the
					// new key alone — the rotation guarantee.
					await targetOld.realise(windowPath, trusting([oldKey]));
					await targetNew.realise(windowPath, trusting([newKey]));

					// Retire the old key fully; a path pushed afterwards is signed by the
					// new key only and still substitutes under it.
					await client.retireKey(token, 'active');
					await client.retireKey(token, 'active');
					const publishedAfterRetire = await publishedKeys(server);

					const postPath = await source.build(rotationDerivation('post'));
					await push(postPath);
					const postInfo = await fetchNarInfo(server, postPath);
					await targetNew.realise(postPath, trusting([newKey]));

					expect({
						beforeSigs: beforeInfo.sigs.length,
						windowSigs: windowInfo.sigs.length,
						postSigs: postInfo.sigs.length,
						rotatedKeyCount: keys.length,
						publishedInWindow,
						publishedAfterRetire,
						before: await readFile(targetOld.physicalPath(before), 'utf8'),
						windowUnderOldKey: await readFile(
							targetOld.physicalPath(windowPath),
							'utf8'
						),
						windowUnderNewKey: await readFile(
							targetNew.physicalPath(windowPath),
							'utf8'
						),
						postUnderNewKey: await readFile(
							targetNew.physicalPath(postPath),
							'utf8'
						)
					}).toStrictEqual({
						beforeSigs: 1,
						windowSigs: 2,
						postSigs: 1,
						rotatedKeyCount: 2,
						publishedInWindow: [oldKey, newKey].toSorted(),
						publishedAfterRetire: [newKey],
						before: 'before',
						windowUnderOldKey: 'window',
						windowUnderNewKey: 'window',
						postUnderNewKey: 'post'
					});
				} finally {
					await server.stop();
				}
			},
			{ makeWritableBeforeCleanup: true }
		));
});

async function fetchNarInfo(
	server: CupboardTestServer,
	storePath: string
): Promise<NarInfo> {
	const response = await fetch(
		server.tenantPath(`/${StorePath.hash(storePath)}.narinfo`)
	);

	return NarInfo.parse(await response.text());
}

async function publishedKeys(server: CupboardTestServer): Promise<string[]> {
	const response = await fetch(server.tenantPath('/pubkey'));
	const body = await response.text();

	return body.trim().split('\n').toSorted();
}
