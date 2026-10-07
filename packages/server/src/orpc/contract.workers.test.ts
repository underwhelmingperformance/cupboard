import { rootLogger } from '@cupboard/logger';
import {
	cacheGenerationSchema,
	narInfoGenerationSchema,
	predicateTypeSchema,
	signingKeyIdSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	attestationAttachMaxPaths,
	attestationBundleDecisionSchema,
	attestationUploadDecisionSchema
} from '@cupboard/protocol/attestations';
import { tenantContract } from '@cupboard/protocol/contract';
import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import {
	oidcIssuerSchema,
	oidcSubjectSchema,
	trustRuleIdSchema
} from '@cupboard/protocol/oidc';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { uploadActionDecisionSchema } from '@cupboard/protocol/upload';
import { createORPCClient, ORPCError, safe } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { ResponseValidationPlugin } from '@orpc/contract/plugins';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
	vi
} from 'vitest';
import { z } from 'zod';

import { sha256HexBytes } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { AttestationCasService } from '../do/attestation-cas-service.ts';
import { AttestationsService } from '../do/attestations-service.ts';
import { CacheRegistrationService } from '../do/cache-registration-service.ts';
import { NarInfoObjectsService } from '../do/narinfo-objects-service.ts';
import {
	subrequestsAvailable,
	withSubrequestSlice
} from '../do/subrequest-slice.ts';
import { casObjectKey } from '../http/http.ts';
import { runCasReaper } from '../routing/scheduled.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	attestationReferenceRows,
	bootstrap,
	cacheWriteGrants,
	casObjectRows,
	currentCasObjectKey,
	currentOrigin,
	currentServer,
	defaultCache,
	hexBytes,
	issueServerSignedToken,
	namedCache,
	narBytes,
	narDigestHex,
	pushPath,
	putNarBytes,
	readFetch,
	recordTransition,
	resetTestServer,
	resolvedCache,
	sigstoreBundleBytes,
	testBase,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation,
	useTestServer,
	verifiableNar,
	withoutAlarmArming
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
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('refuses usage when the accounting row is missing', async () => {
		const init = await bootstrap();
		await env.CUPBOARD_DB.prepare('DELETE FROM tenant_usage WHERE tenant = ?')
			.bind(fixtureTenant)
			.run();
		await expect(tenantClient(init.token).stats.usage()).rejects.toMatchObject({
			status: 500
		});
	});

	it('creates, lists, and removes caches through the derived client', async () => {
		await useTestServer('contract-caches');
		const init = await bootstrap();
		const client = tenantClient(init.token);

		const created = await client.caches.put.inNamedCache({
			cacheName: 'builds',
			access: 'public',
			priority: 30,
			defaultRootRetention: { kind: 'duration', seconds: 3600 },
			grace: { kind: 'duration', graceSeconds: 60 }
		});
		const listed = await client.caches.list();
		const removed = await client.caches.remove({
			params: { cacheName: 'builds' }
		});

		expect({ created, listed, removed }).toStrictEqual({
			created: {
				scope: { kind: 'named', name: 'builds' },
				access: 'public',
				priority: 30,
				storePaths: 0,
				defaultRootRetention: { kind: 'duration', seconds: 3600 },
				grace: { kind: 'duration', graceSeconds: 60 },
				rootRetentionOverrides: [],
				graceManaged: false
			},
			listed: {
				caches: [
					{
						scope: { kind: 'default' },
						access: 'public',
						priority: 40,
						storePaths: 0,
						defaultRootRetention: { kind: 'permanent' },
						grace: { kind: 'none' },
						graceManaged: false
					},
					{
						scope: { kind: 'named', name: 'builds' },
						access: 'public',
						priority: 30,
						storePaths: 0,
						defaultRootRetention: { kind: 'duration', seconds: 3600 },
						grace: { kind: 'duration', graceSeconds: 60 },
						graceManaged: false
					}
				]
			},
			removed: {
				scope: { kind: 'named', name: 'builds' },
				removed: true,
				storePathsRemoved: 0
			}
		});
	});

	it('updates one cache property at a time through the derived client', async () => {
		await recordTransition('cache-identity', 'complete');
		await useTestServer('contract-cache-update');
		const init = await bootstrap();
		const client = tenantClient(init.token);
		await client.caches.put.inNamedCache({
			cacheName: 'builds',
			access: 'public',
			priority: 40
		});

		const privateCache = await client.caches.update.inNamedCache({
			cacheName: 'builds',
			kind: 'access',
			access: 'private'
		});
		const reprioritised = await client.caches.update.inNamedCache({
			cacheName: 'builds',
			kind: 'priority',
			priority: 30
		});
		await client.caches.update.inNamedCache({
			cacheName: 'builds',
			kind: 'set-default-root-ttl',
			retention: { kind: 'duration', seconds: 7200 }
		});
		await client.caches.update.inNamedCache({
			cacheName: 'builds',
			kind: 'set-root-ttl-override',
			rootPrefix: 'ci/',
			retention: { kind: 'duration', seconds: 900 }
		});
		const configured = await client.caches.update.inNamedCache({
			cacheName: 'builds',
			kind: 'set-grace',
			graceSeconds: 120
		});
		await client.caches.update.inNamedCache({
			cacheName: 'builds',
			kind: 'set-default-root-ttl',
			retention: { kind: 'permanent' }
		});
		await client.caches.update.inNamedCache({
			cacheName: 'builds',
			kind: 'clear-root-ttl-override',
			rootPrefix: 'ci/'
		});
		const cleared = await client.caches.update.inNamedCache({
			cacheName: 'builds',
			kind: 'clear-grace'
		});

		expect({ privateCache, reprioritised, configured, cleared }).toStrictEqual({
			privateCache: {
				scope: { kind: 'named', name: 'builds' },
				access: 'private',
				priority: 40,
				storePaths: 0,
				defaultRootRetention: { kind: 'permanent' },
				grace: { kind: 'none' },
				rootRetentionOverrides: [],
				graceManaged: false
			},
			reprioritised: {
				scope: { kind: 'named', name: 'builds' },
				access: 'private',
				priority: 30,
				storePaths: 0,
				defaultRootRetention: { kind: 'permanent' },
				grace: { kind: 'none' },
				rootRetentionOverrides: [],
				graceManaged: false
			},
			configured: {
				scope: { kind: 'named', name: 'builds' },
				access: 'private',
				priority: 30,
				storePaths: 0,
				defaultRootRetention: { kind: 'duration', seconds: 7200 },
				grace: { kind: 'duration', graceSeconds: 120 },
				rootRetentionOverrides: [
					{
						rootPrefix: 'ci/',
						retention: { kind: 'duration', seconds: 900 }
					}
				],
				graceManaged: false
			},
			cleared: {
				scope: { kind: 'named', name: 'builds' },
				access: 'private',
				priority: 30,
				storePaths: 0,
				defaultRootRetention: { kind: 'permanent' },
				grace: { kind: 'none' },
				rootRetentionOverrides: [],
				graceManaged: false
			}
		});
	});

	it('returns CACHE_ALREADY_EXISTS without changing the cache', async () => {
		await useTestServer('contract-cache-already-exists');
		const init = await bootstrap();
		const client = tenantClient(init.token);
		await client.caches.put.inNamedCache({
			cacheName: 'builds',
			access: 'private',
			priority: 30
		});

		const [error, data, isDefined] = await safe(
			client.caches.put.inNamedCache({
				cacheName: 'builds',
				access: 'public',
				priority: 40
			})
		);
		const unchanged = await client.caches.get.inNamedCache({
			cacheName: 'builds'
		});

		expect({ isDefined, data, unchanged }).toStrictEqual({
			isDefined: true,
			data: undefined,
			unchanged: {
				scope: { kind: 'named', name: 'builds' },
				access: 'private',
				priority: 30,
				storePaths: 0,
				defaultRootRetention: { kind: 'permanent' },
				grace: { kind: 'none' },
				rootRetentionOverrides: [],
				graceManaged: false
			}
		});
		expect(error).toBeInstanceOf(ORPCError);
		expect(error).toMatchObject({
			defined: true,
			code: 'CACHE_ALREADY_EXISTS',
			status: StatusCodes.CONFLICT,
			data: { cache: { kind: 'named', name: 'builds' } }
		});
	});

	it('hardens every matched tenant response and Bearer challenge', async () => {
		await useTestServer('contract-response-headers');
		const init = await bootstrap();
		const underScopedToken = await issueServerSignedToken(cacheWriteGrants());
		const cachesUrl = new URL('/caches', currentOrigin());
		const authorised = await currentServer().fetch(
			new Request(cachesUrl, {
				headers: { authorization: `Bearer ${init.token}` }
			})
		);
		const missing = await currentServer().fetch(new Request(cachesUrl));
		const invalid = await currentServer().fetch(
			new Request(cachesUrl, {
				headers: { authorization: 'Bearer invalid' }
			})
		);
		const forbidden = await currentServer().fetch(
			new Request(cachesUrl, {
				headers: { authorization: `Bearer ${underScopedToken}` }
			})
		);

		expect({
			authorised: {
				status: authorised.status,
				cacheControl: authorised.headers.get('cache-control')
			},
			missing: {
				status: missing.status,
				cacheControl: missing.headers.get('cache-control'),
				challenge: missing.headers.get('www-authenticate')
			},
			invalid: {
				status: invalid.status,
				cacheControl: invalid.headers.get('cache-control'),
				challenge: invalid.headers.get('www-authenticate')
			},
			forbidden: {
				status: forbidden.status,
				cacheControl: forbidden.headers.get('cache-control'),
				challenge: forbidden.headers.get('www-authenticate')
			}
		}).toStrictEqual({
			authorised: { status: StatusCodes.OK, cacheControl: 'no-store' },
			missing: {
				status: StatusCodes.UNAUTHORIZED,
				cacheControl: 'no-store',
				challenge: 'Bearer realm="cupboard"'
			},
			invalid: {
				status: StatusCodes.UNAUTHORIZED,
				cacheControl: 'no-store',
				challenge: 'Bearer realm="cupboard", error="invalid_token"'
			},
			forbidden: {
				status: StatusCodes.FORBIDDEN,
				cacheControl: 'no-store',
				challenge: 'Bearer realm="cupboard", error="insufficient_scope"'
			}
		});
	});

	it('returns CACHE_NOT_EMPTY when cache removal requires force', async () => {
		await useTestServer('contract-cache-not-empty');
		const init = await bootstrap({
			caches: [{ scope: namedCache('builds') }]
		});
		const client = tenantClient(init.token);
		await pushPath(
			init.token,
			uploadMetadata({ fileSize: narBytes.byteLength }),
			namedCache('builds')
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
			forced: {
				scope: { kind: 'named', name: 'builds' },
				removed: true,
				storePathsRemoved: 1
			}
		});
		expect(error).toBeInstanceOf(ORPCError);
		expect(error).toMatchObject({
			defined: true,
			code: 'CACHE_NOT_EMPTY',
			status: StatusCodes.CONFLICT,
			data: { cache: { kind: 'named', name: 'builds' } }
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
		await withoutAlarmArming(async () => {
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
				throw new Error(
					'Expected each signing-key conflict to be an ORPCError'
				);
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
	});

	it('creates and removes trust rules through the derived client', async () => {
		await useTestServer('contract-trust');
		const init = await bootstrap();
		const client = tenantClient(init.token);

		const rule = await client.oidcTrust.add({
			issuer: 'https://token.actions.githubusercontent.com',
			audience: 'https://cache.example.workers.dev',
			claims: { repository_owner_id: '5678' },
			permittedGrants: [
				{
					type: 'cupboard_cache',
					actions: ['upload:commit'],
					resources: {
						cache: { kind: 'named', exact: 'ci', validate: 'cacheName' }
					}
				}
			]
		});
		const ruleRemoved = await client.oidcTrust.remove({ id: rule.id });

		expect({
			ruleGrants: rule.permittedGrants.length,
			ruleRemoved
		}).toStrictEqual({
			ruleGrants: 1,
			ruleRemoved: { id: rule.id, removed: true }
		});
	});

	// `_default` no longer selects the default cache; the bare path does. The
	// named-cache parameter is a plain `cacheNameSchema`, which refuses a leading
	// underscore, so the contract rejects the input rather than missing a route.
	it('refuses _default in a named-cache path and serves a real name there', async () => {
		await useTestServer('contract-named-cache-path');
		const init = await bootstrap();
		const client = tenantClient(init.token);
		await client.caches.put.inNamedCache({
			cacheName: 'builds',
			access: 'public',
			priority: 30
		});

		const defaultSelectorUrl = new URL(
			'/cache/_default/stats',
			currentOrigin()
		);
		const defaultSelector = await currentServer().fetch(
			new Request(defaultSelectorUrl, {
				headers: { authorization: `Bearer ${init.token}` }
			})
		);
		await defaultSelector.body?.cancel();
		const named = await client.stats.cache.inNamedCache({
			cacheName: 'builds'
		});

		expect({
			defaultSelectorStatus: defaultSelector.status,
			namedStorePaths: named.storePaths
		}).toStrictEqual({
			defaultSelectorStatus: StatusCodes.BAD_REQUEST,
			namedStorePaths: 0
		});
	});

	it('serves stats, usage and check on the default cache through bare paths', async () => {
		await useTestServer('contract-stats');
		const init = await bootstrap();
		const client = tenantClient(init.token);
		await pushPath(
			init.token,
			uploadMetadata({ fileSize: narBytes.byteLength })
		);

		const stats = await client.stats.cache.inDefaultCache({});
		const usage = await client.stats.usage();
		const report = await client.check.run({ deep: true });

		expect({
			storePaths: stats.storePaths,
			chargedBlobs: usage.narBlobs,
			report: {
				narInfosChecked: report.narInfosChecked,
				cursor: report.cursor,
				cursorCache: report.cursorCache,
				discrepancies: report.discrepancies
			}
		}).toStrictEqual({
			storePaths: 1,
			chargedBlobs: 1,
			report: {
				narInfosChecked: 1,
				cursor: '',
				cursorCache: 0,
				discrepancies: []
			}
		});
	});

	it('updates roots, deletes paths, and runs GC through the derived client', async () => {
		await useTestServer('contract-roots');
		const init = await bootstrap();
		const client = tenantClient(init.token);
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(init.token, metadata);

		const set = await client.roots.set.inDefaultCache({
			name: 'github:owner/repo/main',
			targets: [metadata.storePath]
		});
		const listed = await client.roots.list.inDefaultCache({});
		const targetsPage = await client.roots.targets.inDefaultCache({
			name: 'github:owner/repo/main',
			limit: 1
		});
		const removedRoot = await client.roots.remove.inDefaultCache({
			name: 'github:owner/repo/main'
		});
		const removedPath = await client.paths.remove.inDefaultCache({
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

		const negotiated = await client.uploads.negotiate.inDefaultCache({
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
			client.uploads.negotiate.inDefaultCache({
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
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(testBase);
		await useTestServer('contract-credential');
		const init = await bootstrap();
		const client = tenantClient(init.token);

		const issued = await client.uploads.credential.inDefaultCache({});
		const refreshed = await client.uploads.credential.inDefaultCache({
			pushId: issued.pushId
		});

		expect({
			pushIdShape: /^[0-9a-f]{104}$/u.test(issued.pushId),
			bucket: issued.bucket,
			endpoint: issued.endpoint,
			hasCredential:
				issued.accessKeyId.length > 0 &&
				issued.secretAccessKey.length > 0 &&
				issued.sessionToken.length > 0,
			expiresAt: issued.expiresAt,
			refreshKeepsPrefix: refreshed.pushId === issued.pushId
		}).toStrictEqual({
			pushIdShape: true,
			bucket: 'cupboard-blobs',
			endpoint: 'https://test-account-id.r2.cloudflarestorage.com',
			hasCredential: true,
			expiresAt: '2026-01-01T00:10:00.000Z',
			refreshKeepsPrefix: true
		});

		const [forgedError] = await safe(
			client.uploads.credential.inDefaultCache({ pushId: 'f'.repeat(96) })
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
		await pushPath(init.token, metadata, defaultCache(), nar);

		const bundle = sigstoreBundleBytes(narDigestHex(nar.narHash));
		const digest = await sha256HexBytes(bundle);
		const negotiated = await client.attestations.negotiate.inDefaultCache({
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
		const attached = await client.attestations.attach.inDefaultCache({
			id: decision.uploadId
		});

		expect(attached).toStrictEqual({
			storePathHash: metadata.storePathHash,
			digest,
			predicateType: 'https://slsa.dev/provenance/v1',
			status: 'attached'
		});
	});

	it('uploads one bundle and attaches its subjects across repeated pages', async () => {
		await useTestServer('contract-bundle-pages');
		const init = await bootstrap();
		const client = tenantClient(init.token);
		const nar = await verifiableNar('contract-bundle-page');
		const metadata = uploadMetadata({
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await pushPath(init.token, metadata, defaultCache(), nar);
		const bundle = bundleForSubjects([
			{
				name: StorePath.basename(metadata.storePath),
				digest: narDigestHex(nar.narHash)
			}
		]);
		const digest = await sha256HexBytes(bundle);
		const negotiated =
			await client.attestations.negotiateBundles.inDefaultCache({
				pushId: testPushId,
				bundles: [{ digest }]
			});
		const decision = attestationBundleDecisionSchema.parse(
			negotiated.bundles[0]
		);
		expect(decision.action).toBe('upload');
		if (decision.action !== 'upload') {
			throw new Error('Expected a new bundle upload');
		}
		await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });
		const page = {
			id: decision.uploadId,
			storePathHashes: [metadata.storePathHash]
		};
		const attachment =
			await client.attestations.attachPaths.inDefaultCache(page);
		const replay = await client.attestations.attachPaths.inDefaultCache(page);
		expect({ attachment, replay }).toStrictEqual({
			attachment: {
				paths: [
					{
						storePathHash: metadata.storePathHash,
						digest,
						predicateType: 'https://slsa.dev/provenance/v1',
						status: 'attached'
					}
				],
				expiresAt: attachment.expiresAt
			},
			replay: {
				paths: [
					{
						storePathHash: metadata.storePathHash,
						digest,
						predicateType: 'https://slsa.dev/provenance/v1',
						status: 'already-present'
					}
				],
				expiresAt: replay.expiresAt
			}
		});
		const reused = await client.attestations.negotiateBundles.inDefaultCache({
			pushId: testPushId,
			bundles: [{ digest }]
		});
		expect(reused.bundles).toStrictEqual([
			{
				action: 'reuse',
				digest,
				uploadId: z.string().parse(reused.bundles[0]?.uploadId),
				expiresAt: z.string().parse(reused.bundles[0]?.expiresAt)
			}
		]);
	});

	it.each(['default', 'default-private', 'public', 'private'] as const)(
		'attaches multiple subjects with one validation in the %s cache',
		async (kind) => {
			const fixture = await bundleFixture(kind, 3);
			const measured = vi.spyOn(
				AttestationCasService.prototype,
				'measureStagedBundle'
			);
			const promoted = vi.spyOn(
				AttestationCasService.prototype,
				'promoteMeasuredBundle'
			);
			const decision = await stageFixtureBundle(
				fixture,
				bundleForSubjects(fixture.subjects)
			);
			const first = await fixture.attach(decision.uploadId, [
				fixture.hash(0),
				'a'.repeat(32)
			]);
			const remaining = await fixture.attach(
				decision.uploadId,
				fixture.hashes.slice(1)
			);
			const replay = await fixture.attach(decision.uploadId, fixture.hashes);
			expect({
				first: first.paths,
				remaining: remaining.paths,
				replay: replay.paths,
				measured: measured.mock.calls.length,
				promoted: promoted.mock.calls.length
			}).toStrictEqual({
				first: [
					pathOutcome(fixture.hash(0), decision.digest, 'attached'),
					pathOutcome('a'.repeat(32), decision.digest, 'unservable')
				],
				remaining: fixture.hashes
					.slice(1)
					.map((hash) => pathOutcome(hash, decision.digest, 'attached')),
				replay: fixture.hashes.map((hash) =>
					pathOutcome(hash, decision.digest, 'already-present')
				),
				measured: 1,
				promoted: 1
			});
		}
	);

	it.each([
		{ change: 'path-generation', error: undefined },
		{
			change: 'cache-generation',
			error: {
				code: 'NOT_FOUND',
				status: StatusCodes.NOT_FOUND,
				message: 'Attestation upload not found'
			}
		},
		{
			change: 'pending-removed',
			error: {
				code: 'NOT_FOUND',
				status: StatusCodes.NOT_FOUND,
				message: 'Attestation upload not found'
			}
		},
		{
			change: 'pending-expired',
			error: {
				code: 'NOT_FOUND',
				status: StatusCodes.NOT_FOUND,
				message: 'Attestation upload expired'
			}
		},
		{
			change: 'quota',
			error: {
				code: 'INSUFFICIENT_STORAGE',
				status: StatusCodes.INSUFFICIENT_STORAGE,
				message: "This upload would exceed the tenant's storage quota"
			}
		},
		{
			change: 'tenant-stopped',
			error: {
				code: 'FORBIDDEN',
				status: StatusCodes.FORBIDDEN,
				message: 'Writes for this tenant are stopped (suspended)'
			}
		}
	] as const)(
		'releases the input gate during a grouped bundle read and rechecks $change',
		async ({ change, error }) => {
			const fixture = await bundleFixture(
				'default',
				1,
				`bundle-gate-${change}`
			);
			const decision = await stageFixtureBundle(
				fixture,
				bundleForSubjects(fixture.subjects)
			);
			const readState = {
				started: false,
				finished: false,
				attachmentSettled: false
			};
			const stopWaiting = new AbortController();
			let releaseRead: (() => void) | undefined;
			const restore = await runInDurableObject(currentServer(), (instance) => {
				const context = instance.context;
				const originalEnv = context.env;
				context.env = {
					...originalEnv,
					BLOBS: new Proxy(originalEnv.BLOBS, {
						get(bucket, property) {
							if (property === 'get') {
								return async (key: string, options?: R2GetOptions) => {
									const object = await bucket.get(key, options);
									if (
										object === null ||
										key !== decision.r2Key ||
										!('arrayBuffer' in object)
									) {
										return object;
									}
									return new Proxy(object, {
										get(target, member) {
											if (member === 'arrayBuffer') {
												return async () => {
													const latch = Promise.withResolvers<undefined>();
													releaseRead = () => {
														latch.resolve(undefined);
													};
													readState.started = true;
													await latch.promise;
													readState.finished = true;
													return target.arrayBuffer();
												};
											}
											const value: unknown = Reflect.get(
												target,
												member,
												target
											);
											const bound: unknown =
												typeof value === 'function'
													? value.bind(target)
													: value;
											return bound;
										}
									});
								};
							}
							const value: unknown = Reflect.get(bucket, property, bucket);
							const bound: unknown =
								typeof value === 'function' ? value.bind(bucket) : value;
							return bound;
						}
					})
				};
				return () => {
					context.env = originalEnv;
				};
			});
			onTestFinished(() => {
				stopWaiting.abort();
				releaseRead?.();
				restore();
			});
			const promoted = vi.spyOn(
				AttestationCasService.prototype,
				'promoteMeasuredBundle'
			);
			const attaching = (async () => {
				const result = await safe(
					fixture.attach(decision.uploadId, fixture.hashes)
				);
				readState.attachmentSettled = true;
				return result;
			})();
			while (!readState.started) {
				if (readState.attachmentSettled) {
					const result = await attaching;
					if (result.error !== null) {
						throw result.error;
					}
					throw new Error(
						'Attachment completed without reading the staged bundle'
					);
				}
				await scheduler.wait(0, { signal: stopWaiting.signal });
			}
			const changed = runInDurableObject(currentServer(), (instance) =>
				instance.context.criticalSection(async () => {
					const context = instance.context;
					const wasReading = !readState.finished;
					const cache = resolvedCache(context);
					switch (change) {
						case 'path-generation': {
							context.db
								.update(schema.narInfos)
								.set({ generation: narInfoGenerationSchema.parse(1) })
								.where(eq(schema.narInfos.cacheId, cache.id))
								.run();
							break;
						}
						case 'cache-generation': {
							context.db
								.update(schema.cacheIdentities)
								.set({
									generation: cacheGenerationSchema.parse(cache.generation + 1)
								})
								.where(eq(schema.cacheIdentities.id, cache.id))
								.run();
							break;
						}
						case 'pending-removed': {
							context.db
								.delete(schema.pendingAttestations)
								.where(eq(schema.pendingAttestations.id, decision.uploadId))
								.run();
							break;
						}
						case 'pending-expired': {
							context.db
								.update(schema.pendingAttestations)
								.set({ expiresAt: isoTimestamp(new Date(0)) })
								.where(eq(schema.pendingAttestations.id, decision.uploadId))
								.run();
							break;
						}
						case 'quota': {
							await context.d1
								.update(d1Schema.tenantUsage)
								.set({
									quotaBytes: sql`${d1Schema.tenantUsage.bytes} + ${d1Schema.tenantUsage.casBytes}`
								})
								.where(eq(d1Schema.tenantUsage.tenant, fixtureTenant));
							break;
						}
						case 'tenant-stopped': {
							await context.d1
								.update(d1Schema.tenant)
								.set({ status: 'suspended' })
								.where(eq(d1Schema.tenant.id, fixtureTenant));
							break;
						}
					}
					releaseRead?.();
					return wasReading;
				})
			);
			const didOpenGate = await changed;
			const result = await attaching;
			restore();
			if (result.error !== null && !(result.error instanceof ORPCError)) {
				throw result.error;
			}
			expect({
				didOpenGate,
				result: {
					data: result.data,
					error:
						result.error === null
							? undefined
							: {
									code: z.string().parse(result.error.code),
									status: result.error.status,
									message: result.error.message
								}
				},
				promotions: promoted.mock.calls.length,
				references: await attestationReferenceRows(),
				objects: await casObjectRows()
			}).toStrictEqual({
				didOpenGate: true,
				result: {
					data:
						change === 'path-generation'
							? {
									paths: [
										pathOutcome(fixture.hash(0), decision.digest, 'unservable')
									],
									expiresAt: result.data?.expiresAt
								}
							: undefined,
					error
				},
				promotions: 0,
				references: [],
				objects: []
			});
		}
	);

	it.each([
		{ mode: 'fresh', operations: 18 },
		{ mode: 'replay', operations: 10 },
		{ mode: 'restore', operations: 24 }
	] as const)(
		'keeps grouped attachment operation counts bounded for $mode',
		async ({ mode, operations }) => {
			const fixture = await bundleFixture('default', 1, `bundle-cost-${mode}`);
			const decision = await stageFixtureBundle(
				fixture,
				bundleForSubjects(fixture.subjects)
			);
			if (mode !== 'fresh') {
				await fixture.attach(decision.uploadId, fixture.hashes);
			}
			if (mode === 'restore') {
				await env.BLOBS.delete(await currentCasObjectKey(decision.digest));
			}
			const observed = await runInDurableObject(
				currentServer(),
				async (instance) => {
					await instance.context.ctx.storage.deleteAlarm();
					const context = instance.context;
					const service = new AttestationsService(
						context,
						new CacheRegistrationService(context),
						new AttestationCasService(context),
						new NarInfoObjectsService(context)
					);
					return withSubrequestSlice(
						async () => {
							const before = subrequestsAvailable();
							const response = await service.attachPaths(
								defaultCache(),
								decision.uploadId,
								[storePathHashSchema.parse(fixture.hash(0))]
							);
							return { response, operations: before - subrequestsAvailable() };
						},
						{ subrequests: 1000, reserve: 0 }
					);
				}
			);
			expect(observed).toStrictEqual({
				response: {
					paths: [
						pathOutcome(
							fixture.hash(0),
							decision.digest,
							mode === 'fresh' ? 'attached' : 'already-present'
						)
					],
					expiresAt: observed.response.expiresAt
				},
				operations
			});
		}
	);

	it('attaches a bundle with more subjects than one request without widening SQL parameters', async () => {
		const fixture = await bundleFixture(
			'default',
			attestationAttachMaxPaths + 1
		);
		const measured = vi.spyOn(
			AttestationCasService.prototype,
			'measureStagedBundle'
		);
		const decision = await stageFixtureBundle(
			fixture,
			bundleForSubjects(fixture.subjects)
		);
		const first = await fixture.attach(
			decision.uploadId,
			fixture.hashes.slice(0, attestationAttachMaxPaths)
		);
		const second = await fixture.attach(
			decision.uploadId,
			fixture.hashes.slice(attestationAttachMaxPaths)
		);
		expect({
			paths: [...first.paths, ...second.paths],
			measured: measured.mock.calls.length
		}).toStrictEqual({
			paths: fixture.hashes.map((hash) =>
				pathOutcome(hash, decision.digest, 'attached')
			),
			measured: 1
		});
	}, 60_000);

	it('rejects a bundle whose subject digest differs from the committed NAR', async () => {
		const fixture = await bundleFixture('default', 1);
		const subject = fixture.subject(0);
		const wrong = { ...subject, digest: 'b'.repeat(64) };
		const decision = await stageFixtureBundle(
			fixture,
			bundleForSubjects([wrong])
		);
		await expect(
			fixture.attach(decision.uploadId, fixture.hashes)
		).rejects.toMatchObject({
			status: StatusCodes.UNPROCESSABLE_ENTITY,
			message: `Attestation bundle has no subject for ${fixture.subject(0).name} with the committed NAR hash`
		});
	});

	it.each([undefined, '_', 'different-store-path'])(
		'attaches a matching NAR digest with subject name %s across repeated pages',
		async (name) => {
			const fixture = await bundleFixture('default', 2);
			const decision = await stageFixtureBundle(
				fixture,
				bundleForSubjects([
					{
						...(name !== undefined && { name }),
						digest: fixture.subject(0).digest
					}
				])
			);
			const first = await fixture.attach(decision.uploadId, [fixture.hash(0)]);
			const second = await fixture.attach(decision.uploadId, [fixture.hash(1)]);
			const replay = await fixture.attach(decision.uploadId, fixture.hashes);

			expect({
				first: first.paths,
				second: second.paths,
				replay: replay.paths
			}).toStrictEqual({
				first: [pathOutcome(fixture.hash(0), decision.digest, 'attached')],
				second: [pathOutcome(fixture.hash(1), decision.digest, 'attached')],
				replay: fixture.hashes.map((hash) =>
					pathOutcome(hash, decision.digest, 'already-present')
				)
			});
		}
	);

	it('authorises bundle attachment from the pending cache and rejects a different route cache', async () => {
		const fixture = await bundleFixture('private', 1);
		const decision = await stageFixtureBundle(
			fixture,
			bundleForSubjects(fixture.subjects)
		);
		const restricted = tenantClient(
			await issueServerSignedToken(cacheWriteGrants())
		);
		await expect(
			restricted.attestations.attachPaths.inDefaultCache({
				id: decision.uploadId,
				storePathHashes: fixture.hashes
			})
		).rejects.toMatchObject({ status: StatusCodes.FORBIDDEN });
		await expect(
			fixture.client.attestations.attachPaths.inDefaultCache({
				id: decision.uploadId,
				storePathHashes: fixture.hashes
			})
		).rejects.toMatchObject({ status: StatusCodes.BAD_REQUEST });
		const unrelated =
			await fixture.client.attestations.negotiateBundles.inDefaultCache({
				pushId: testPushId,
				bundles: [{ digest: decision.digest }]
			});
		expect(unrelated.bundles.map((bundle) => bundle.action)).toStrictEqual([
			'upload'
		]);
	});

	it('preserves staged bytes during collection and restores a lost CAS object before the next page', async () => {
		const fixture = await bundleFixture('default', 2);
		const measured = vi.spyOn(
			AttestationCasService.prototype,
			'measureStagedBundle'
		);
		const decision = await stageFixtureBundle(
			fixture,
			bundleForSubjects(fixture.subjects)
		);
		await fixture.attach(decision.uploadId, [fixture.hash(0)]);
		await fixture.client.gc.runAll();
		const staged = await env.BLOBS.head(decision.r2Key);
		const objects = await env.BLOBS.list({ prefix: 'cas/' });
		await env.BLOBS.delete(objects.objects.map((object) => object.key));
		const next = await fixture.attach(decision.uploadId, [fixture.hash(1)]);
		expect({
			staged: staged !== null,
			paths: next.paths,
			measured: measured.mock.calls.length
		}).toStrictEqual({
			staged: true,
			paths: [pathOutcome(fixture.hash(1), decision.digest, 'attached')],
			measured: 2
		});
	});

	it.each(['before-claim', 'before-reference'] as const)(
		'claims a validated bundle when collection runs %s',
		async (interleaving) => {
			const fixture = await bundleFixture('default', 2);
			const bundle = bundleForSubjects(fixture.subjects);
			const decision = await stageFixtureBundle(fixture, bundle);
			await fixture.attach(decision.uploadId, [fixture.hash(0)]);
			const referenceRows = await attestationReferenceRows();
			const references = referenceRows.filter(
				(reference) => reference.digest === decision.digest
			);
			const [reference] = references;
			if (reference === undefined) {
				throw new Error('Expected the first page to attach the bundle');
			}
			for (const reference of references) {
				await currentServer().removeAttestationReference({
					...reference,
					generation: narInfoGenerationSchema.parse(reference.generation),
					predicateType: predicateTypeSchema.parse(reference.predicateType)
				});
			}
			await env.CUPBOARD_DB.prepare(
				'UPDATE cas_object SET delete_after = ? WHERE digest = ?'
			)
				.bind(isoTimestamp(new Date(0)), decision.digest)
				.run();
			const originalKey = await currentCasObjectKey(decision.digest);
			const original = await env.CUPBOARD_DB.prepare(
				'SELECT incarnation FROM cas_object WHERE digest = ?'
			)
				.bind(decision.digest)
				.first<{ incarnation: number }>();
			if (original === null) {
				throw new Error('Expected the first page to promote the bundle');
			}
			const measured = vi.spyOn(
				AttestationCasService.prototype,
				'measureStagedBundle'
			);
			let collected: number | undefined;
			const collect = async () => {
				collected = await runCasReaper(
					rootLogger(),
					env,
					10,
					() => Promise.resolve(),
					'collect'
				);
			};
			if (interleaving === 'before-claim') {
				const head = env.BLOBS.head.bind(env.BLOBS);
				vi.spyOn(env.BLOBS, 'head').mockImplementation(async (key) => {
					const result = await head(key);
					if (key === originalKey && collected === undefined) {
						await collect();
					}
					return result;
				});
			} else {
				const reserve = await runInDurableObject(
					currentServer(),
					(instance) => {
						const service = new AttestationCasService(instance.context);
						return service.reserveReferenceAndCharge.bind(service);
					}
				);
				vi.spyOn(
					AttestationCasService.prototype,
					'reserveReferenceAndCharge'
				).mockImplementation(async (...arguments_) => {
					await collect();
					return reserve(...arguments_);
				});
			}
			const next = await fixture.attach(decision.uploadId, [fixture.hash(1)]);
			const list = await readFetch(`/attestations/${fixture.hash(1)}`);
			expect({
				collected,
				paths: next.paths,
				listStatus: list.status,
				list: list.ok ? await list.json() : undefined,
				objectKey: await currentCasObjectKey(decision.digest),
				measured: measured.mock.calls.length
			}).toStrictEqual({
				collected: interleaving === 'before-claim' ? 1 : 0,
				paths: [pathOutcome(fixture.hash(1), decision.digest, 'attached')],
				listStatus: StatusCodes.OK,
				list: {
					attestations: [
						{
							digest: decision.digest,
							predicateType: 'https://slsa.dev/provenance/v1',
							size: bundle.byteLength
						}
					]
				},
				objectKey:
					interleaving === 'before-claim'
						? casObjectKey(reference.digest, original.incarnation + 1)
						: originalKey,
				measured: interleaving === 'before-claim' ? 1 : 0
			});
		}
	);

	it('renegotiates an active session after staging and CAS bytes disappear', async () => {
		const fixture = await bundleFixture('default', 3);
		const bundle = bundleForSubjects(fixture.subjects);
		const decision = await stageFixtureBundle(fixture, bundle);
		await fixture.attach(decision.uploadId, [fixture.hash(0)]);
		await env.BLOBS.delete(decision.r2Key);
		const available = await fixture.attach(decision.uploadId, [
			fixture.hash(1)
		]);
		expect(available.paths).toStrictEqual([
			pathOutcome(fixture.hash(1), decision.digest, 'attached')
		]);
		const objects = await env.BLOBS.list({ prefix: 'cas/' });
		await env.BLOBS.delete(objects.objects.map((object) => object.key));
		await expect(
			fixture.attach(decision.uploadId, [fixture.hash(2)])
		).rejects.toMatchObject({
			status: StatusCodes.NOT_FOUND,
			message: 'Attestation upload not found'
		});
		const pending = await runInDurableObject(currentServer(), (instance) => ({
			uploads: instance.context.db
				.select()
				.from(schema.pendingAttestations)
				.where(eq(schema.pendingAttestations.id, decision.uploadId))
				.all(),
			subjects: instance.context.db
				.select()
				.from(schema.pendingAttestationSubjects)
				.where(
					eq(schema.pendingAttestationSubjects.uploadId, decision.uploadId)
				)
				.all()
		}));
		expect(pending).toStrictEqual({ uploads: [], subjects: [] });
		const replacement = await stageFixtureBundle(fixture, bundle);
		const recovered = await fixture.attach(replacement.uploadId, [
			fixture.hash(2)
		]);
		expect(recovered.paths).toStrictEqual([
			pathOutcome(fixture.hash(2), replacement.digest, 'attached')
		]);
	});

	it('expires the pending bundle and removes its staged bytes', async () => {
		const fixture = await bundleFixture('default', 1);
		const decision = await stageFixtureBundle(
			fixture,
			bundleForSubjects(fixture.subjects)
		);
		await fixture.attach(decision.uploadId, fixture.hashes);
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.update(schema.pendingAttestations)
				.set({ expiresAt: isoTimestamp(new Date(0)) })
				.where(eq(schema.pendingAttestations.id, decision.uploadId))
				.run();
		});
		await expect(
			fixture.attach(decision.uploadId, fixture.hashes)
		).rejects.toMatchObject({ status: StatusCodes.NOT_FOUND });
		const remaining = await runInDurableObject(currentServer(), (instance) =>
			instance.context.db.select().from(schema.pendingAttestationSubjects).all()
		);
		expect(await env.BLOBS.head(decision.r2Key)).toBeNull();
		expect(remaining).toStrictEqual([]);
	});

	it('completes a page when several list writes exceed one collective storage deadline', async () => {
		const fixture = await bundleFixture('default', 3);
		const decision = await stageFixtureBundle(
			fixture,
			bundleForSubjects(fixture.subjects)
		);
		const write = await boundListWriter();
		vi.useFakeTimers();
		vi.spyOn(
			AttestationsService.prototype,
			'materialiseList'
		).mockImplementation(async (...arguments_) => {
			await vi.advanceTimersByTimeAsync(2000);
			await write(...arguments_);
		});
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.gateBudgetMs = 5000;
		});
		try {
			const page = await fixture.attach(decision.uploadId, fixture.hashes);
			expect(page.paths).toStrictEqual(
				fixture.hashes.map((hash) =>
					pathOutcome(hash, decision.digest, 'attached')
				)
			);
		} finally {
			await runInDurableObject(currentServer(), (instance) => {
				instance.context.gateBudgetMs = 25_000;
			});
		}
	}, 30_000);

	it('retries a partial page without validating or promoting the bundle again', async () => {
		const fixture = await bundleFixture('default', 3);
		const decision = await stageFixtureBundle(
			fixture,
			bundleForSubjects(fixture.subjects)
		);
		const measured = vi.spyOn(
			AttestationCasService.prototype,
			'measureStagedBundle'
		);
		const promoted = vi.spyOn(
			AttestationCasService.prototype,
			'promoteMeasuredBundle'
		);
		const write = await boundListWriter();
		let writes = 0;
		vi.spyOn(
			AttestationsService.prototype,
			'materialiseList'
		).mockImplementation(async (...arguments_) => {
			writes += 1;
			if (writes === 2) {
				throw new Error('Simulated list write failure');
			}
			await write(...arguments_);
		});
		await expect(
			fixture.attach(decision.uploadId, fixture.hashes)
		).rejects.toMatchObject({ status: StatusCodes.INTERNAL_SERVER_ERROR });
		const replay = await fixture.attach(decision.uploadId, fixture.hashes);
		expect({
			paths: replay.paths,
			measured: measured.mock.calls.length,
			promoted: promoted.mock.calls.length
		}).toStrictEqual({
			paths: [
				pathOutcome(fixture.hash(0), decision.digest, 'already-present'),
				pathOutcome(fixture.hash(1), decision.digest, 'already-present'),
				pathOutcome(fixture.hash(2), decision.digest, 'attached')
			],
			measured: 1,
			promoted: 1
		});
	});

	it('rejects quota exhaustion before promoting a new bundle', async () => {
		const fixture = await bundleFixture('default', 1);
		const decision = await stageFixtureBundle(
			fixture,
			bundleForSubjects(fixture.subjects)
		);
		const promoted = vi.spyOn(
			AttestationCasService.prototype,
			'promoteMeasuredBundle'
		);
		await env.CUPBOARD_DB.prepare(
			'UPDATE tenant_usage SET quota_bytes = bytes + cas_bytes WHERE tenant = ?'
		)
			.bind(fixtureTenant)
			.run();
		await expect(
			fixture.attach(decision.uploadId, fixture.hashes)
		).rejects.toMatchObject({ status: StatusCodes.INSUFFICIENT_STORAGE });
		expect(promoted.mock.calls).toStrictEqual([]);
	});

	it('does not create a cache for an empty bundle request', async () => {
		const fixture = await bundleFixture('default', 1);
		expect(
			await fixture.client.attestations.negotiateBundles.inNamedCache({
				cacheName: 'unused',
				pushId: testPushId,
				bundles: []
			})
		).toStrictEqual({ bundles: [] });
		await expect(
			fixture.client.caches.get.inNamedCache({ cacheName: 'unused' })
		).rejects.toMatchObject({ status: StatusCodes.NOT_FOUND });
	});

	it('does not attach a path whose local metadata has no committed D1 reference', async () => {
		const fixture = await bundleFixture('default', 2);
		const decision = await stageFixtureBundle(
			fixture,
			bundleForSubjects(fixture.subjects)
		);
		await fixture.attach(decision.uploadId, [fixture.hash(0)]);
		await runInDurableObject(currentServer(), (instance) => {
			const filter = and(
				eq(d1Schema.blobReference.tenant, fixtureTenant),
				eq(d1Schema.blobReference.storePathHash, fixture.hash(1))
			);
			return instance.context.d1
				.delete(d1Schema.blobReference)
				.where(filter)
				.run();
		});
		const next = await fixture.attach(decision.uploadId, [fixture.hash(1)]);
		expect(next.paths).toStrictEqual([
			pathOutcome(fixture.hash(1), decision.digest, 'unservable')
		]);
	});

	it('reports absent and collected pending IDs to attachment callers without weakening cache grants', async () => {
		const fixture = await bundleFixture('default', 1);
		const scoped = tenantClient(
			await issueServerSignedToken(cacheWriteGrants())
		);
		const readGrants = authorizationDetailsSchema.parse([
			{ type: 'cupboard_cache', cache: defaultCache(), actions: ['cache:read'] }
		]);
		const noAttach = tenantClient(await issueServerSignedToken(readGrants));
		const absent = {
			id: '00000000-0000-4000-8000-000000000000',
			storePathHashes: fixture.hashes
		};
		await expect(
			scoped.attestations.attachPaths.inDefaultCache(absent)
		).rejects.toMatchObject({ status: StatusCodes.NOT_FOUND });
		await expect(
			noAttach.attestations.attachPaths.inDefaultCache(absent)
		).rejects.toMatchObject({ status: StatusCodes.FORBIDDEN });
		await expect(
			scoped.attestations.attach.inDefaultCache({ id: absent.id })
		).rejects.toMatchObject({ status: StatusCodes.FORBIDDEN });
		const decision = await stageFixtureBundle(
			fixture,
			bundleForSubjects(fixture.subjects)
		);
		await fixture.attach(decision.uploadId, fixture.hashes);
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.update(schema.pendingAttestations)
				.set({ expiresAt: isoTimestamp(new Date(0)) })
				.where(eq(schema.pendingAttestations.id, decision.uploadId))
				.run();
		});
		await fixture.client.gc.runAll();
		await expect(
			scoped.attestations.attachPaths.inDefaultCache({
				id: decision.uploadId,
				storePathHashes: fixture.hashes
			})
		).rejects.toMatchObject({ status: StatusCodes.NOT_FOUND });
	});

	it('rejects attestation negotiation under a forged push id', async () => {
		await useTestServer('contract-attestations-forged');
		const init = await bootstrap();
		const client = tenantClient(init.token);

		const [error] = await safe(
			client.attestations.negotiate.inDefaultCache({
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

	it('lists and revokes refresh sessions through the derived client', async () => {
		await useTestServer('contract-sessions');
		const init = await bootstrap();
		const client = tenantClient(init.token);
		const owned = '00000000-0000-4000-8000-000000000001';
		const unknown = '00000000-0000-4000-8000-000000000002';
		const expired = '00000000-0000-4000-8000-000000000003';
		const createdAt = isoTimestamp(new Date('2019-01-01T00:00:00.000Z'));
		const expiresAt = isoTimestamp(new Date('2099-01-01T00:00:00.000Z'));

		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db.transaction((transaction) => {
				transaction
					.insert(schema.refreshTokenFamilies)
					.values([
						{
							id: owned,
							activeMemberId: 'owned-member',
							generation: 0,
							createdAt,
							expiresAt,
							issuer: oidcIssuerSchema.parse('https://idp.example'),
							subject: oidcSubjectSchema.parse('alice'),
							rule: trustRuleIdSchema.parse('admin')
						},
						{
							id: unknown,
							activeMemberId: 'unknown-member',
							generation: 2,
							createdAt,
							expiresAt
						},
						{
							id: expired,
							activeMemberId: 'expired-member',
							generation: 0,
							createdAt,
							expiresAt: isoTimestamp(new Date('2020-01-01T00:00:00.000Z'))
						}
					])
					.run();
				transaction
					.insert(schema.refreshTokenMembers)
					.values({
						id: 'owned-member',
						familyId: owned,
						generation: 0,
						credentialHash: '0'.repeat(64),
						createdAt
					})
					.run();
			});
		});

		const listed = await client.sessions.list();
		const revoked = await client.sessions.revoke({ id: owned });
		const repeated = await client.sessions.revoke({ id: owned });
		const remaining = await client.sessions.list();
		const members = await runInDurableObject(currentServer(), (instance) =>
			instance.context.db.select().from(schema.refreshTokenMembers).all()
		);
		const unknownSession = {
			id: unknown,
			createdAt,
			expiresAt
		};

		expect({ listed, revoked, repeated, remaining, members }).toStrictEqual({
			listed: {
				sessions: [
					{
						id: owned,
						issuer: 'https://idp.example',
						subject: 'alice',
						rule: 'admin',
						createdAt,
						expiresAt
					},
					unknownSession
				]
			},
			revoked: { id: owned, revoked: true },
			repeated: { id: owned, revoked: false },
			remaining: { sessions: [unknownSession] },
			members: []
		});
	});

	it('lists sessions with only session:list', async () => {
		await useTestServer('contract-session-list-scope');
		await bootstrap();
		const client = tenantClient(
			await issueServerSignedToken([
				{ type: 'cupboard_domain', actions: ['session:list'] }
			])
		);

		expect(await client.sessions.list()).toStrictEqual({ sessions: [] });
	});

	it.each([
		{
			name: 'revoke a session with only session:list',
			action: 'session:list' as const,
			call: (client: TenantClient): Promise<unknown> =>
				client.sessions.revoke({ id: '00000000-0000-4000-8000-000000000001' })
		},
		{
			name: 'list sessions with only session:revoke',
			action: 'session:revoke' as const,
			call: (client: TenantClient): Promise<unknown> => client.sessions.list()
		}
	])('refuses to $name', async ({ action, call }) => {
		await useTestServer('contract-session-scope');
		await bootstrap();
		const client = tenantClient(
			await issueServerSignedToken([
				{ type: 'cupboard_domain', actions: [action] }
			])
		);

		await expect(call(client)).rejects.toMatchObject({
			defined: true,
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

function bundleForSubjects(
	subjects: readonly { readonly name?: string; readonly digest: string }[]
): Uint8Array {
	const statement = {
		_type: 'https://in-toto.io/Statement/v1',
		predicateType: 'https://slsa.dev/provenance/v1',
		predicate: {},
		subject: subjects.map((subject) => ({
			name: subject.name,
			digest: { sha256: subject.digest }
		}))
	};
	const bundle = {
		mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
		verificationMaterial: { publicKey: { hint: 'test-key' }, tlogEntries: [] },
		dsseEnvelope: {
			payload: btoa(JSON.stringify(statement)),
			payloadType: 'application/vnd.in-toto+json',
			signatures: [{ sig: btoa('signature') }]
		}
	};
	return new TextEncoder().encode(JSON.stringify(bundle));
}

type BundleCache = 'default' | 'default-private' | 'public' | 'private';
async function bundleFixture(
	kind: BundleCache,
	count: number,
	serverName = `bundle-pages-${kind}-${String(count)}`
) {
	if (kind === 'default-private') {
		await recordTransition('cache-identity', 'complete');
	}
	await useTestServer(serverName);
	const init = await bootstrap();
	const client = tenantClient(init.token);
	const cache = kind.startsWith('default')
		? defaultCache()
		: namedCache(`bundles-${kind}`);
	if (cache.kind === 'named') {
		await client.caches.put.inNamedCache({
			cacheName: cache.name,
			access: kind === 'private' ? 'private' : 'public',
			priority: 30
		});
	}
	if (kind === 'default-private') {
		await client.caches.update.inDefaultCache({
			kind: 'access',
			access: 'private'
		});
	}
	const nar = await verifiableNar(`bundle-subjects-${kind}-${String(count)}`);
	const metadata = Array.from({ length: count }, (_, index) =>
		uploadMetadata({
			storePathHash: String(index + 1).padStart(32, '0'),
			name: 'bundle-subject',
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		})
	);
	for (const path of metadata) {
		await pushPath(init.token, path, cache, nar);
	}
	const hashes = metadata.map((path) => path.storePathHash);
	const subjects = metadata.map((path) => ({
		name: StorePath.basename(path.storePath),
		digest: narDigestHex(path.narHash)
	}));
	return {
		client,
		hashes,
		subjects,
		hash: (index: number) => {
			const hash = hashes[index];
			if (hash === undefined) {
				throw new Error('The bundle fixture has no path at this index');
			}
			return hash;
		},
		subject: (index: number) => {
			const subject = subjects[index];
			if (subject === undefined) {
				throw new Error('The bundle fixture has no subject at this index');
			}
			return subject;
		},
		negotiate: (digest: string) =>
			cache.kind === 'default'
				? client.attestations.negotiateBundles.inDefaultCache({
						pushId: testPushId,
						bundles: [{ digest }]
					})
				: client.attestations.negotiateBundles.inNamedCache({
						cacheName: cache.name,
						pushId: testPushId,
						bundles: [{ digest }]
					}),
		attach: (id: string, storePathHashes: readonly string[]) =>
			cache.kind === 'default'
				? client.attestations.attachPaths.inDefaultCache({
						id,
						storePathHashes: [...storePathHashes]
					})
				: client.attestations.attachPaths.inNamedCache({
						cacheName: cache.name,
						id,
						storePathHashes: [...storePathHashes]
					})
	};
}
async function stageFixtureBundle(
	fixture: Awaited<ReturnType<typeof bundleFixture>>,
	bytes: Uint8Array
) {
	const digest = await sha256HexBytes(bytes);
	const negotiated = await fixture.negotiate(digest);
	const decision = attestationBundleDecisionSchema.parse(negotiated.bundles[0]);
	if (decision.action !== 'upload') {
		throw new Error('Expected a new bundle upload');
	}
	await env.BLOBS.put(decision.r2Key, bytes, { sha256: hexBytes(digest) });
	return decision;
}
function pathOutcome(
	storePathHash: string,
	digest: string,
	status: 'attached' | 'already-present' | 'unservable'
) {
	return {
		storePathHash,
		digest,
		predicateType: 'https://slsa.dev/provenance/v1',
		status
	};
}

async function boundListWriter() {
	return runInDurableObject(currentServer(), (instance) => {
		const context = instance.context;
		const service = new AttestationsService(
			context,
			new CacheRegistrationService(context),
			new AttestationCasService(context),
			new NarInfoObjectsService(context)
		);
		return service.materialiseList.bind(service);
	});
}
