import { existsSync } from 'node:fs';
import process from 'node:process';

import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { describe, expect, it, type TestContext } from 'vitest';

import { isReachableElsewhere } from '../../packages/cli/src/plan/substituter-reach.ts';
import {
	confirmUpstreamAvailabilityWith,
	upstreamConfirmationOverrides
} from '../../packages/cli/src/plan/upstream-confirmation.ts';
import { Nix } from '../../packages/nix/src/nix.ts';
import {
	NixDaemonConnectionError,
	NixDaemonStoreClient
} from '../../packages/nix/src/nix-daemon.ts';
import { offerAcceptance } from '../../packages/nix/src/offer-acceptance.ts';
import {
	discoverNixStoreConfig,
	type NixSubstitutionSettings
} from '../../packages/nix/src/store-config.ts';
import { FakeSubstituter } from '../support/substituter.ts';

/**
A machine holding none of the configured secret key files.
*/
const missingKeyFiles = new Map<string, string>();
const readNoKeyFile = (filePath: string): string | undefined =>
	missingKeyFiles.get(filePath);

const socketPath =
	process.env.NIX_DAEMON_SOCKET_PATH ?? '/nix/var/nix/daemon-socket/socket';
const tenantUrl = new URL('https://cupboard.example.workers.dev/t/acme');
const executableStorePath = /^\/nix\/store\/[^/]+/u.exec(process.execPath)?.[0];

// The confirmation walks the closure this store holds, so the candidate has to
// be a path it really holds. The test process's own store path is one whenever
// this Node came from the store, and the case skips anywhere else.
function requireExecutableStorePath(
	context: Pick<TestContext, 'skip'>
): StorePathString {
	if (executableStorePath === undefined) {
		context.skip();
		throw new Error('unreachable: skip does not return');
	}

	return storePathSchema.parse(executableStorePath);
}

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
	// leaves a target out of a build on the strength of that answer, so it
	// asks the substituter itself and reads what it serves now.
	it('asks the substituter afresh and refuses a path it no longer serves', async (context) => {
		const config = discoverNixStoreConfig();
		const substituter = await FakeSubstituter.start(config.storeDirectory);

		try {
			const storePath = requireExecutableStorePath(context);
			substituter.servePath(storePath);
			const permitted = { substituters: substituter.url };
			const substitution: NixSubstitutionSettings = {
				substitute: true,
				alwaysAllowSubstitutes: false,
				fallback: false,
				substituters: [substituter.url]
			};
			const seeding = new NixDaemonStoreClient({
				socketPath,
				overrides: permitted
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
				overrides: permitted
			}).querySubstitutablePathInfos([storePath]);
			const requestsWhileRemembered = substituter.narInfoRequests;

			// The fixture stands in for a cache a consumer elsewhere reads, and
			// it binds loopback because it runs beside this test. What this
			// case proves is that the confirmation reads what a substituter
			// serves now, so the fixture has to be among the permitted ones.
			const isReachableOrFixture = (candidate: string): boolean =>
				candidate === substituter.url || isReachableElsewhere(candidate);

			const confirm = confirmUpstreamAvailabilityWith({
				substitution,
				// The store a plan opens for its confirmation: the daemon
				// answers for what this machine holds, and the permitted
				// substituters are asked for each path's narinfo by this
				// process, which keeps no memory of one.
				store: Nix.openForAvailability(undefined, {
					overrides: upstreamConfirmationOverrides(substitution, tenantUrl, {
						isReachable: isReachableOrFixture
					})
				}),
				// Every offer carries the signatures the substituter published
				// for the path, so the policy a consumer applies at fetch time
				// applies here; the case under test is which substituters
				// answer at all.
				accepts: offerAcceptance(config.signatures, readNoKeyFile)
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
