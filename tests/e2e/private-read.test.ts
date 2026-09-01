import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { renderNetrc } from '@cupboard/nix-store/nix-config';
import {
	storeDirectorySchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { CupboardClient } from '../../packages/cli/src/client/client.ts';
import type { UnreachableSubstituter } from '../../packages/nix/src/nix-store.ts';
import { substituterClientOver } from '../../packages/nix/src/store-client.ts';
import {
	defaultFileTransferSettings,
	defaultNixConfigEnvironment
} from '../../packages/nix/src/store-config.ts';
import { CupboardTestServer } from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { NixStore, type RealiseOptions } from '../support/nix.ts';
import { pushStorePaths } from '../support/push.ts';

const readUser = 'alice';
const readPassword = 'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23';

const privateDerivation = [
	'derivation {',
	'  name = "cupboard-private";',
	'  system = builtins.currentSystem;',
	'  builder = "/bin/sh";',
	String.raw`  args = [ "-c" "printf %s private > \"$out\"" ];`,
	'}'
].join('\n');

describe('Nix substitution from a private-read cache', () => {
	it('substitutes with a netrc credential and refuses without one', () =>
		withTemporaryDirectory(
			'cupboard-e2e-private-',
			async (directory) => {
				const server = await CupboardTestServer.start(directory, {
					provision: {
						defaultCacheAccess: 'private',
						read: { user: readUser, password: readPassword }
					}
				});

				try {
					const client = new CupboardClient(server.tenantUrl, fetch, {
						kind: 'default'
					});
					const token = await server.ownerAdminToken();
					const publicKey = await client.publicKey();
					const source = await NixStore.host(
						path.join(directory, 'source-home')
					);
					const storePath = await source.build(privateDerivation);
					await pushStorePaths(
						{ client: server.pushClient(token), store: source },
						[storePath]
					);

					const netrcFile = path.join(directory, 'netrc');
					await writeFile(
						netrcFile,
						renderNetrc(server.url, readUser, readPassword)
					);

					const base: RealiseOptions = {
						substituter: server.tenantUrl.href,
						trustedPublicKeys: [publicKey],
						requireSigs: true
					};

					const authorised = await NixStore.chroot(
						path.join(directory, 'target-auth'),
						path.join(directory, 'target-auth-home')
					);
					await authorised.realise(storePath, { ...base, netrcFile });

					const unauthorised = await NixStore.chroot(
						path.join(directory, 'target-unauth'),
						path.join(directory, 'target-unauth-home')
					);
					let withoutCredential: string;
					try {
						await unauthorised.realise(storePath, base);
						withoutCredential = 'substituted';
					} catch {
						withoutCredential = 'refused';
					}

					expect({
						withCredential: await readFile(
							authorised.physicalPath(storePath),
							'utf8'
						),
						withoutCredential
					}).toStrictEqual({
						withCredential: 'private',
						withoutCredential: 'refused'
					});
				} finally {
					await server.stop();
				}
			},
			{ makeWritableBeforeCleanup: true }
		));

	// Our own client reads the netrc rather than handing it to libcurl, so the
	// credentials it presents are only right if the file is read the way
	// libcurl reads one. A cache that answers 401 is one this run holds no
	// credential for, which a plan has to be able to tell from a cache holding
	// nothing.
	it('offers what a private cache holds, and names it when no credential answers', () =>
		withTemporaryDirectory(
			'cupboard-e2e-private-client-',
			async (directory) => {
				const server = await CupboardTestServer.start(directory, {
					provision: {
						defaultCacheAccess: 'private',
						read: { user: readUser, password: readPassword }
					}
				});

				try {
					const token = await server.ownerAdminToken();
					const source = await NixStore.host(
						path.join(directory, 'source-home')
					);
					const storePath = await source.build(privateDerivation);
					await pushStorePaths(
						{ client: server.pushClient(token), store: source },
						[storePath]
					);

					const netrcFile = path.join(directory, 'netrc');
					await writeFile(
						netrcFile,
						renderNetrc(server.url, readUser, readPassword)
					);

					const withCredential = await askAsClient(
						netrcFile,
						server,
						storePath
					);
					const withoutCredential = await askAsClient(
						path.join(directory, 'no-such-netrc'),
						server,
						storePath
					);

					expect({ withCredential, withoutCredential }).toStrictEqual({
						withCredential: { offered: [storePath], unreachable: [] },
						withoutCredential: {
							offered: [],
							unreachable: [
								{
									uri: server.tenantUrl.href,
									reason: 'needs-credentials'
								}
							]
						}
					});
				} finally {
					await server.stop();
				}
			},
			{ makeWritableBeforeCleanup: true }
		));
});

/**
What our substituter client made of the cache, given a netrc to read.
*/
async function askAsClient(
	netrcFile: string,
	server: CupboardTestServer,
	storePath: string
): Promise<{
	readonly offered: readonly string[];
	readonly unreachable: readonly UnreachableSubstituter[];
}> {
	const client = substituterClientOver(
		{
			storeDirectory: storeDirectorySchema.parse('/nix/store'),
			stateDirectory: '/nix/var/nix'
		},
		{
			substitute: true,
			alwaysAllowSubstitutes: false,
			fallback: false,
			substituters: [server.tenantUrl.href]
		},
		{ ...defaultFileTransferSettings, attempts: 1, netrcFile },
		{ ...defaultNixConfigEnvironment, env: {} }
	);
	const offers = await client.querySubstitutablePathInfos([
		storePathSchema.parse(storePath)
	]);

	return {
		offered: offers.map((offer) => offer.storePath),
		unreachable: await client.unreachable()
	};
}
