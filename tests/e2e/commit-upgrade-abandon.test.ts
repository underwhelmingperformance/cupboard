import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { CupboardClient } from '../../packages/cli/src/client/client.ts';
import type { AdvertisedCapabilities } from '../../packages/cli/src/client/commit-socket.ts';
import { CupboardTestServer } from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';

// Small enough that one leaked session's opening grant is the difference
// between the next session opening on credit and opening on nothing.
const creditBudget = 2;

/**
 * Opens a commit upgrade and drops the connection at once, without waiting for
 * the answer. This is what a publication that opens a session and finishes with
 * it immediately looks like from the outside, and it races the dispatch to the
 * worker.
 */
async function abandonCommitUpgrade(
	server: CupboardTestServer,
	bearer: string
): Promise<void> {
	const url = server.tenantUrl;
	const socket = createConnection({
		host: url.hostname,
		port: Number(url.port)
	});

	await new Promise<void>((resolve) => {
		socket.once('connect', () => {
			socket.write(
				[
					`GET ${url.pathname}/commit HTTP/1.1`,
					`Host: ${url.host}`,
					'Upgrade: websocket',
					'Connection: Upgrade',
					'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==',
					'Sec-WebSocket-Version: 13',
					`Authorization: Bearer ${bearer}`,
					'x-cupboard-accept-capabilities: commit-batch,commit-credit',
					'',
					''
				].join('\r\n'),
				() => {
					socket.destroy();
					resolve();
				}
			);
		});
	});
}

/**
The credit the server advertised on a session's 101.
*/
async function openingGrantOf(
	client: CupboardClient,
	bearer: string
): Promise<string | undefined> {
	const negotiated = Promise.withResolvers<AdvertisedCapabilities>();
	const session = await client.openCommitSession(bearer, {
		onCapabilities: (capabilities) => {
			negotiated.resolve(capabilities);
		}
	});

	try {
		const advertised = await negotiated.promise;

		return advertised.get('commit-credit')?.grant;
	} finally {
		session.close();
	}
}

// A session the server accepted but no client ever reached would hold its
// opening grant until the idle close, and every publication that followed it
// would wait for capacity that nothing was using.
describe('a commit upgrade whose client leaves before the handshake', () => {
	it('leaves the server holding no credit for it', () =>
		withTemporaryDirectory('cupboard-e2e-abandon-', async (directory) => {
			const server = await CupboardTestServer.start(directory, {
				bindings: {
					CUPBOARD_COMMIT_ENTRY_CREDIT_BUDGET: String(creditBudget)
				}
			});

			try {
				const bearer = await server.ownerAdminToken();
				const client = new CupboardClient(server.tenantUrl, fetch, {
					kind: 'default'
				});

				await abandonCommitUpgrade(server, bearer);

				// The abandonment happens inside the harness, after the worker has
				// answered, so wait for the bridge to report it before asking what
				// the server has left.
				while (server.commitSessions.abandonedUpgrades === 0) {
					await delay(20);
				}

				expect({
					abandoned: server.commitSessions.abandonedUpgrades,
					grant: await openingGrantOf(client, bearer)
				}).toStrictEqual({
					abandoned: 1,
					// Half the budget, which is the whole of a session's opening
					// grant here. A session still held by the abandoned upgrade would
					// leave nothing to halve.
					grant: String(Math.floor(creditBudget / 2))
				});
			} finally {
				await server.stop();
			}
		}));
});
