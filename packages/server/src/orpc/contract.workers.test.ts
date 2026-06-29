import { DEFAULT_CACHE } from '@cupboard/nix-store/scalars';
import { attestationUploadDecisionSchema } from '@cupboard/protocol/attestations';
import { tenantContract } from '@cupboard/protocol/contract';
import { uploadActionDecisionSchema } from '@cupboard/protocol/upload';
import { createORPCClient, ORPCError, safe } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { ResponseValidationPlugin } from '@orpc/contract/plugins';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
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
	resetTestServer,
	sigstoreBundleBytes,
	testPushId,
	uploadBlobMetadata,
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

	it('drives the cache registry through the derived client', async () => {
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
			created: { name: 'builds', priority: 30, storePaths: 0 },
			listed: {
				caches: [
					{ name: '', priority: 40, storePaths: 0 },
					{ name: 'builds', priority: 30, storePaths: 0 }
				]
			},
			removed: { name: 'builds', removed: true, storePathsRemoved: 0 }
		});
	});

	it('answers a refused teardown as the defined CACHE_NOT_EMPTY error', async () => {
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

	it('drives both key sets through the derived client', async () => {
		await useTestServer('contract-keys');
		const init = await bootstrap();
		const client = tenantClient(init.token);

		const rotated = await client.keys.signing.rotate();
		const retired = await client.keys.signing.retire({
			id: rotated.rotated.id
		});
		const authRotated = await client.keys.auth.rotate();
		const authRetiring = z
			.object({ kid: z.string(), scheduledRetireAt: z.string() })
			.parse(authRotated.retiring);
		const authListed = await client.keys.auth.list();

		expect({
			retired,
			signingKeys: rotated.keys.map((key) => ({
				id: key.id,
				stage: key.stage
			})),
			authKeys: authListed.keys
				.map((key) => ({
					kid: key.kid,
					active: key.active
				}))
				.toSorted((left, right) => left.kid.localeCompare(right.kid))
		}).toStrictEqual({
			retired: { id: rotated.rotated.id, stage: 'publication' },
			signingKeys: [
				{
					id: 'active',
					stage: 'signing'
				},
				{
					id: rotated.rotated.id,
					stage: 'signing'
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

	it('drives policies and trust rules through the derived client', async () => {
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

	it('drives roots, path deletion and gc through the derived client', async () => {
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
		const listed = await client.roots.list({ cacheName: '_default' });
		const removedRoot = await client.roots.remove({
			cacheName: '_default',
			name: 'github:owner/repo/main'
		});
		const removedPath = await client.paths.remove({
			cacheName: '_default',
			hash: metadata.storePathHash
		});
		const swept = await client.gc.runAll();

		expect({
			setTargets: set.targets.map((entry) => entry.present),
			listedNames: listed.roots.map((entry) => entry.name),
			removedRoot,
			removedPath: {
				deleted: removedPath.deleted,
				storePathHash: removedPath.storePathHash
			},
			sweptOk: swept.ok
		}).toStrictEqual({
			setTargets: [true],
			listedNames: ['github:owner/repo/main'],
			removedRoot: { name: 'github:owner/repo/main', removed: true },
			removedPath: { deleted: true, storePathHash: metadata.storePathHash },
			sweptOk: true
		});
	});

	it('drives upload negotiation and preparation through the derived client', async () => {
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

		const prepared = await client.uploads.prepare({
			cacheName: '_default',
			id: decision.uploadId,
			...uploadBlobMetadata(metadata)
		});
		const status = await client.uploads.status({ id: decision.uploadId });

		expect({
			storePathHash: decision.storePathHash,
			presigned: prepared.uploadUrl.length > 0,
			status
		}).toStrictEqual({
			storePathHash: metadata.storePathHash,
			presigned: true,
			status: { status: 'pending' }
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
			pushIdShape: /^[0-9a-f]{96}$/.test(issued.pushId),
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

		await expect(
			client.uploads.credential({
				cacheName: '_default',
				pushId: 'f'.repeat(96)
			})
		).rejects.toThrow();
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
			bundles: [{ storePathHash: metadata.storePathHash, digest }]
		});
		const decision = attestationUploadDecisionSchema
			.array()
			.length(1)
			.transform(([decision]) =>
				attestationUploadDecisionSchema.parse(decision)
			)
			.parse(negotiated.bundles);

		const prepared = await client.attestations.prepare({
			cacheName: '_default',
			id: decision.uploadId
		});
		await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });
		const attached = await client.attestations.attach({
			cacheName: '_default',
			id: decision.uploadId
		});

		expect({
			presigned: prepared.uploadUrl.length > 0,
			attached
		}).toStrictEqual({
			presigned: true,
			attached: {
				storePathHash: metadata.storePathHash,
				digest,
				predicateType: 'https://slsa.dev/provenance/v1',
				status: 'attached'
			}
		});
	});

	it('refuses a write-scoped token on an admin procedure', async () => {
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
