import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CupboardClient } from '../../packages/cli/src/client.ts';
import { renderNetrc } from '../../packages/shared/src/nix-config.ts';
import {
	bootstrapToken,
	CupboardTestServer
} from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { NixStore, type RealiseOptions } from '../support/nix.ts';
import { pushStorePaths } from '../support/push.ts';

const readUser = 'alice';
const readPassword = 'secret';

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
					bindings: {
						CUPBOARD_READ_USER: readUser,
						CUPBOARD_READ_PASSWORD: readPassword
					}
				});

				try {
					const client = new CupboardClient(server.url, server.uploadFetcher());
					const bootstrap = await client.bootstrap(bootstrapToken);
					const source = await NixStore.host(
						path.join(directory, 'source-home')
					);
					const storePath = await source.build(privateDerivation);
					await pushStorePaths(
						{
							client,
							token: bootstrap.token,
							store: source,
							workDirectory: directory
						},
						[storePath]
					);

					const netrcFile = path.join(directory, 'netrc');
					await writeFile(
						netrcFile,
						renderNetrc(server.url.hostname, readUser, readPassword)
					);

					const base: RealiseOptions = {
						substituter: server.url.origin,
						trustedPublicKeys: [bootstrap.publicKey],
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
					const withoutCredential = await unauthorised
						.realise(storePath, base)
						.then(() => 'substituted')
						.catch(() => 'refused');

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
});
