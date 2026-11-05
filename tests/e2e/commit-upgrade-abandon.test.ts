import { createConnection } from 'node:net';

import {
	commitAcceptCapabilitiesHeader,
	commitBatchCapability,
	commitCapabilitiesHeader,
	commitCreditCapability
} from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { parseCapabilities } from '../../packages/cli/src/client/commit-socket.ts';
import { CupboardTestServer } from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';

// Small enough that one leaked session's opening grant is the difference
// between the next session opening on credit and opening on nothing.
const creditBudget = 2;

/**
Opens a commit upgrade and drops the connection at once, without waiting for
the answer. This is what a publication that opens a session and finishes with
it immediately looks like from the outside, and it races the dispatch to the
worker.
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
	server: CupboardTestServer,
	bearer: string
): Promise<string | undefined> {
	const url = new URL(server.tenantUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.pathname = `${url.pathname}/commit`;
	const header = Promise.withResolvers<string>();
	const socket = new WebSocket(url, {
		headers: {
			authorization: `Bearer ${bearer}`,
			[commitAcceptCapabilitiesHeader]: `${commitBatchCapability},${commitCreditCapability}`
		}
	});
	socket.once('upgrade', (response) => {
		const value = response.headers[commitCapabilitiesHeader];
		header.resolve(Array.isArray(value) ? value.join(',') : (value ?? ''));
	});
	socket.on('error', header.reject);

	try {
		return parseCapabilities(await header.promise).get(commitCreditCapability)
			?.grant;
	} finally {
		socket.close();
	}
}

// A session the server accepted but no client ever reached would hold its
// opening grant until the idle close, and every publication that followed it
// would wait for capacity that nothing was using.
describe('a commit upgrade whose client leaves before the handshake', () => {
	it('leaves the server holding no credit for it', () =>
		withTemporaryDirectory('cupboard-e2e-abandon-', async (directory) => {
			const abandoned = Promise.withResolvers<undefined>();
			const server = await CupboardTestServer.start(directory, {
				onAbandonedUpgrade: () => {
					abandoned.resolve(undefined);
				},
				bindings: {
					CUPBOARD_COMMIT_ENTRY_CREDIT_BUDGET: String(creditBudget)
				}
			});

			try {
				const bearer = await server.ownerAdminToken();

				await abandonCommitUpgrade(server, bearer);

				await abandoned.promise;

				expect({
					abandoned: server.commitSessions.abandonedUpgrades,
					grant: await openingGrantOf(server, bearer)
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
