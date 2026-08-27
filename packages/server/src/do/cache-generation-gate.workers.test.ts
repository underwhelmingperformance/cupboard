import {
	cacheNameSchema,
	narInfoGenerationSchema,
	privateStoredCache,
	type StoredCache,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { cacheAvailabilityResponseSchema } from '@cupboard/protocol/cache-availability';
import { cacheRemoveResponseSchema } from '@cupboard/protocol/caches';
import { isoTimestamp, isoTimestampSchema } from '@cupboard/protocol/scalars';
import {
	type ParsedTenantReadCredential,
	tenantReadCredentialSchema
} from '@cupboard/protocol/tenants';
import { type ParsedUploadPathMetadata } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { setCacheReadCredential } from '../control/tenant-registry.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { narInfoDeletions } from '../db/schema.ts';
import {
	attestationListObjectKey,
	d1StatementsPerReaperInvocation,
	narInfoObjectKey,
	narObjectKey,
	requestOriginSchema
} from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	attestationReferenceRows,
	authorisedFetch,
	blobReferenceRows,
	bootstrap,
	countingD1,
	currentNarObjectKey,
	currentServer,
	driveToCompletion,
	fileAttestationReference,
	narBytes,
	narInfoGeneration,
	provisionFixtureTenant,
	publishAttestationList,
	pushPath,
	readFetch,
	resetTestServer,
	tenantCasBlobRows,
	tenantUsageRow,
	uploadMetadata,
	useTestServer,
	type VerifiableNar,
	verifiableNar
} from '../test-support.ts';

import { boundedD1 } from './bounded-io.ts';
import {
	maxPathsTornDownPerRun,
	teardownEntryPrefix
} from './cache-admin-service.ts';
import { maxFencedRetireRows } from './deletion-queue-service.ts';

const buildsCache = cacheNameSchema.parse('builds');
const privateBuilds = privateStoredCache(buildsCache);
const origin = requestOriginSchema.parse('https://cache.example');
const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
const tenantReader = { user: 'alice', password: 'secret' };
const storePathAlphabet = '0123456789abcdfghijklmnpqrsvwxyz';

// A Durable Object may hold six outgoing connections at once, so push in groups
// of that size to fill a large cache without queueing behind the cap.
const pushConcurrency = 6;

// The narinfo version the first commit of a path takes.
const firstNarInfoGeneration = 0;

// Generated read passwords are exactly 43 base64url characters, which is what
// the control plane accepts.
const cacheReader: ParsedTenantReadCredential =
	tenantReadCredentialSchema.parse({
		user: 'reader',
		password: 'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23'
	});

function credentialHeaders(credential: {
	readonly user: string;
	readonly password: string;
}): Record<string, string> {
	return {
		authorization: `Basic ${btoa(`${credential.user}:${credential.password}`)}`
	};
}

function basic(credential: {
	readonly user: string;
	readonly password: string;
}): RequestInit {
	return { headers: credentialHeaders(credential) };
}

// A store-path hash is 32 base32 characters, so index the fixtures through the
// alphabet rather than repeating one letter.
function indexedMetadata(
	index: number,
	nar?: VerifiableNar
): ParsedUploadPathMetadata {
	const suffix =
		storePathAlphabet.charAt(Math.floor(index / 32)) +
		storePathAlphabet.charAt(index % 32);

	return uploadMetadata({
		storePathHash: `${'0'.repeat(30)}${suffix}`,
		name: `path-${suffix}`,
		fileSize: nar?.narBytes.byteLength ?? narBytes.byteLength,
		...(nar !== undefined && {
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash
		})
	});
}

function database() {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

function cacheGenerationRows(): Promise<
	{ cache: string; generation: number }[]
> {
	return database()
		.select({
			cache: d1Schema.cacheLifecycle.cache,
			generation: d1Schema.cacheLifecycle.generation
		})
		.from(d1Schema.cacheLifecycle)
		.all();
}

function cacheCredentialCaches(): Promise<{ cache: string }[]> {
	return database()
		.select({ cache: d1Schema.tenantCacheReadCredential.cache })
		.from(d1Schema.tenantCacheReadCredential)
		.all();
}

/**
 * Writes one reference edge as a cache wrote them before the cache generation
 * existed: no `cache_generation` on the edge and no lifecycle row for its
 * cache. The NAR it points at is stored too, so only the reference check can
 * decide whether a read of it succeeds.
 *
 * The presence row and the usage charge come with it, because retiring the
 * edge credits both and the tenant's counters may not go negative.
 */
async function seedUnstampedEdge(
	cache: StoredCache,
	storePathHash: StorePathHash,
	nar: VerifiableNar
): Promise<void> {
	const fileSize = nar.narBytes.byteLength;
	const insertBlob = database()
		.insert(d1Schema.blobState)
		.values({
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize,
			compression: 'zstd',
			narSize: nar.narSize,
			verifiedAt: isoTimestamp(new Date())
		})
		.onConflictDoNothing();
	const insertEdge = database()
		.insert(d1Schema.blobReference)
		.values({
			tenant: fixtureTenant,
			cache,
			storePathHash,
			generation: narInfoGenerationSchema.parse(0),
			narHash: nar.narHash
		})
		.onConflictDoNothing();
	const insertPresence = database()
		.insert(d1Schema.tenantBlob)
		.values({ tenant: fixtureTenant, narHash: nar.narHash, fileSize })
		.onConflictDoNothing();
	const chargeUsage = database()
		.update(d1Schema.tenantUsage)
		.set({
			narinfos: sql`${d1Schema.tenantUsage.narinfos} + 1`,
			bytes: sql`${d1Schema.tenantUsage.bytes} + ${fileSize}`,
			blobs: sql`${d1Schema.tenantUsage.blobs} + 1`,
			updatedAt: isoTimestamp(new Date())
		})
		.where(eq(d1Schema.tenantUsage.tenant, fixtureTenant));

	await database().batch([insertBlob, insertEdge, insertPresence, chargeUsage]);
	await env.BLOBS.put(narObjectKey(nar.narHash), nar.narBytes);
}

// A pushed NAR's object key carries the version the promotion registered, so
// read it from D1 rather than assuming the first one.
async function pushedNarPath(
	nar: VerifiableNar,
	prefix = '/cache/builds'
): Promise<string> {
	return `${prefix}/${await currentNarObjectKey(nar.narHash)}`;
}

// The seeded edge's object was written at the first version, so its key follows
// from the hash alone.
function seededNarPath(nar: VerifiableNar): string {
	return `/cache/builds/${narObjectKey(nar.narHash)}`;
}

function removeCache(token: string): Promise<Response> {
	return authorisedFetch('/caches/builds?force=true', token, {
		method: 'DELETE'
	});
}

function teardownPending(cache: StoredCache): Promise<unknown> {
	return runInDurableObject(currentServer(), (_instance, state) =>
		state.storage.get(`${teardownEntryPrefix}${cache}`)
	);
}

/**
 * Deletes a cache and removes its teardown marker in one Durable Object
 * invocation, so that a test can observe the published state the deletion left
 * for its drain.
 *
 * Both steps belong to the same invocation because the deletion arms an alarm
 * before it returns. Clearing that alarm afterwards is not enough on its own:
 * workerd delivers an alarm that is already due, and the pass it runs claims
 * whatever marker it finds.
 */
async function deleteAndParkTeardown(cache: StoredCache): Promise<void> {
	await runInDurableObject(currentServer(), async (instance, state) => {
		await instance.runCacheTeardown(cache, origin);
		await state.storage.delete(`${teardownEntryPrefix}${cache}`);
	});
}

/**
 * Counts the D1 statements a deletion runs, with the chunking a deployment
 * uses. The deletion retires nothing itself, so the count must not grow with
 * the number of paths the cache holds.
 *
 * The count is taken inside one Durable Object invocation. A deletion arms the
 * alarm that drains the cache before it returns, and the statements of that
 * drain would otherwise land in the count of a separate invocation.
 */
async function deletionStatements(
	server: string,
	storePaths: number
): Promise<number> {
	await useTestServer(server);
	const { token } = await bootstrap();

	for (let start = 0; start < storePaths; start += pushConcurrency) {
		await Promise.all(
			Array.from(
				{ length: Math.min(pushConcurrency, storePaths - start) },
				(_, offset) =>
					pushPath(token, indexedMetadata(start + offset), 'builds')
			)
		);
	}

	const counting = countingD1(env.CUPBOARD_DB);

	return runInDurableObject(currentServer(), async (instance) => {
		const real = instance.context.d1;

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: drizzleD1(boundedD1(counting.binding), { schema: d1Schema })
		});

		await instance.runCacheTeardown(buildsCache, origin);

		const spent = counting.statementsSent();

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: real
		});

		return spent;
	});
}

/**
 * Counts the D1 statements one alarm pass runs at the deployed chunk size,
 * after a deletion has filled the queue. `maxPathsTornDownPerRun` is derived
 * from a fixed cost per pass and a cost per retirement chunk, and this measures
 * both.
 *
 * The deletion and the pass share one Durable Object invocation, so a delivered
 * alarm cannot drain the queue before the pass this counts.
 */
async function teardownPassStatements(
	server: string,
	storePaths: number
): Promise<number> {
	await useTestServer(server);
	const { token } = await bootstrap();

	for (let start = 0; start < storePaths; start += pushConcurrency) {
		await Promise.all(
			Array.from(
				{ length: Math.min(pushConcurrency, storePaths - start) },
				(_, offset) =>
					pushPath(token, indexedMetadata(start + offset), 'builds')
			)
		);
	}

	const counting = countingD1(env.CUPBOARD_DB);

	return runInDurableObject(currentServer(), async (instance) => {
		const real = instance.context.d1;

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: drizzleD1(boundedD1(counting.binding), { schema: d1Schema })
		});

		await instance.runCacheTeardown(buildsCache, origin);

		const beforePass = counting.statementsSent();
		await instance.resumeCacheTeardown();
		const spent = counting.statementsSent() - beforePass;

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: real
		});

		return spent;
	});
}

function attestationUploadId(index: number): string {
	return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/**
 * Publishes `paths` store paths in `builds`, each carrying `references`
 * attestation references. Every bundle belongs to one path alone, so retiring
 * a reference removes the tenant's last one to that bundle and credits its
 * quota, which is the costliest retirement the drain meets.
 */
async function publishAttestedPaths(
	server: string,
	paths: number,
	references: number
): Promise<void> {
	await useTestServer(server);

	const { token } = await bootstrap();

	for (let index = 0; index < paths; index += 1) {
		const nar = await verifiableNar(`attested-${String(index)}`);
		const metadata = indexedMetadata(index, nar);

		await pushPath(token, metadata, 'builds', nar);

		for (let reference = 0; reference < references; reference += 1) {
			const bundle = index * references + reference;

			await fileAttestationReference({
				uploadId: attestationUploadId(bundle),
				bytes: new TextEncoder().encode(`{"bundle":${String(bundle)}}`),
				cache: 'builds',
				storePathHash: metadata.storePathHash,
				generation: firstNarInfoGeneration
			});
		}
	}
}

/**
 * Counts the D1 statements each teardown pass runs until the drain has emptied
 * the queue, at the deployed chunk size.
 *
 * The deletion and every pass share one Durable Object invocation, so a
 * delivered alarm cannot drain the queue between the counts.
 */
async function attestedTeardownPassStatements(
	server: string,
	paths: number,
	references: number,
	maxPasses = 6
): Promise<number[]> {
	await publishAttestedPaths(server, paths, references);

	const counting = countingD1(env.CUPBOARD_DB);

	return runInDurableObject(currentServer(), async (instance, state) => {
		const real = instance.context.d1;

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: drizzleD1(boundedD1(counting.binding), { schema: d1Schema })
		});

		await instance.runCacheTeardown(buildsCache, origin);

		const perPass: number[] = [];

		for (let taken = 0; taken < maxPasses; taken += 1) {
			const marker = await state.storage.get(
				`${teardownEntryPrefix}${buildsCache}`
			);

			if (marker === undefined) {
				break;
			}

			const before = counting.statementsSent();
			await instance.resumeCacheTeardown();
			perPass.push(counting.statementsSent() - before);
		}

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: real
		});

		return perPass;
	});
}

/**
 * Publishes a private cache holding one path, its own read credential, and the
 * two objects a deletion leaves for its drain: the path's narinfo and its
 * attestation list.
 */
async function publishPrivatePath(server: string): Promise<{
	token: string;
	metadata: ParsedUploadPathMetadata;
	nar: VerifiableNar;
}> {
	await useTestServer(server);

	const { token } = await bootstrap();
	const nar = await verifiableNar(server);
	const metadata = indexedMetadata(0, nar);

	await pushPath(token, metadata, privateBuilds, nar);
	await provisionFixtureTenant({ read: tenantReader });
	await setCacheReadCredential(
		database(),
		fixtureTenant,
		buildsCache,
		cacheReader,
		now
	);
	await publishAttestationList({
		cache: privateBuilds,
		storePathHash: metadata.storePathHash,
		generation: firstNarInfoGeneration
	});

	return { token, metadata, nar };
}

// Reads the narinfo, NAR, attestation-list and availability routes with the
// cache's own credential.
async function readPrivateSurfaces(
	metadata: ParsedUploadPathMetadata,
	nar: VerifiableNar
): Promise<{
	narinfo: number;
	nar: number;
	attestationList: number;
	missing: readonly string[];
}> {
	const narinfo = await readFetch(
		`/private-cache/builds/${metadata.storePathHash}.narinfo`,
		basic(cacheReader)
	);
	const narRead = await readFetch(
		await pushedNarPath(nar, '/private-cache/builds'),
		basic(cacheReader)
	);
	const attestationList = await readFetch(
		`/private-cache/builds/attestations/${metadata.storePathHash}`,
		basic(cacheReader)
	);
	const availability = await readFetch(
		'/private-cache/builds/api/v1/missing-paths',
		{
			method: 'POST',
			headers: {
				...credentialHeaders(cacheReader),
				'content-type': 'application/json'
			},
			body: JSON.stringify({ storePathHashes: [metadata.storePathHash] })
		}
	);
	const availabilityBody = cacheAvailabilityResponseSchema.parse(
		await availability.json()
	);

	return {
		narinfo: narinfo.status,
		nar: narRead.status,
		attestationList: attestationList.status,
		missing: availabilityBody.missingStorePathHashes
	};
}

// Reads one path's narinfo by GET and by HEAD, and asks availability about it,
// all with the cache's own credential.
async function readPrivateNarInfo(storePathHash: StorePathHash): Promise<{
	narinfo: number;
	head: number;
	missing: readonly string[];
}> {
	const path = `/private-cache/builds/${storePathHash}.narinfo`;
	const narinfo = await readFetch(path, basic(cacheReader));
	const head = await readFetch(path, { method: 'HEAD', ...basic(cacheReader) });
	const availability = await readFetch(
		'/private-cache/builds/api/v1/missing-paths',
		{
			method: 'POST',
			headers: {
				...credentialHeaders(cacheReader),
				'content-type': 'application/json'
			},
			body: JSON.stringify({ storePathHashes: [storePathHash] })
		}
	);
	const availabilityBody = cacheAvailabilityResponseSchema.parse(
		await availability.json()
	);

	return {
		narinfo: narinfo.status,
		head: head.status,
		missing: availabilityBody.missingStorePathHashes
	};
}

describe('deleted private cache', () => {
	beforeEach(resetTestServer);

	it('refuses published reads and reports every path missing before teardown drains the objects', async () => {
		const { metadata, nar } = await publishPrivatePath('gen-deleted-surfaces');

		const beforeDeletion = await readPrivateSurfaces(metadata, nar);

		await deleteAndParkTeardown(privateBuilds);

		expect({
			beforeDeletion,
			afterDeletion: await readPrivateSurfaces(metadata, nar),
			// The credential a deletion deliberately keeps, and the objects the
			// parked drain has not removed.
			credentials: await cacheCredentialCaches(),
			narInfoObject:
				(await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, metadata.storePathHash, privateBuilds)
				)) !== null
		}).toStrictEqual({
			beforeDeletion: {
				narinfo: StatusCodes.OK,
				nar: StatusCodes.OK,
				attestationList: StatusCodes.OK,
				missing: []
			},
			afterDeletion: {
				narinfo: StatusCodes.NOT_FOUND,
				nar: StatusCodes.NOT_FOUND,
				attestationList: StatusCodes.NOT_FOUND,
				missing: [metadata.storePathHash]
			},
			credentials: [{ cache: privateBuilds }],
			narInfoObject: true
		});
	});

	it('refuses the previous cache narinfo once the name is registered again', async () => {
		const { token, metadata } = await publishPrivatePath('gen-deleted-narinfo');
		const freshNar = await verifiableNar('narinfo-recreated');
		const fresh = indexedMetadata(1, freshNar);

		await deleteAndParkTeardown(privateBuilds);

		// Registering the name again ends the deleted state while the parked drain
		// still holds the previous cache's published narinfo object. Only the
		// reference edge separates the two caches' paths from here on.
		await pushPath(token, fresh, privateBuilds, freshNar);

		const previousPath = `/private-cache/builds/${metadata.storePathHash}.narinfo`;
		const previous = await readFetch(previousPath, basic(cacheReader));
		const previousHead = await readFetch(previousPath, {
			method: 'HEAD',
			...basic(cacheReader)
		});
		const freshRead = await readFetch(
			`/private-cache/builds/${fresh.storePathHash}.narinfo`,
			basic(cacheReader)
		);
		const availability = await readFetch(
			'/private-cache/builds/api/v1/missing-paths',
			{
				method: 'POST',
				headers: {
					...credentialHeaders(cacheReader),
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					storePathHashes: [metadata.storePathHash, fresh.storePathHash]
				})
			}
		);
		const availabilityBody = cacheAvailabilityResponseSchema.parse(
			await availability.json()
		);

		expect({
			previous: previous.status,
			previousHead: previousHead.status,
			freshRead: freshRead.status,
			missing: availabilityBody.missingStorePathHashes,
			// The refusal comes from the reference check, not from the drain: the
			// previous cache's object is still published.
			previousObject:
				(await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, metadata.storePathHash, privateBuilds)
				)) !== null
		}).toStrictEqual({
			previous: StatusCodes.NOT_FOUND,
			previousHead: StatusCodes.NOT_FOUND,
			freshRead: StatusCodes.OK,
			missing: [metadata.storePathHash],
			previousObject: true
		});
	});

	it('refuses a narinfo object the previous cache left behind at a recommitted path', async () => {
		const { token, metadata } = await publishPrivatePath('gen-recommit-stale');
		const narInfoKey = narInfoObjectKey(
			fixtureTenant,
			metadata.storePathHash,
			privateBuilds
		);
		const previousObject = await env.BLOBS.get(narInfoKey);

		expect(previousObject).not.toBeNull();

		if (previousObject === null) {
			return;
		}

		const previousBody = await previousObject.text();
		const previousMetadata = previousObject.customMetadata;

		await deleteAndParkTeardown(privateBuilds);

		// Recommit the same store path with different NAR contents. The commit
		// writes its new reference edge before publishing the replacement narinfo
		// object.
		const recommittedNar = await verifiableNar('recommitted-contents');

		await pushPath(
			token,
			indexedMetadata(0, recommittedNar),
			privateBuilds,
			recommittedNar
		);

		const afterRecommit = await readPrivateNarInfo(metadata.storePathHash);

		// Restore the previous object to model the interval after the new
		// reference edge is written but before the replacement object is
		// published.
		await env.BLOBS.put(narInfoKey, previousBody, {
			...(previousMetadata !== undefined && {
				customMetadata: previousMetadata
			})
		});

		expect({
			afterRecommit,
			withPreviousObject: await readPrivateNarInfo(metadata.storePathHash)
		}).toStrictEqual({
			afterRecommit: {
				narinfo: StatusCodes.OK,
				head: StatusCodes.OK,
				missing: []
			},
			withPreviousObject: {
				narinfo: StatusCodes.NOT_FOUND,
				head: StatusCodes.NOT_FOUND,
				missing: [metadata.storePathHash]
			}
		});
	});

	it("refuses the previous cache's attestation list after the path is recommitted", async () => {
		const { token, metadata, nar } =
			await publishPrivatePath('gen-deleted-list');

		await deleteAndParkTeardown(privateBuilds);

		// The same path in the cache created next, with no attestation attached to
		// the new commit. The list object the previous cache published is still
		// there, and it describes the generation that cache committed.
		await pushPath(token, metadata, privateBuilds, nar);

		const list = await readFetch(
			`/private-cache/builds/attestations/${metadata.storePathHash}`,
			basic(cacheReader)
		);

		expect({
			list: list.status,
			generation: await narInfoGeneration(metadata.storePathHash),
			listObject:
				(await env.BLOBS.head(
					attestationListObjectKey(
						fixtureTenant,
						metadata.storePathHash,
						privateBuilds
					)
				)) !== null
		}).toStrictEqual({
			list: StatusCodes.NOT_FOUND,
			generation: firstNarInfoGeneration + 1,
			listObject: true
		});
	});

	it('serves new content after the cache name is registered again', async () => {
		const { token } = await publishPrivatePath('gen-deleted-recreate');
		const freshNar = await verifiableNar('recreated-path');
		const fresh = indexedMetadata(1, freshNar);

		await deleteAndParkTeardown(privateBuilds);

		const whileDeleted = await readFetch(
			`/private-cache/builds/${fresh.storePathHash}.narinfo`,
			basic(cacheReader)
		);

		// A push registers the cache name again, which ends the deleted state the
		// deletion recorded. Without that the new cache would answer nothing.
		await pushPath(token, fresh, privateBuilds, freshNar);

		const freshRead = await readFetch(
			`/private-cache/builds/${fresh.storePathHash}.narinfo`,
			basic(cacheReader)
		);
		const freshNarRead = await readFetch(
			await pushedNarPath(freshNar, '/private-cache/builds'),
			basic(cacheReader)
		);

		expect({
			whileDeleted: whileDeleted.status,
			freshRead: freshRead.status,
			freshNarRead: freshNarRead.status,
			generations: await cacheGenerationRows()
		}).toStrictEqual({
			whileDeleted: StatusCodes.NOT_FOUND,
			freshRead: StatusCodes.OK,
			freshNarRead: StatusCodes.OK,
			generations: [{ cache: privateBuilds, generation: 2 }]
		});
	});

	it('refuses attestations from the previous cache after the name is reused', async () => {
		await useTestServer('gen-deleted-bundle');

		const { token } = await bootstrap();
		const nar = await verifiableNar('bundle-path');
		const metadata = indexedMetadata(0, nar);
		const freshNar = await verifiableNar('bundle-fresh-path');
		const fresh = indexedMetadata(1, freshNar);

		await pushPath(token, metadata, 'builds', nar);

		// A reference answers a read only while the edge of the narinfo version it
		// was filed against authorises one, so file it against the generation the
		// first commit of the path took.
		const { digest } = await fileAttestationReference({
			uploadId: '00000000-0000-4000-8000-000000000001',
			bytes: new TextEncoder().encode('{"bundle":true}'),
			cache: 'builds',
			storePathHash: metadata.storePathHash,
			generation: firstNarInfoGeneration
		});
		const bundlePath = `/cache/builds/attestation-bundles/${digest}`;
		const listPath = `/cache/builds/attestations/${metadata.storePathHash}`;

		await publishAttestationList({
			cache: buildsCache,
			storePathHash: metadata.storePathHash,
			generation: firstNarInfoGeneration
		});

		const readAttestations = async (): Promise<{
			list: number;
			bundle: number;
		}> => {
			const list = await readFetch(listPath);
			const bundle = await readFetch(bundlePath);

			return { list: list.status, bundle: bundle.status };
		};

		const beforeDeletion = await readAttestations();

		await deleteAndParkTeardown(buildsCache);

		const afterDeletion = await readAttestations();

		// A cache of the same name again. Neither the reference nor the list object
		// records a cache generation of its own, so only the edges they belong to
		// can keep them from answering this cache's readers.
		await pushPath(token, fresh, 'builds', freshNar);

		const afterRecreation = await readAttestations();
		const filedReferences = await attestationReferenceRows();

		expect({
			beforeDeletion,
			afterDeletion,
			afterRecreation,
			references: filedReferences.map((row) => ({
				cache: row.cache,
				storePathHash: row.storePathHash
			}))
		}).toStrictEqual({
			beforeDeletion: { list: StatusCodes.OK, bundle: StatusCodes.OK },
			afterDeletion: {
				list: StatusCodes.NOT_FOUND,
				bundle: StatusCodes.NOT_FOUND
			},
			afterRecreation: {
				list: StatusCodes.NOT_FOUND,
				bundle: StatusCodes.NOT_FOUND
			},
			references: [
				{ cache: buildsCache, storePathHash: metadata.storePathHash }
			]
		});
	});
});

describe('attestation list generation', () => {
	beforeEach(resetTestServer);

	it('refuses an attestation list published for the generation before a recommit', async () => {
		await useTestServer('gen-stale-list');

		const { token } = await bootstrap();
		const nar = await verifiableNar('stale-list');
		const metadata = indexedMetadata(0, nar);
		const listPath = `/cache/builds/attestations/${metadata.storePathHash}`;

		await pushPath(token, metadata, 'builds', nar);

		const { digest, size } = await fileAttestationReference({
			uploadId: '00000000-0000-4000-8000-000000000001',
			bytes: new TextEncoder().encode('{"bundle":true}'),
			cache: 'builds',
			storePathHash: metadata.storePathHash,
			generation: firstNarInfoGeneration
		});
		await publishAttestationList({
			cache: buildsCache,
			storePathHash: metadata.storePathHash,
			generation: firstNarInfoGeneration,
			attestations: [
				{ digest, size, predicateType: 'https://slsa.dev/provenance/v1' }
			]
		});

		const beforeDeletion = await readFetch(listPath);

		// Park the drain so the list object of the deleted cache survives, then
		// commit the same path again. The new commit takes the next generation and
		// attaches no attestation, so nothing rewrites the object.
		await deleteAndParkTeardown(buildsCache);
		await pushPath(token, metadata, 'builds', nar);

		const afterRecommit = await readFetch(listPath);

		expect({
			beforeDeletion: beforeDeletion.status,
			afterRecommit: afterRecommit.status,
			generation: await narInfoGeneration(metadata.storePathHash)
		}).toStrictEqual({
			beforeDeletion: StatusCodes.OK,
			afterRecommit: StatusCodes.NOT_FOUND,
			generation: firstNarInfoGeneration + 1
		});
	});

	it('serves a public list that records no generation and refuses a private one', async () => {
		await useTestServer('gen-legacy-list');

		const { token } = await bootstrap();
		const publicNar = await verifiableNar('legacy-list-public');
		const privateNar = await verifiableNar('legacy-list-private');
		const publicPath = indexedMetadata(0, publicNar);
		const privatePath = indexedMetadata(1, privateNar);

		await pushPath(token, publicPath, 'builds', publicNar);
		await pushPath(token, privatePath, privateBuilds, privateNar);
		await provisionFixtureTenant({ read: tenantReader });
		await setCacheReadCredential(
			database(),
			fixtureTenant,
			buildsCache,
			cacheReader,
			now
		);

		// The list objects a server that recorded no generation left behind.
		await publishAttestationList({
			cache: buildsCache,
			storePathHash: publicPath.storePathHash
		});
		await publishAttestationList({
			cache: privateBuilds,
			storePathHash: privatePath.storePathHash
		});

		const publicList = await readFetch(
			`/cache/builds/attestations/${publicPath.storePathHash}`
		);
		const privateList = await readFetch(
			`/private-cache/builds/attestations/${privatePath.storePathHash}`,
			basic(cacheReader)
		);

		expect({
			publicList: publicList.status,
			privateList: privateList.status
		}).toStrictEqual({
			publicList: StatusCodes.OK,
			privateList: StatusCodes.NOT_FOUND
		});
	});
});

describe('cache generation gate', () => {
	beforeEach(resetTestServer);

	it('refuses a private-cache read when deletion returns and drains its edges afterwards', async () => {
		await useTestServer('gen-private');
		const { token } = await bootstrap();
		const nar = await verifiableNar('private-shared');
		const paths = [0, 1, 2].map((index) => indexedMetadata(index, nar));

		for (const metadata of paths) {
			await pushPath(token, metadata, privateBuilds, nar);
		}

		await provisionFixtureTenant({ read: tenantReader });
		await setCacheReadCredential(
			database(),
			fixtureTenant,
			buildsCache,
			cacheReader,
			now
		);

		// The cache's own credential opens it, so this read is authorised by the
		// cache's own reference edges rather than by a namespace.
		const narUrl = await pushedNarPath(nar, '/private-cache/builds');
		const beforeDeletion = await readFetch(narUrl, basic(cacheReader));

		// Count the surviving edges in the same Durable Object invocation as the
		// deletion. Once the invocation ends, workerd can deliver the due alarm,
		// whose teardown pass could retire the edges before a later count. The
		// subsequent read returns 404 because the deletion revoked the generation.
		const undrained = await runInDurableObject(
			currentServer(),
			async (instance) => {
				await instance.runCacheTeardown(privateBuilds, origin);

				return blobReferenceRows();
			}
		);
		const afterDeletion = await readFetch(narUrl, basic(cacheReader));

		await driveToCompletion(
			() => currentServer().resumeCacheTeardown(1),
			async () => (await teardownPending(privateBuilds)) === undefined,
			paths.length + 1
		);

		expect({
			beforeDeletion: beforeDeletion.status,
			afterDeletion: afterDeletion.status,
			undrainedEdges: undrained.length,
			edges: await blobReferenceRows(),
			generations: await cacheGenerationRows(),
			credentials: await cacheCredentialCaches()
		}).toStrictEqual({
			beforeDeletion: StatusCodes.OK,
			afterDeletion: StatusCodes.NOT_FOUND,
			undrainedEdges: paths.length,
			edges: [],
			generations: [{ cache: privateBuilds, generation: 2 }],
			credentials: [{ cache: privateBuilds }]
		});
	});

	it('does not let an undrained edge authorise the cache created next', async () => {
		await useTestServer('gen-recreate');
		const { token } = await bootstrap();
		const oldNar = await verifiableNar('recreate-old');
		const newNar = await verifiableNar('recreate-new');
		const oldPath = indexedMetadata(0, oldNar);
		const newPath = indexedMetadata(1, newNar);

		await pushPath(token, oldPath, 'builds', oldNar);
		// The deletion leaves the edge of the deleted cache for its drain, so park
		// the drain and let that edge survive into the lifetime of the next cache
		// of the same name.
		await deleteAndParkTeardown(buildsCache);
		await pushPath(token, newPath, 'builds', newNar);

		const oldRead = await readFetch(await pushedNarPath(oldNar));
		const newRead = await readFetch(await pushedNarPath(newNar));
		const surviving = await blobReferenceRows();

		expect({
			oldRead: oldRead.status,
			newRead: newRead.status,
			generations: await cacheGenerationRows(),
			edges: surviving.map((row) => ({
				storePathHash: row.storePathHash,
				cacheGeneration: row.cacheGeneration
			}))
		}).toStrictEqual({
			oldRead: StatusCodes.NOT_FOUND,
			newRead: StatusCodes.OK,
			generations: [{ cache: buildsCache, generation: 2 }],
			edges: [
				{ storePathHash: oldPath.storePathHash, cacheGeneration: 1 },
				{ storePathHash: newPath.storePathHash, cacheGeneration: 2 }
			]
		});
	});

	it('serves an unstamped edge, stops at deletion, and does not resume at recreation', async () => {
		await useTestServer('gen-legacy');
		const { token } = await bootstrap();
		const legacyNar = await verifiableNar('legacy-edge');
		const freshNar = await verifiableNar('legacy-fresh');
		const legacyPath = indexedMetadata(0, legacyNar);
		const freshPath = indexedMetadata(1, freshNar);

		await seedUnstampedEdge(buildsCache, legacyPath.storePathHash, legacyNar);

		const legacyPathUrl = seededNarPath(legacyNar);
		const beforeDeletion = await readFetch(legacyPathUrl);
		const removal = await removeCache(token);
		const removed = cacheRemoveResponseSchema.parse(await removal.json());
		const afterDeletion = await readFetch(legacyPathUrl);

		// A cache of the same name again. Its own paths read, while the unstamped
		// edge of the deleted cache stays refused.
		await pushPath(token, freshPath, 'builds', freshNar);

		const afterRecreation = await readFetch(legacyPathUrl);
		const freshRead = await readFetch(await pushedNarPath(freshNar));
		const surviving = await blobReferenceRows();
		const legacyEdge = surviving.find(
			(row) => row.storePathHash === legacyPath.storePathHash
		);

		expect({
			beforeDeletion: beforeDeletion.status,
			removed,
			afterDeletion: afterDeletion.status,
			afterRecreation: afterRecreation.status,
			freshRead: freshRead.status,
			legacyCacheGeneration: legacyEdge?.cacheGeneration ?? undefined,
			generations: await cacheGenerationRows()
		}).toStrictEqual({
			beforeDeletion: StatusCodes.OK,
			removed: { name: 'builds', removed: false, storePathsRemoved: 0 },
			afterDeletion: StatusCodes.NOT_FOUND,
			afterRecreation: StatusCodes.NOT_FOUND,
			freshRead: StatusCodes.OK,
			legacyCacheGeneration: undefined,
			generations: [{ cache: buildsCache, generation: 2 }]
		});
	});

	it('drains an edge a previous deletion left behind', async () => {
		await useTestServer('gen-residue');
		await bootstrap();

		const strandedNar = await verifiableNar('residue');
		const stranded = indexedMetadata(0, strandedNar);

		// An edge with no narinfo row behind it: what an interrupted deletion
		// leaves once the row transaction has run and the drain has not. The
		// deletion finds nothing to queue and must still retire this edge.
		await seedUnstampedEdge(buildsCache, stranded.storePathHash, strandedNar);

		// Read the marker in the same invocation as the deletion. Once that
		// invocation ends, workerd can deliver the due alarm. The first pass
		// queues the stranded edge and rearms the alarm; the next retires the
		// edge and clears the marker.
		const queuedForDrain = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				await instance.runCacheTeardown(buildsCache, origin);

				return state.storage.get(`${teardownEntryPrefix}${buildsCache}`);
			}
		);

		await driveToCompletion(
			() => currentServer().resumeCacheTeardown(1),
			async () => (await teardownPending(buildsCache)) === undefined,
			3
		);

		const read = await readFetch(seededNarPath(strandedNar));

		expect({
			queuedForDrain,
			edges: await blobReferenceRows(),
			read: read.status
		}).toStrictEqual({
			queuedForDrain: origin,
			edges: [],
			read: StatusCodes.NOT_FOUND
		});
	});

	it('sweeps a stranded edge after a chunk that emptied the queue', async () => {
		await useTestServer('gen-residue-full-chunk');
		const { token } = await bootstrap();
		const committedNar = await verifiableNar('residue-committed');
		const strandedNar = await verifiableNar('residue-stranded');
		const committed = indexedMetadata(0, committedNar);
		const stranded = indexedMetadata(1, strandedNar);

		await pushPath(token, committed, 'builds', committedNar);
		// An edge with no narinfo row behind it, which is what an interrupted
		// earlier deletion leaves. The transaction that queues the teardown reads
		// the narinfo rows, so it cannot find this one.
		await seedUnstampedEdge(buildsCache, stranded.storePathHash, strandedNar);

		// Delete and drain inside one Durable Object invocation. The deletion arms
		// an alarm, and a pass that alarm ran would drain the whole cache at the
		// deployed cap before this test could observe the state a full chunk
		// leaves.
		//
		// Each pass takes a cap of one against a queue holding exactly one entry:
		// the chunk fills the cap and still empties the queue, so the pass has to
		// sweep for the stranded edge before it can decide that the teardown is
		// over.
		const drained = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const marker = (): Promise<unknown> =>
					state.storage.get(`${teardownEntryPrefix}${buildsCache}`);
				const queuedPaths = (): StorePathHash[] =>
					drizzle(state.storage, { schema: { narInfoDeletions } })
						.select({ storePathHash: narInfoDeletions.storePathHash })
						.from(narInfoDeletions)
						.all()
						.map((row) => row.storePathHash);

				await instance.runCacheTeardown(buildsCache, origin);
				await instance.resumeCacheTeardown(1);

				const afterFullChunk = {
					pending: await marker(),
					queued: queuedPaths()
				};

				await instance.resumeCacheTeardown(1);

				return {
					afterFullChunk,
					pending: await marker(),
					queued: queuedPaths()
				};
			}
		);

		expect({
			...drained,
			edges: await blobReferenceRows()
		}).toStrictEqual({
			// The chunk emptied the queue, and the sweep put the stranded edge in
			// it, so the pass has more to do and keeps the marker.
			afterFullChunk: {
				pending: origin,
				queued: [stranded.storePathHash]
			},
			pending: undefined,
			queued: [],
			edges: []
		});
	});

	it('keeps the deletion D1 statement count independent of how many paths the cache holds', async () => {
		const small = await deletionStatements('gen-budget-small', 1);
		const large = await deletionStatements('gen-budget-large', 120);

		// The generation revocation and the two maintenance-eligibility statements.
		// A deletion that retired a chunk of paths itself would add roughly six
		// statements for every 45 paths and pass the invocation budget on a cache
		// of a few hundred.
		expect({
			small,
			large,
			budget: d1StatementsPerReaperInvocation
		}).toStrictEqual({ small: 3, large: 3, budget: 50 });
	}, 240_000);

	it('keeps a full teardown pass within the D1 statements one invocation may run', async () => {
		const oneChunk = await teardownPassStatements('gen-pass-small', 1);
		const twoChunks = await teardownPassStatements(
			'gen-pass-large',
			maxFencedRetireRows + 1
		);
		// A second chunk adds only its own retirement statements, so the difference
		// is the cost of a chunk and the remainder is what a pass spends whatever
		// it retires.
		const perChunk = twoChunks - oneChunk;
		const perPass = oneChunk - perChunk;

		// The deployed cap in the worst case: every chunk full and the sweep run.
		// Measuring both costs rather than restating the constant means a wider cap
		// or a costlier chunk fails here instead of on Workers Free.
		expect({
			oneChunk,
			twoChunks,
			perChunk,
			perPass,
			worstCase:
				perPass + (maxPathsTornDownPerRun / maxFencedRetireRows) * perChunk,
			budget: d1StatementsPerReaperInvocation
		}).toStrictEqual({
			oneChunk: 9,
			twoChunks: 15,
			perChunk: 6,
			perPass: 3,
			worstCase: 45,
			budget: 50
		});
	}, 240_000);

	it('keeps every attested teardown pass within the D1 statement budget', async () => {
		// Twelve references in one chunk is more attestation work than a pass can
		// afford, so the drain has to stop inside the chunk and resume. Measuring
		// each pass means an attestation retirement that grows costlier fails here
		// instead of on Workers Free.
		const perPass = await attestedTeardownPassStatements(
			'gen-pass-attested',
			3,
			4
		);

		expect({
			perPass,
			worstPass: Math.max(...perPass),
			budget: d1StatementsPerReaperInvocation,
			references: await attestationReferenceRows(),
			edges: await blobReferenceRows()
		}).toStrictEqual({
			// The first pass retires the eight references it can afford beside the
			// chunk's own retirement, and leaves the chunk unfinished. The second
			// retires the last four, finishes the chunk, and sweeps.
			perPass: [43, 29],
			worstPass: 43,
			budget: 50,
			references: [],
			edges: []
		});
	}, 240_000);

	it("credits a digest only when teardown retires the tenant's last reference", async () => {
		await useTestServer('gen-shared-digest');

		const { token } = await bootstrap();
		const tornNar = await verifiableNar('shared-digest-torn');
		const keptNar = await verifiableNar('shared-digest-kept');
		const torn = indexedMetadata(0, tornNar);
		const kept = indexedMetadata(1, keptNar);
		const sharedBytes = new TextEncoder().encode('{"bundle":"shared"}');

		await pushPath(token, torn, 'builds', tornNar);
		await pushPath(token, kept, 'other', keptNar);

		// One bundle both caches reference and one only the torn-down cache does,
		// so the drain meets a three-statement retirement and a five-statement one.
		const shared = await fileAttestationReference({
			uploadId: attestationUploadId(1),
			bytes: sharedBytes,
			cache: 'builds',
			storePathHash: torn.storePathHash,
			generation: firstNarInfoGeneration
		});
		await fileAttestationReference({
			uploadId: attestationUploadId(2),
			bytes: sharedBytes,
			cache: 'other',
			storePathHash: kept.storePathHash,
			generation: firstNarInfoGeneration
		});
		await fileAttestationReference({
			uploadId: attestationUploadId(3),
			bytes: new TextEncoder().encode('{"bundle":"own"}'),
			cache: 'builds',
			storePathHash: torn.storePathHash,
			generation: firstNarInfoGeneration
		});

		await removeCache(token);
		await driveToCompletion(
			() => currentServer().resumeCacheTeardown(),
			async () => (await teardownPending(buildsCache)) === undefined,
			4
		);

		const usage = await tenantUsageRow();
		const remaining = await attestationReferenceRows();
		const presence = await tenantCasBlobRows();

		expect({
			references: remaining.map((row) => ({
				cache: row.cache,
				storePathHash: row.storePathHash,
				digest: row.digest
			})),
			presence: presence.map((row) => row.digest),
			casUsage: { blobs: usage?.casBlobs, bytes: usage?.casBytes }
		}).toStrictEqual({
			references: [
				{
					cache: 'other',
					storePathHash: kept.storePathHash,
					digest: shared.digest
				}
			],
			presence: [shared.digest],
			casUsage: { blobs: 1, bytes: sharedBytes.byteLength }
		});
	});
});
