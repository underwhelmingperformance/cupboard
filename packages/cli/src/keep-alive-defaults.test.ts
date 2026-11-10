import { createServer } from 'node:http';

import { fakeCliUi } from '@cupboard/cli-ui/testing';
import { describe, expect, it } from 'vitest';

import { type CachedSession } from './auth/token-store.ts';
import { runLogout } from './commands/logout.ts';
import { createCloudflareClient } from './deploy/auth.ts';

interface ServedRequest {
	readonly path: string;
	readonly connection: number;
}

function segment(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sessionFor(origin: string, name: string): CachedSession {
	const target = `${origin}/t/${name}`;

	return {
		accessToken: `${segment({ alg: 'EdDSA' })}.${segment({ iss: target, aud: target })}.signature`,
		refreshToken: `refresh-${name}`
	};
}

const cloudflareResponse = JSON.stringify({
	success: true,
	errors: [],
	messages: [],
	result: [],
	result_info: { page: 1, per_page: 20, count: 0, total_count: 0 }
});

const defaults: readonly {
	readonly name: string;
	readonly send: (origin: string) => Promise<void>;
	readonly paths: readonly string[];
}[] = [
	{
		name: 'the Cloudflare API client',
		send: async (origin) => {
			const client = createCloudflareClient('token');
			client.baseURL = origin;
			for (let call = 0; call < 4; call += 1) {
				await client.accounts.list();
			}
		},
		paths: Array.from({ length: 4 }, () => '/accounts')
	},
	{
		name: 'refresh token revocation in logout',
		send: async (origin) => {
			const { ui } = fakeCliUi();
			await runLogout(
				{ sessions: { kind: 'all' }, cloudflareSignIn: 'keep' },
				ui.reporter(),
				{
					removeSession: () => Promise.resolve({ removal: 'absent' }),
					removeAllSessions: () =>
						Promise.resolve(
							['a', 'b', 'c', 'd'].map((name) => sessionFor(origin, name))
						),
					readGrant: () => Promise.resolve(undefined),
					removeGrant: () => Promise.resolve({ removal: 'absent' })
				}
			);
		},
		paths: ['a', 'b', 'c', 'd'].map((name) => `/t/${name}/revoke`)
	}
];

describe('default fetch', () => {
	it.each(defaults)(
		'sends consecutive requests of $name over one connection',
		async ({ send, paths }) => {
			const served: ServedRequest[] = [];
			const connections = new WeakMap<object, number>();
			let connectionCount = 0;
			const server = createServer((request, response) => {
				served.push({
					path: new URL(request.url ?? '', 'http://localhost').pathname,
					connection: connections.get(request.socket) ?? 0
				});
				request.resume();
				request.on('end', () => {
					response.setHeader('content-type', 'application/json');
					response.end(cloudflareResponse);
				});
			});
			server.on('connection', (socket) => {
				connectionCount += 1;
				connections.set(socket, connectionCount);
			});

			try {
				await new Promise<void>((resolve) => {
					server.listen(0, '127.0.0.1', resolve);
				});
				const address = server.address();
				if (address === null || typeof address === 'string') {
					throw new TypeError('The server has no TCP address');
				}
				await send(`http://127.0.0.1:${String(address.port)}`);
			} finally {
				server.closeAllConnections();
				await new Promise<void>((resolve) => {
					server.close(() => {
						resolve();
					});
				});
			}

			expect(served).toStrictEqual(
				paths.map((path) => ({ path, connection: 1 }))
			);
		}
	);
});
