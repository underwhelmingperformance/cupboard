import type {
	BootstrapResponse,
	DeletePathResponse,
	RootListResponse,
	RootRemoveResponse,
	RootSetBody,
	RootSetResponse
} from '@cupboard/shared';
import { describe, expect, it } from 'vitest';

import { CupboardClient, type TokenProvider } from './client.ts';
import {
	MalformedResponseError,
	ResponseSchemaMismatchError
} from './errors.ts';

interface CapturedRequest {
	readonly url: string;
	readonly method: string | undefined;
	readonly authorization: string | undefined;
	readonly contentType: string | undefined;
	readonly body: unknown;
}

function capturingClient(response: unknown): {
	readonly client: CupboardClient;
	readonly captured: () => CapturedRequest | undefined;
} {
	let captured: CapturedRequest | undefined;

	const client = new CupboardClient(
		new URL('https://cupboard.test'),
		(input, init) => {
			if (!(input instanceof URL)) {
				throw new TypeError('expected the client to request a URL');
			}

			const headers = new Headers(init?.headers);
			captured = {
				url: input.href,
				method: init?.method,
				authorization: headers.get('authorization') ?? undefined,
				contentType: headers.get('content-type') ?? undefined,
				body: init?.body
			};

			return Promise.resolve(Response.json(response));
		}
	);

	return { client, captured: () => captured };
}

describe('CupboardClient.bootstrap', () => {
	it('posts to /auth/bootstrap with the bootstrap secret', async () => {
		const response: BootstrapResponse = {
			url: 'https://cupboard.test',
			publicKey: 'cupboard:abc',
			token: 'admin-jwt'
		};
		const { client, captured } = capturingClient(response);

		const result = await client.bootstrap('bootstrap-secret');

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/auth/bootstrap',
			method: 'POST',
			authorization: 'Bearer bootstrap-secret',
			contentType: undefined,
			body: undefined
		});
	});
});

describe('CupboardClient.deleteStorePath', () => {
	it('deletes the store path hash with the admin token', async () => {
		const response: DeletePathResponse = {
			storePathHash: '0123456789abcdfghijklmnpqrsvwxyz',
			deleted: true,
			narScheduledForDeletion: true
		};
		const { client, captured } = capturingClient(response);

		const result = await client.deleteStorePath(
			'admin-token',
			'0123456789abcdfghijklmnpqrsvwxyz'
		);

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/paths/0123456789abcdfghijklmnpqrsvwxyz',
			method: 'DELETE',
			authorization: 'Bearer admin-token',
			contentType: undefined,
			body: undefined
		});
	});
});

describe('CupboardClient.setRoot', () => {
	it('puts the root body with the admin token, encoding the name in the path', async () => {
		const name = 'github:owner/repo/main';
		const body: RootSetBody = {
			targets: ['/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'],
			ttlSeconds: 604_800
		};
		const response: RootSetResponse = {
			name,
			expiresAt: '2026-01-08T00:00:00.000Z',
			expired: false,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			targets: [
				{
					storePathHash: '0123456789abcdfghijklmnpqrsvwxyz',
					storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
					present: true
				}
			]
		};
		const { client, captured } = capturingClient(response);

		const result = await client.setRoot('admin-token', name, body);

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/roots/github%3Aowner%2Frepo%2Fmain',
			method: 'PUT',
			authorization: 'Bearer admin-token',
			contentType: 'application/json',
			body: JSON.stringify(body)
		});
	});
});

describe('CupboardClient.listRoots', () => {
	it('gets the roots with the admin token and no body', async () => {
		const response: RootListResponse = { roots: [] };
		const { client, captured } = capturingClient(response);

		const result = await client.listRoots('admin-token');

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/roots',
			method: 'GET',
			authorization: 'Bearer admin-token',
			contentType: undefined,
			body: undefined
		});
	});
});

describe('CupboardClient.removeRoot', () => {
	it('deletes the root by name with the admin token, encoding the name in the path', async () => {
		const response: RootRemoveResponse = {
			name: 'pr-123',
			removed: true
		};
		const { client, captured } = capturingClient(response);

		const result = await client.removeRoot('admin-token', 'pr-123');

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/roots/pr-123',
			method: 'DELETE',
			authorization: 'Bearer admin-token',
			contentType: undefined,
			body: undefined
		});
	});
});

describe('CupboardClient response validation', () => {
	it('rejects a response that does not match the schema', async () => {
		const { client } = capturingClient({
			storePathHash: 'not-a-valid-hash',
			deleted: true,
			narScheduledForDeletion: true
		});

		await expect(
			client.deleteStorePath('admin-token', '0123456789abcdfghijklmnpqrsvwxyz')
		).rejects.toThrow(ResponseSchemaMismatchError);
	});

	it('rejects a response missing a required field', async () => {
		const { client } = capturingClient({ roots: [{ name: 'pr-1' }] });

		await expect(client.listRoots('admin-token')).rejects.toThrow(
			ResponseSchemaMismatchError
		);
	});

	it('rejects a 200 response whose body is not valid JSON', async () => {
		const client = new CupboardClient(new URL('https://cupboard.test'), () =>
			Promise.resolve(new Response('{ not json', { status: 200 }))
		);

		await expect(client.listRoots('admin-token')).rejects.toThrow(
			MalformedResponseError
		);
	});
});

describe('CupboardClient token refresh', () => {
	it('refreshes the token and retries once when a provider call returns 401', async () => {
		const authorisations: (string | undefined)[] = [];
		const provider: TokenProvider = {
			get: () => Promise.resolve('stale-token'),
			refresh: () => Promise.resolve('fresh-token')
		};
		let calls = 0;
		const client = new CupboardClient(
			new URL('https://cupboard.test'),
			(_input, init) => {
				authorisations.push(
					new Headers(init?.headers).get('authorization') ?? undefined
				);
				calls += 1;

				if (calls === 1) {
					return Promise.resolve(
						new Response('Unauthorised\n', { status: 401 })
					);
				}

				return Promise.resolve(
					Response.json({ roots: [] } satisfies RootListResponse)
				);
			}
		);

		const result = await client.listRoots(provider);

		expect({ result, authorisations }).toStrictEqual({
			result: { roots: [] },
			authorisations: ['Bearer stale-token', 'Bearer fresh-token']
		});
	});

	it('does not retry a fixed string token on 401', async () => {
		let calls = 0;
		const client = new CupboardClient(new URL('https://cupboard.test'), () => {
			calls += 1;

			return Promise.resolve(new Response('Unauthorised\n', { status: 401 }));
		});

		await expect(client.listRoots('static-token')).rejects.toThrow();
		expect(calls).toBe(1);
	});
});
