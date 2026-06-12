import type {
	AttestationAttachResponse,
	AttestationNegotiateResponse,
	AttestationPrepareResponse
} from '@cupboard/protocol/attestations';
import type {
	CacheRemoveResponse,
	CacheSummary
} from '@cupboard/protocol/caches';
import type {
	KeyRetireResponse,
	KeyRotateResponse
} from '@cupboard/protocol/keys';
import type { TokenResponse } from '@cupboard/protocol/oidc';
import type { CheckReport } from '@cupboard/protocol/reports';
import type {
	RetentionPolicyRemoveResponse,
	RetentionPolicySummary,
	RootListResponse,
	RootRemoveResponse,
	RootSetBody,
	RootSetResponse
} from '@cupboard/protocol/retention';
import type { SignupResponse } from '@cupboard/protocol/signup';
import type {
	DeletePathResponse,
	UploadStatusResponse
} from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import {
	CupboardHttpError,
	InvalidCacheNameError,
	MalformedResponseError,
	ResponseSchemaMismatchError
} from '../errors.ts';

import { CupboardClient, type TokenProvider } from './client.ts';

interface CapturedRequest {
	readonly url: string;
	readonly method: string | undefined;
	readonly authorization: string | undefined;
	readonly contentType: string | undefined;
	readonly body: unknown;
}

function capturingClient(
	response: unknown,
	cachePrefix = ''
): {
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
		},
		cachePrefix
	);

	return { client, captured: () => captured };
}

describe('CupboardClient.tokenExchange', () => {
	it('posts a urlencoded token-exchange request and returns the parsed token', async () => {
		const response: TokenResponse = {
			access_token: 'write-jwt',
			token_type: 'Bearer',
			expires_in: 900,
			scope: 'write',
			issued_token_type: 'urn:ietf:params:oauth:token-type:access_token'
		};
		const { client, captured } = capturingClient(response);

		const result = await client.tokenExchange(
			'subject.jwt',
			'urn:ietf:params:oauth:token-type:id_token'
		);

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/token',
			method: 'POST',
			authorization: undefined,
			contentType: 'application/x-www-form-urlencoded',
			body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token=subject.jwt&subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid_token'
		});
	});
});

describe('CupboardClient.signup', () => {
	const response: SignupResponse = {
		issuer: 'https://dash.cloudflare.com',
		subject: 'cf-user-1',
		claimed: true
	};

	it('posts a urlencoded claim and returns the established principal', async () => {
		const { client, captured } = capturingClient(response);

		const result = await client.signup({ subject_token: 'subject.jwt' });

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/signup',
			method: 'POST',
			authorization: undefined,
			contentType: 'application/x-www-form-urlencoded',
			body: 'subject_token=subject.jwt'
		});
	});

	it('sends the claim secret when one is given', async () => {
		const { client, captured } = capturingClient(response);

		await client.signup({
			subject_token: 'subject.jwt',
			claim_secret: 'secret-1'
		});

		expect(captured()?.body).toBe(
			'subject_token=subject.jwt&claim_secret=secret-1'
		);
	});

	it('throws a CupboardHttpError when the gate declines the claim', async () => {
		const client = new CupboardClient(new URL('https://cupboard.test'), () =>
			Promise.resolve(
				new Response('claimed by another principal', { status: 409 })
			)
		);

		await expect(
			client.signup({ subject_token: 'subject.jwt' })
		).rejects.toStrictEqual(
			new CupboardHttpError(
				'POST',
				'/signup',
				409,
				'claimed by another principal'
			)
		);
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

describe('CupboardClient.uploadStatus', () => {
	it('gets the deferred upload status with the write token', async () => {
		const response: UploadStatusResponse = { status: 'pending' };
		const { client, captured } = capturingClient(response);

		const result = await client.uploadStatus('write-token', 'upload-app');

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/uploads/upload-app/status',
			method: 'GET',
			authorization: 'Bearer write-token',
			contentType: undefined,
			body: undefined
		});
	});

	it('does not scope the status request through a named cache', async () => {
		const response: UploadStatusResponse = { status: 'servable' };
		const { client, captured } = capturingClient(response, '/cache/builds');

		const result = await client.uploadStatus('write-token', 'upload-build');

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/uploads/upload-build/status',
			method: 'GET',
			authorization: 'Bearer write-token',
			contentType: undefined,
			body: undefined
		});
	});
});

describe('CupboardClient attestation uploads', () => {
	it('negotiates attestations under the named cache path', async () => {
		const response: AttestationNegotiateResponse = {
			bundles: [
				{
					action: 'skip',
					storePathHash: '0123456789abcdfghijklmnpqrsvwxyz',
					digest:
						'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
				}
			]
		};
		const body = {
			bundles: [
				{
					storePathHash: '0123456789abcdfghijklmnpqrsvwxyz',
					digest:
						'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
				}
			]
		};
		const { client, captured } = capturingClient(response, '/cache/builds');

		const result = await client.negotiateAttestations('write-token', body);

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/cache/builds/attestations',
			method: 'POST',
			authorization: 'Bearer write-token',
			contentType: 'application/json',
			body: JSON.stringify(body)
		});
	});

	it('prepares and attaches an attestation under the named cache path', async () => {
		const prepareResponse: AttestationPrepareResponse = {
			uploadUrl: 'https://upload.example/attestation',
			uploadHeaders: {},
			expiresAt: '2026-05-18T12:00:00.000Z'
		};
		const attachResponse: AttestationAttachResponse = {
			storePathHash: '0123456789abcdfghijklmnpqrsvwxyz',
			digest:
				'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			predicateType: 'https://slsa.dev/provenance/v1',
			status: 'attached'
		};
		const requests: CapturedRequest[] = [];
		const client = new CupboardClient(
			new URL('https://cupboard.test'),
			(input, init) => {
				if (!(input instanceof URL)) {
					throw new TypeError('expected the client to request a URL');
				}

				const headers = new Headers(init?.headers);
				requests.push({
					url: input.href,
					method: init?.method,
					authorization: headers.get('authorization') ?? undefined,
					contentType: headers.get('content-type') ?? undefined,
					body: init?.body
				});

				return Promise.resolve(
					Response.json(
						requests.length === 1 ? prepareResponse : attachResponse
					)
				);
			},
			'/cache/builds'
		);

		const prepared = await client.prepareAttestation(
			'write-token',
			'attestation-app'
		);
		const attached = await client.attachAttestation(
			'write-token',
			'attestation-app'
		);

		expect({ prepared, attached, requests }).toStrictEqual({
			prepared: prepareResponse,
			attached: attachResponse,
			requests: [
				{
					url: 'https://cupboard.test/cache/builds/attestations/attestation-app',
					method: 'PUT',
					authorization: 'Bearer write-token',
					contentType: undefined,
					body: undefined
				},
				{
					url: 'https://cupboard.test/cache/builds/attestations/attestation-app/attach',
					method: 'POST',
					authorization: 'Bearer write-token',
					contentType: undefined,
					body: undefined
				}
			]
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

describe('CupboardClient.rotateKey', () => {
	it('posts to /keys/rotate with the admin token', async () => {
		const response: KeyRotateResponse = {
			rotated: {
				id: '123e4567-e89b-12d3-a456-426614174000',
				publicKey: 'cupboard-2:k2',
				stage: 'signing',
				createdAt: '2026-02-01T00:00:00.000Z'
			},
			keys: [
				{
					id: 'active',
					publicKey: 'cupboard-1:k1',
					stage: 'signing',
					createdAt: '2026-01-01T00:00:00.000Z'
				}
			]
		};
		const { client, captured } = capturingClient(response);

		const result = await client.rotateKey('admin-token');

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/keys/rotate',
			method: 'POST',
			authorization: 'Bearer admin-token',
			contentType: undefined,
			body: undefined
		});
	});
});

describe('CupboardClient.retireKey', () => {
	it('posts to /keys/retire/<id> with the admin token', async () => {
		const response: KeyRetireResponse = { id: 'active', stage: 'publication' };
		const { client, captured } = capturingClient(response);

		const result = await client.retireKey('admin-token', 'active');

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/keys/retire/active',
			method: 'POST',
			authorization: 'Bearer admin-token',
			contentType: undefined,
			body: undefined
		});
	});

	it('rejects a retire response with an unknown stage', async () => {
		const { client } = capturingClient({ id: 'active', stage: 'gone' });

		await expect(client.retireKey('admin-token', 'active')).rejects.toThrow(
			ResponseSchemaMismatchError
		);
	});
});

describe('CupboardClient cache registry', () => {
	it('puts a cache priority to /caches/<name>', async () => {
		const response: CacheSummary = {
			name: 'builds',
			priority: 30,
			storePaths: 0
		};
		const { client, captured } = capturingClient(response);

		const result = await client.putCache('admin-token', 'builds', 30);

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/caches/builds',
			method: 'PUT',
			authorization: 'Bearer admin-token',
			contentType: 'application/json',
			body: JSON.stringify({ priority: 30 })
		});
	});

	it('force-deletes a cache with a query flag and no prefix', async () => {
		const response: CacheRemoveResponse = {
			name: 'builds',
			removed: true,
			storePathsRemoved: 2
		};
		const { client, captured } = capturingClient(response, '/cache/builds');

		const result = await client.removeCache('admin-token', 'builds', true);

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/caches/builds?force=true',
			method: 'DELETE',
			authorization: 'Bearer admin-token',
			contentType: undefined,
			body: undefined
		});
	});

	it('rejects a cache list response that does not match the schema', async () => {
		const { client } = capturingClient({ caches: [{ name: 'builds' }] });

		await expect(client.listCaches('admin-token')).rejects.toThrow(
			ResponseSchemaMismatchError
		);
	});
});

describe('CupboardClient retention policies', () => {
	it('posts a policy to /policies', async () => {
		const response: RetentionPolicySummary = {
			id: 'p1',
			scope: 'root-name-prefix',
			pattern: 'pr-',
			ttlSeconds: 604_800
		};
		const { client, captured } = capturingClient(response);

		const result = await client.addPolicy('admin-token', {
			scope: 'root-name-prefix',
			pattern: 'pr-',
			ttlSeconds: 604_800
		});

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/policies',
			method: 'POST',
			authorization: 'Bearer admin-token',
			contentType: 'application/json',
			body: JSON.stringify({
				scope: 'root-name-prefix',
				pattern: 'pr-',
				ttlSeconds: 604_800
			})
		});
	});

	it('deletes a policy by id', async () => {
		const response: RetentionPolicyRemoveResponse = { id: 'p1', removed: true };
		const { client, captured } = capturingClient(response);

		const result = await client.removePolicy('admin-token', 'p1');

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/policies/p1',
			method: 'DELETE',
			authorization: 'Bearer admin-token',
			contentType: undefined,
			body: undefined
		});
	});

	it('rejects a policy list response that does not match the schema', async () => {
		const { client } = capturingClient({ policies: [{ id: 'p1' }] });

		await expect(client.listPolicies('admin-token')).rejects.toThrow(
			ResponseSchemaMismatchError
		);
	});
});

describe('CupboardClient check', () => {
	const report: CheckReport = {
		narInfosChecked: 1,
		narBlobsChecked: 1,
		complete: true,
		discrepancies: []
	};

	it.each([
		{ deep: false, url: 'https://cupboard.test/check' },
		{ deep: true, url: 'https://cupboard.test/check?deep=true' }
	])('requests /check with deep=$deep', async ({ deep, url }) => {
		const { client, captured } = capturingClient(report);

		const result = await client.check('admin-token', { deep });

		expect(result).toStrictEqual(report);
		expect(captured()).toStrictEqual({
			url,
			method: 'GET',
			authorization: 'Bearer admin-token',
			contentType: undefined,
			body: undefined
		});
	});

	it('rejects a check response that does not match the schema', async () => {
		const { client } = capturingClient({ narInfosChecked: -1 });

		await expect(client.check('admin-token', { deep: false })).rejects.toThrow(
			ResponseSchemaMismatchError
		);
	});
});

describe('CupboardClient cache prefix', () => {
	const statsResponse = {
		storePaths: 0,
		narBlobs: 0,
		narFileSize: 0,
		casObjects: 0,
		casFileSize: 0,
		pendingUploads: 0,
		totalFileSize: 0
	};
	const usageResponse = {
		narBlobs: 0,
		narFileSize: 0,
		casObjects: 0,
		casFileSize: 0,
		totalFileSize: 0
	};

	it('prepends the cache prefix to a path-scoped route', async () => {
		const { client, captured } = capturingClient(
			statsResponse,
			'/cache/builds'
		);

		await client.stats('admin-token');

		expect(captured()?.url).toBe('https://cupboard.test/cache/builds/stats');
	});

	it('leaves a path-scoped route bare for the default cache', async () => {
		const { client, captured } = capturingClient(statsResponse);

		await client.stats('admin-token');

		expect(captured()?.url).toBe('https://cupboard.test/stats');
	});

	it('does not prefix a deployment-wide route', async () => {
		const { client, captured } = capturingClient(
			'cupboard-1:k\n',
			'/cache/builds'
		);

		await client.publicKey();

		expect(captured()?.url).toBe('https://cupboard.test/pubkey');
	});

	it('leaves usage deployment-scoped under a cache prefix', async () => {
		const { client, captured } = capturingClient(
			usageResponse,
			'/cache/builds'
		);

		await client.usage('admin-token');

		expect(captured()?.url).toBe('https://cupboard.test/usage');
	});

	it('rejects an invalid cache name when building a scoped client', () => {
		expect(() =>
			CupboardClient.fromUrl('https://cupboard.test', 'Bad!')
		).toThrow(InvalidCacheNameError);
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
