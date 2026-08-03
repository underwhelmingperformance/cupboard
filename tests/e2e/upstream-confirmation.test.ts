import { existsSync } from 'node:fs';
import process from 'node:process';

import { StorePath } from '@cupboard/nix-store/store-path';
import { describe, expect, it, type TestContext } from 'vitest';

import {
	confirmLeftUpstreamWith,
	upstreamConfirmationOverrides
} from '../../packages/cli/src/plan/upstream-confirmation.ts';
import { Nix } from '../../packages/nix/src/nix.ts';
import {
	NixDaemonConnectionError,
	NixDaemonStoreClient
} from '../../packages/nix/src/nix-daemon.ts';
import {
	discoverNixStoreConfig,
	type NixSubstitutionSettings
} from '../../packages/nix/src/store-config.ts';
import { FakeSubstituter } from '../support/substituter.ts';

const socketPath =
	process.env.NIX_DAEMON_SOCKET_PATH ?? '/nix/var/nix/daemon-socket/socket';
const tenantUrl = new URL('https://cupboard.example.workers.dev/t/acme');

// Connecting to the daemon socket needs a peer the daemon accepts; outside CI
// a sandboxed process may be refused with EPERM, which is a limitation of the
// environment, never a defect in the code under test.
function isPermissionDenied(error: unknown): boolean {
	if (!(error instanceof NixDaemonConnectionError)) {
		return false;
	}

	const cause = error.cause;

	return cause instanceof Error && 'code' in cause && cause.code === 'EPERM';
}

// The daemon keeps an untrusted client's settings out of the connection, so
// the substituter this test points the daemon at would never be asked.
async function requireTrustedDaemon(
	context: Pick<TestContext, 'skip'>,
	client: NixDaemonStoreClient
): Promise<void> {
	if ((await client.daemonTrust()) !== 'trusted') {
		context.skip();
	}
}

describe.skipIf(!existsSync(socketPath))('left-upstream confirmation', () => {
	// The daemon holds a positive narinfo answer for a month by default, long
	// enough for an upstream to have dropped the path since. A confirmation
	// leaves a target out of a build on the strength of that answer, so it has
	// to be one the substituter gives now.
	it('asks the substituter afresh and refuses a path it no longer serves', async (context) => {
		const config = discoverNixStoreConfig();
		const substituter = await FakeSubstituter.start(config.storeDirectory);

		try {
			const storePath = substituter.serve('cupboard-upstream-confirmation');
			const permitted = { substituters: substituter.url };
			const substitution: NixSubstitutionSettings = {
				substitute: true,
				alwaysAllowSubstitutes: false,
				substituters: [substituter.url]
			};
			const seeding = new NixDaemonStoreClient({
				socketPath,
				overrides: { ...permitted, 'extra-substituters': '' }
			});

			await requireTrustedDaemon(context, seeding);

			const seeded = await seeding.querySubstitutablePathInfos([storePath]);

			substituter.withdraw(storePath);
			substituter.forgetRequests();

			// A connection that keeps the default cache settings still answers
			// for the withdrawn path, which is what the confirmation must not
			// do: it is the daemon's month-old memory of this substituter.
			const remembered = await new NixDaemonStoreClient({
				socketPath,
				overrides: { ...permitted, 'extra-substituters': '' }
			}).querySubstitutablePathInfos([storePath]);
			const requestsWhileRemembered = substituter.narInfoRequests;

			const confirming = new NixDaemonStoreClient({
				socketPath,
				overrides: upstreamConfirmationOverrides(substitution, tenantUrl)
			});
			const confirm = confirmLeftUpstreamWith({
				substitution,
				store: Nix.forStore(confirming, {
					storeDirectory: config.storeDirectory
				})
			});

			expect({
				seeded: seeded.map((info) => info.storePath),
				remembered: remembered.map((info) => info.storePath),
				requestsWhileRemembered,
				verdict: await confirm({ installable: storePath, storePath }),
				requestsWhileConfirming: substituter.narInfoRequests
			}).toStrictEqual({
				seeded: [storePath],
				remembered: [storePath],
				requestsWhileRemembered: [],
				verdict: { kind: 'closure-not-served', missing: storePath },
				requestsWhileConfirming: [StorePath.hash(storePath)]
			});
		} catch (error) {
			if (isPermissionDenied(error) && process.env.CI === undefined) {
				context.skip();
			}

			throw error;
		} finally {
			await substituter.stop();
		}
	});
});
