import type {
	DeletePathResponse,
	RootListResponse,
	RootRemoveResponse,
	RootSetRequestFields,
	RootSetResponse
} from '@cupboard/shared';
import { describe, expect, it } from 'vitest';

import { CupboardClient } from './client.ts';

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

describe('CupboardClient.deleteStorePath', () => {
	it('posts the store path hash with the admin token', async () => {
		const response: DeletePathResponse = {
			storePathHash: '0123456789abcdfghijklmnpqrsvwxyz',
			deleted: true,
			narScheduledForDeletion: true
		};
		let captured:
			| {
					readonly url: string;
					readonly method: string | undefined;
					readonly authorization: string | null;
					readonly contentType: string | null;
					readonly body: unknown;
			  }
			| undefined;

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
					authorization: headers.get('authorization'),
					contentType: headers.get('content-type'),
					body: init?.body
				};

				return Promise.resolve(Response.json(response));
			}
		);

		const result = await client.deleteStorePath(
			'admin-token',
			'0123456789abcdfghijklmnpqrsvwxyz'
		);

		expect(result).toStrictEqual(response);
		expect(captured).toStrictEqual({
			url: 'https://cupboard.test/admin/delete',
			method: 'POST',
			authorization: 'Bearer admin-token',
			contentType: 'application/json',
			body: JSON.stringify({
				storePathHash: '0123456789abcdfghijklmnpqrsvwxyz'
			})
		});
	});
});

describe('CupboardClient.setRoot', () => {
	it('posts the root fields with the admin token', async () => {
		const fields: RootSetRequestFields = {
			name: 'github:owner/repo/main',
			targets: ['/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'],
			ttlSeconds: 604_800
		};
		const response: RootSetResponse = {
			name: fields.name,
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

		const result = await client.setRoot('admin-token', fields);

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/admin/roots',
			method: 'POST',
			authorization: 'Bearer admin-token',
			contentType: 'application/json',
			body: JSON.stringify(fields)
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
			url: 'https://cupboard.test/admin/roots',
			method: 'GET',
			authorization: 'Bearer admin-token',
			contentType: undefined,
			body: undefined
		});
	});
});

describe('CupboardClient.removeRoot', () => {
	it('posts the root name with the admin token', async () => {
		const response: RootRemoveResponse = {
			name: 'pr-123',
			removed: true
		};
		const { client, captured } = capturingClient(response);

		const result = await client.removeRoot('admin-token', 'pr-123');

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/admin/roots/remove',
			method: 'POST',
			authorization: 'Bearer admin-token',
			contentType: 'application/json',
			body: JSON.stringify({ name: 'pr-123' })
		});
	});
});
