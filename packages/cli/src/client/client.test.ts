import type {
	AttestationAttachResponse,
	AttestationNegotiateResponse,
	AttestationPrepareResponse
} from '@cupboard/protocol/attestations';
import type { TokenResponse } from '@cupboard/protocol/oidc';
import type {
	RootListResponse,
	RootRemoveResponse,
	RootSetBody,
	RootSetResponse
} from '@cupboard/protocol/retention';
import type { SignupResponse } from '@cupboard/protocol/signup';
import type {
	CommitSocketFrame,
	DeletePathResponse
} from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import {
	CupboardHttpError,
	InvalidCacheNameError,
	MalformedResponseError,
	ResponseSchemaMismatchError
} from '../errors.ts';

import { CupboardClient, type TokenProvider } from './client.ts';
import {
	FakeCommitSocket,
	FakeUpgradeFailure
} from './commit-socket.test-support.ts';

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

	it('posts a urlencoded refresh and returns the rotated session tokens', async () => {
		const response: TokenResponse = {
			access_token: 'admin-jwt-2',
			token_type: 'Bearer',
			expires_in: 600,
			scope: 'admin',
			refresh_token: 'refresh-2'
		};
		const { client, captured } = capturingClient(response);

		const result = await client.tokenRefresh('refresh-1');

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/token',
			method: 'POST',
			authorization: undefined,
			contentType: 'application/x-www-form-urlencoded',
			body: 'grant_type=refresh_token&refresh_token=refresh-1'
		});
	});

	it('passes a configured abort signal to the token exchange request', async () => {
		const controller = new AbortController();
		let signal: AbortSignal | null | undefined;
		const response: TokenResponse = {
			access_token: 'write-jwt',
			token_type: 'Bearer',
			expires_in: 900,
			scope: 'write',
			issued_token_type: 'urn:ietf:params:oauth:token-type:access_token'
		};
		const client = new CupboardClient(
			new URL('https://cupboard.test'),
			(_input, init) => {
				signal = init?.signal;

				return Promise.resolve(Response.json(response));
			},
			'',
			controller.signal
		);

		await client.tokenExchange(
			'subject.jwt',
			'urn:ietf:params:oauth:token-type:id_token'
		);

		expect(signal).toBe(controller.signal);
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

interface CapturedConnection {
	readonly url: string;
	readonly authorization: string | undefined;
}

// A client whose commit sockets are scripted: the nth connection plays the nth
// script against its listeners once they are attached.
function commitClient(
	scripts: readonly ((socket: FakeCommitSocket) => void)[],
	cachePrefix = ''
): {
	readonly client: CupboardClient;
	readonly connections: () => readonly CapturedConnection[];
} {
	const connections: CapturedConnection[] = [];

	const client = new CupboardClient(
		new URL('https://cupboard.test'),
		fetch,
		cachePrefix,
		undefined,
		(url, headers) => {
			const script = scripts[connections.length];
			connections.push({
				url: url.href,
				authorization: headers.authorization
			});

			const socket = new FakeCommitSocket();

			if (script !== undefined) {
				queueMicrotask(() => {
					script(socket);
				});
			}

			return socket;
		}
	);

	return { client, connections: () => connections };
}

function sendFrame(socket: FakeCommitSocket, frame: CommitSocketFrame): void {
	socket.emit('message', JSON.stringify(frame));
}

describe('CupboardClient.commit', () => {
	const response = {
		storePathHash: '0123456789abcdfghijklmnpqrsvwxyz',
		narHash: `sha256:${'1'.repeat(52)}`,
		status: 'committed'
	} as const;

	it('commits over a wss socket carrying the bearer token on the upgrade', async () => {
		const { client, connections } = commitClient([
			(socket) => {
				sendFrame(socket, { event: 'result', response });
			}
		]);

		const result = await client.commit('write-token', 'upload-app');

		expect({ result, connections: connections() }).toStrictEqual({
			result: response,
			connections: [
				{
					url: 'wss://cupboard.test/uploads/upload-app/commit',
					authorization: 'Bearer write-token'
				}
			]
		});
	});

	it('scopes the commit socket through a named cache', async () => {
		const { client, connections } = commitClient(
			[
				(socket) => {
					sendFrame(socket, { event: 'result', response });
				}
			],
			'/cache/builds'
		);

		await client.commit('write-token', 'upload-build');

		expect(connections()).toStrictEqual([
			{
				url: 'wss://cupboard.test/cache/builds/uploads/upload-build/commit',
				authorization: 'Bearer write-token'
			}
		]);
	});

	it('refreshes the token and retries once when the upgrade is refused with a 401', async () => {
		const { client, connections } = commitClient([
			(socket) => {
				const refusal = new FakeUpgradeFailure(401);
				socket.emit('unexpected-response', {}, refusal);
				refusal.emit('end');
			},
			(socket) => {
				sendFrame(socket, { event: 'result', response });
			}
		]);
		const provider: TokenProvider = {
			get: () => Promise.resolve('stale-token'),
			refresh: () => Promise.resolve('fresh-token')
		};

		const result = await client.commit(provider, 'upload-app');

		expect({ result, connections: connections() }).toStrictEqual({
			result: response,
			connections: [
				{
					url: 'wss://cupboard.test/uploads/upload-app/commit',
					authorization: 'Bearer stale-token'
				},
				{
					url: 'wss://cupboard.test/uploads/upload-app/commit',
					authorization: 'Bearer fresh-token'
				}
			]
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

describe('CupboardClient cache prefix', () => {
	it('prepends the cache prefix to a path-scoped route', async () => {
		const hash = 'b6gz4hjcjafdvbmgmrasqcwwf4byqqlv';
		const { client, captured } = capturingClient(
			{
				storePathHash: hash,
				deleted: true,
				narScheduledForDeletion: false
			},
			'/cache/builds'
		);

		await client.deleteStorePath('admin-token', hash);

		expect(captured()?.url).toBe(
			`https://cupboard.test/cache/builds/paths/${hash}`
		);
	});

	it('does not prefix a deployment-wide route', async () => {
		const { client, captured } = capturingClient(
			'cupboard-1:k\n',
			'/cache/builds'
		);

		await client.publicKey();

		expect(captured()?.url).toBe('https://cupboard.test/pubkey');
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
