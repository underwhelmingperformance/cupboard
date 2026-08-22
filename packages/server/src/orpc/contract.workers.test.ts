import { DEFAULT_CACHE, signingKeyIdSchema } from '@cupboard/nix-store/scalars';
import { attestationUploadDecisionSchema } from '@cupboard/protocol/attestations';
import { tenantContract } from '@cupboard/protocol/contract';
import { uploadActionDecisionSchema } from '@cupboard/protocol/upload';
import { createORPCClient, ORPCError, safe } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { ResponseValidationPlugin } from '@orpc/contract/plugins';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { sha256HexBytes } from '../crypto/crypto.ts';
import {
	bootstrap,
	cacheWriteGrants,
	currentOrigin,
	currentServer,
	hexBytes,
	issueServerSignedToken,
	narBytes,
	narDigestHex,
	pushPath,
	putNarBytes,
	resetTestServer,
	sigstoreBundleBytes,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation,
	useTestServer,
	verifiableNar
} from '../test-support.ts';

type TenantClient = JsonifiedClient<
	ContractRouterClient<typeof tenantContract>
>;

// The real derived client, exactly as the CLI builds it: the OpenAPI link over
// the contract, with responses validated against the contract's output
// schemas. Requests reach the Durable Object the harness targets, so the lock
// covers the mounted handler, the middleware chain and the services.
function tenantClient(token: string): TenantClient {
	const link = new OpenAPILink(tenantContract, {
		url: currentOrigin(),
		headers: { authorization: `Bearer ${token}` },
		fetch: (request) => currentServer().fetch(request),
		plugins: [new ResponseValidationPlugin(tenantContract)]
	});

	return createORPCClient(link);
}

describe('tenant contract round trip', () => {
	beforeEach(resetTestServer);

	it('creates, lists, and removes caches through the derived client', async () => {
		await useTestServer('contract-caches');
		const init = await bootstrap();
		const client = tenantClient(init.token);

		const created = await client.caches.put({
			cacheName: 'builds',
			priority: 30
		});
		const listed = await client.caches.list();
		const removed = await client.caches.remove({
			params: { cacheName: 'builds' }
		});

		expect({ created, listed, removed }).toStrictEqual({
			created: {
				name: 'builds',
				priority: 30,
				storePaths: 0,
				graceManaged: false
			},
			listed: {
				caches: [
					{ name: '', priority: 40, storePaths: 0, graceManaged: false },
					{ name: 'builds', priority: 30, storePaths: 0, graceManaged: false }
				]
			},
			removed: { name: 'builds', removed: true, storePathsRemoved: 0 }
		});
	});

	it('hardens every matched tenant response and Bearer challenge', async () => {
		await useTestServer('contract-response-headers');
		const init = await bootstrap();
		const cachesUrl = new URL('/caches', currentOrigin());
		const authorised = await currentServer().fetch(
			new Request(cachesUrl, {
				headers: { authorization: `Bearer ${init.token}` }
			})
		);
		const unauthorised = await currentServer().fetch(new Request(cachesUrl));

		expect({
			authorised: {
				status: authorised.status,
				cacheControl: authorised.headers.get('cache-control')
			},
			unauthorised: {
				status: unauthorised.status,
				cacheControl: unauthorised.headers.get('cache-control'),
				challenge: unauthorised.headers.get('www-authenticate')
			}
		}).toStrictEqual({
			authorised: { status: StatusCodes.OK, cacheControl: 'no-store' },
			unauthorised: {
				status: StatusCodes.UNAUTHORIZED,
				cacheControl: 'no-store',
				challenge: 'Bearer'
			}
		});
	});

	it('returns CACHE_NOT_EMPTY when cache removal requires force', async () => {
		await useTestServer('contract-cache-not-empty');
		const init = await bootstrap();
		const client = tenantClient(init.token);
		await pushPath(
			init.token,
			uploadMetadata({ fileSize: narBytes.byteLength }),
			'builds'
		);

		const [error, data, isDefined] = await safe(
			client.caches.remove({ params: { cacheName: 'builds' } })
		);
		const forced = await client.caches.remove({
			params: { cacheName: 'builds' },
			query: { force: true }
		});

		expect({ isDefined, data, forced }).toStrictEqual({
			isDefined: true,
			data: undefined,
			forced: { name: 'builds', removed: true, storePathsRemoved: 1 }
		});
		expect(error).toBeInstanceOf(ORPCError);
		expect(error).toMatchObject({
			defined: true,
			code: 'CACHE_NOT_EMPTY',
			status: StatusCodes.CONFLICT,
			data: { cache: 'builds' }
		});
	});

	it('rotates and lists both key sets through the derived client', async () => {
		await useTestServer('contract-keys');
		const init = await bootstrap();
		const client = tenantClient(init.token);

		const rotated = await client.keys.signing.rotate();
		await runInDurableObject(currentServer(), (instance) => instance.alarm());
		const retired = await client.keys.signing.retire({
			id: rotated.rotated.key.id
		});
		const authRotated = await client.keys.auth.rotate();
		const authRetiring = z
			.object({ kid: z.string(), scheduledRetireAt: z.string() })
			.parse(authRotated.retiring);
		const authListed = await client.keys.auth.list();

		expect({
			retired,
			signingKeys: rotated.keys.map((entry) => ({
				id: entry.key.id,
				state: entry.state
			})),
			authKeys: authListed.keys
				.map((key) => ({
					kid: key.kid,
					active: key.active
				}))
				.toSorted((left, right) => left.kid.localeCompare(right.kid))
		}).toStrictEqual({
			retired: { id: rotated.rotated.key.id, state: 'published-only' },
			signingKeys: [
				{
					id: 'active',
					state: 'signing'
				},
				{
					id: rotated.rotated.key.id,
					state: 'signing'
				}
			],
			authKeys: [
				{
					kid: authRotated.rotated,
					active: true
				},
				{
					kid: authRetiring.kid,
					active: false
				}
			].toSorted((left, right) => left.kid.localeCompare(right.kid))
		});
	});

	it('returns signing-key rotation conflicts as defined contract errors', async () => {
		await useTestServer('contract-key-conflicts');
		const init = await bootstrap();
		await pushPath(
			init.token,
			uploadMetadata({
				fileSize: narBytes.byteLength,
				storePathHash: 'd'.repeat(32),
				name: 'before-rotation'
			})
		);
		const client = tenantClient(init.token);
		const rotated = await client.keys.signing.rotate();

		const [rotateError, rotateData, rotateDefined] = await safe(
			client.keys.signing.rotate()
		);
		const [retireError, retireData, retireDefined] = await safe(
			client.keys.signing.retire({ id: rotated.rotated.key.id })
		);
		const [abortError, abortData, abortDefined] = await safe(
			client.keys.signing.abort({ id: 'active' })
		);
		if (
			!(rotateError instanceof ORPCError) ||
			!(retireError instanceof ORPCError) ||
			!(abortError instanceof ORPCError)
		) {
			throw new Error('Expected each signing-key conflict to be an ORPCError');
		}
		const conflictSchema = z.object({
			defined: z.literal(true),
			code: z.enum([
				'SIGNING_KEY_ROTATION_IN_PROGRESS',
				'SIGNING_KEY_BACKFILL_INCOMPLETE',
				'SIGNING_KEY_ROTATION_ABORT_NOT_ALLOWED'
			]),
			status: z.literal(StatusCodes.CONFLICT),
			data: z.object({ id: signingKeyIdSchema })
		});

		expect({
			rotate: {
				defined: rotateDefined,
				data: rotateData,
				error: conflictSchema.parse(rotateError)
			},
			retire: {
				defined: retireDefined,
				data: retireData,
				error: conflictSchema.parse(retireError)
			},
			abort: {
				defined: abortDefined,
				data: abortData,
				error: conflictSchema.parse(abortError)
			}
		}).toStrictEqual({
			rotate: {
				defined: true,
				data: undefined,
				error: {
					defined: true,
					code: 'SIGNING_KEY_ROTATION_IN_PROGRESS',
					status: StatusCodes.CONFLICT,
					data: { id: rotated.rotated.key.id }
				}
			},
			retire: {
				defined: true,
				data: undefined,
				error: {
					defined: true,
					code: 'SIGNING_KEY_BACKFILL_INCOMPLETE',
					status: StatusCodes.CONFLICT,
					data: { id: rotated.rotated.key.id }
				}
			},
			abort: {
				defined: true,
				data: undefined,
				error: {
					defined: true,
					code: 'SIGNING_KEY_ROTATION_ABORT_NOT_ALLOWED',
					status: StatusCodes.CONFLICT,
					data: { id: 'active' }
				}
			}
		});
	});

	it('creates policies and trust rules through the derived client', async () => {
		await useTestServer('contract-policies-trust');
		const init = await bootstrap();
		const client = tenantClient(init.token);

		const policy = await client.policies.add({
			scope: 'root-name-prefix',
			pattern: 'pr-',
			ttlSeconds: 604_800
		});
		const policies = await client.policies.list();
		const policyRemoved = await client.policies.remove({ id: policy.id });

		const rule = await client.oidcTrust.add({
			issuer: 'https://token.actions.githubusercontent.com',
			audience: 'https://cache.example.workers.dev',
			claims: { repository_owner_id: '5678' },
			permittedGrants: [
				{
					type: 'cupboard_cache',
					actions: ['upload:commit'],
					resources: { cache: { exact: 'ci', validate: 'cacheName' } }
				}
			]
		});
		const ruleRemoved = await client.oidcTrust.remove({ id: rule.id });

		expect({
			policyListed: policies.policies.map((entry) => entry.id),
			policyRemoved,
			ruleGrants: rule.permittedGrants.length,
			ruleRemoved
		}).toStrictEqual({
			policyListed: [policy.id],
			policyRemoved: { id: policy.id, removed: true },
			ruleGrants: 1,
			ruleRemoved: { id: rule.id, removed: true }
		});
	});

	it('serves stats, usage and check, addressing the default cache as _default', async () => {
		await useTestServer('contract-stats');
		const init = await bootstrap();
		const client = tenantClient(init.token);
		await pushPath(
			init.token,
			uploadMetadata({ fileSize: narBytes.byteLength })
		);

		const stats = await client.stats.cache({ cacheName: '_default' });
		const usage = await client.stats.usage();
		const report = await client.check.run({ deep: true });

		expect({
			storePaths: stats.storePaths,
			chargedBlobs: usage.narBlobs,
			report: {
				narInfosChecked: report.narInfosChecked,
				complete: report.complete,
				discrepancies: report.discrepancies
			}
		}).toStrictEqual({
			storePaths: 1,
			chargedBlobs: 1,
			report: { narInfosChecked: 1, complete: true, discrepancies: [] }
		});
	});

	it('updates roots, deletes paths, and runs GC through the derived client', async () => {
		await useTestServer('contract-roots');
		const init = await bootstrap();
		const client = tenantClient(init.token);
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(init.token, metadata);

		const set = await client.roots.set({
			cacheName: '_default',
			name: 'github:owner/repo/main',
			targets: [metadata.storePath]
		});
		const listed = await client.roots.list({
			params: { cacheName: '_default' }
		});
		const targetsPage = await client.roots.targets({
			params: { cacheName: '_default', name: 'github:owner/repo/main' },
			query: { limit: 1 }
		});
		const removedRoot = await client.roots.remove({
			cacheName: '_default',
			name: 'github:owner/repo/main'
		});
		const removedPath = await client.paths.remove({
			cacheName: '_default',
			hash: metadata.storePathHash
		});
		const collected = await client.gc.runAll();

		expect({
			setTargets: set.targets.map((entry) => entry.present),
			listed: listed.roots.map((entry) => ({
				name: entry.name,
				targetCount: entry.targetCount
			})),
			targetsPage,
			removedRoot,
			removedPath: {
				deleted: removedPath.deleted,
				storePathHash: removedPath.storePathHash
			},
			collectedOk: collected.ok
		}).toStrictEqual({
			setTargets: [true],
			listed: [{ name: 'github:owner/repo/main', targetCount: 1 }],
			targetsPage: {
				targets: [
					{
						storePathHash: metadata.storePathHash,
						storePath: metadata.storePath,
						present: true
					}
				]
			},
			removedRoot: { name: 'github:owner/repo/main', removed: true },
			removedPath: { deleted: true, storePathHash: metadata.storePathHash },
			collectedOk: true
		});
	});

	it('negotiates an upload and obtains staging credentials through the derived client', async () => {
		await useTestServer('contract-uploads');
		const init = await bootstrap();
		const client = tenantClient(init.token);
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		const negotiated = await client.uploads.negotiate({
			cacheName: '_default',
			pushId: testPushId,
			paths: [uploadPathNegotiation(metadata)]
		});
		const decision = uploadActionDecisionSchema
			.array()
			.length(1)
			.transform(([decision]) => uploadActionDecisionSchema.parse(decision))
			.parse(negotiated.uploads);

		await putNarBytes(decision.r2Key);
		const status = await client.uploads.status({ id: decision.uploadId });

		expect({
			storePathHash: decision.storePathHash,
			r2Key: decision.r2Key.length > 0,
			status
		}).toStrictEqual({
			storePathHash: metadata.storePathHash,
			r2Key: true,
			status: { status: 'pending' }
		});
	});

	it('rejects upload negotiation under a forged push id', async () => {
		await useTestServer('contract-uploads-forged');
		const init = await bootstrap();
		const client = tenantClient(init.token);
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		const [error] = await safe(
			client.uploads.negotiate({
				cacheName: '_default',
				pushId: 'f'.repeat(96),
				paths: [uploadPathNegotiation(metadata)]
			})
		);

		expect(error).toBeInstanceOf(ORPCError);
		expect(error).toMatchObject({
			code: 'FORBIDDEN',
			status: StatusCodes.FORBIDDEN
		});
	});

	it('issues, refreshes and bounds a push credential to the token', async () => {
		await useTestServer('contract-credential');
		const init = await bootstrap();
		const client = tenantClient(init.token);

		const issued = await client.uploads.credential({ cacheName: '_default' });
		const refreshed = await client.uploads.credential({
			cacheName: '_default',
			pushId: issued.pushId
		});

		const expiresInSeconds =
			(new Date(issued.expiresAt).getTime() - Date.now()) / 1000;

		expect({
			pushIdShape: /^[0-9a-f]{104}$/u.test(issued.pushId),
			bucket: issued.bucket,
			endpoint: issued.endpoint,
			hasCredential:
				issued.accessKeyId.length > 0 &&
				issued.secretAccessKey.length > 0 &&
				issued.sessionToken.length > 0,
			// The admin token lives 600s, far under the six-hour cap, so a credential
			// bounded to the token lands well under an hour.
			boundToToken: expiresInSeconds > 0 && expiresInSeconds < 700,
			refreshKeepsPrefix: refreshed.pushId === issued.pushId
		}).toStrictEqual({
			pushIdShape: true,
			bucket: 'cupboard-blobs',
			endpoint: 'https://test-account-id.r2.cloudflarestorage.com',
			hasCredential: true,
			boundToToken: true,
			refreshKeepsPrefix: true
		});

		const [forgedError] = await safe(
			client.uploads.credential({
				cacheName: '_default',
				pushId: 'f'.repeat(96)
			})
		);

		expect(forgedError).toBeInstanceOf(ORPCError);
		expect(forgedError).toMatchObject({
			code: 'FORBIDDEN',
			status: StatusCodes.FORBIDDEN
		});
	});

	it('attaches an attestation bundle through the derived client', async () => {
		await useTestServer('contract-attestations');
		const init = await bootstrap();
		const client = tenantClient(init.token);
		const nar = await verifiableNar('contract-attestation');
		const metadata = uploadMetadata({
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await pushPath(init.token, metadata, DEFAULT_CACHE, nar);

		const bundle = sigstoreBundleBytes(narDigestHex(nar.narHash));
		const digest = await sha256HexBytes(bundle);
		const negotiated = await client.attestations.negotiate({
			cacheName: '_default',
			pushId: testPushId,
			bundles: [{ storePathHash: metadata.storePathHash, digest }]
		});
		const decision = attestationUploadDecisionSchema
			.array()
			.length(1)
			.transform(([decision]) =>
				attestationUploadDecisionSchema.parse(decision)
			)
			.parse(negotiated.bundles);

		await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });
		const attached = await client.attestations.attach({
			cacheName: '_default',
			id: decision.uploadId
		});

		expect(attached).toStrictEqual({
			storePathHash: metadata.storePathHash,
			digest,
			predicateType: 'https://slsa.dev/provenance/v1',
			status: 'attached'
		});
	});

	it('rejects attestation negotiation under a forged push id', async () => {
		await useTestServer('contract-attestations-forged');
		const init = await bootstrap();
		const client = tenantClient(init.token);

		const [error] = await safe(
			client.attestations.negotiate({
				cacheName: '_default',
				pushId: 'f'.repeat(96),
				bundles: [{ storePathHash: 'a'.repeat(32), digest: 'b'.repeat(64) }]
			})
		);

		expect(error).toBeInstanceOf(ORPCError);
		expect(error).toMatchObject({
			code: 'FORBIDDEN',
			status: StatusCodes.FORBIDDEN
		});
	});

	it('rejects a write-scoped token on an admin procedure', async () => {
		await useTestServer('contract-scope');
		await bootstrap();
		const client = tenantClient(
			await issueServerSignedToken(cacheWriteGrants())
		);

		const [error, data, isDefined] = await safe(client.caches.list());
		expect({ isDefined, data }).toStrictEqual({
			isDefined: true,
			data: undefined
		});
		expect(error).toBeInstanceOf(ORPCError);
		expect(error).toMatchObject({
			defined: true,
			code: 'FORBIDDEN',
			status: StatusCodes.FORBIDDEN
		});
	});
});
