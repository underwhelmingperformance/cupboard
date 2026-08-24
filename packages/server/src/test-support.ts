import { rootLogger } from '@cupboard/logger';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import { NixPublicKey } from '@cupboard/nix-store/public-key';
import {
	type AuthKeyId,
	authKeyIdSchema,
	DEFAULT_CACHE,
	narInfoGenerationSchema,
	nixKeyNameSchema,
	nixSha256HashSchema,
	type NixSha256HashString,
	predicateTypeSchema,
	selectorForCache,
	type Sha256HexDigest,
	sha256HexDigestSchema,
	type SigningKeyId,
	storedCacheSchema,
	type StorePathHash,
	storePathHashSchema,
	type TenantId,
	tenantIdSchema,
	ttlSecondsSchema,
	WIRE_DEFAULT_CACHE
} from '@cupboard/nix-store/scalars';
import { NixSignature } from '@cupboard/nix-store/signature';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { zstdCompressionStream } from '@cupboard/nix-store/zstd';
import {
	type AuthorizationDetails,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import { instanceNameSchema } from '@cupboard/protocol/instance';
import {
	oidcAudienceSchema,
	type OidcIssuer,
	oidcIssuerSchema,
	oidcSubjectSchema,
	trustRuleIdSchema
} from '@cupboard/protocol/oidc';
import type {
	RootListResponse,
	RootRemoveResponse,
	RootSetBody,
	RootSetResponse
} from '@cupboard/protocol/retention';
import {
	gcResponseSchema,
	rootListResponseSchema,
	rootRemoveResponseSchema,
	rootSetResponseSchema,
	rootTargetsPageSchema
} from '@cupboard/protocol/retention';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	acceptCapabilitiesHeader,
	commitAcceptCapabilitiesHeader,
	commitBatchCapability,
	commitCapabilitiesHeader,
	commitCreditCapability,
	type CommitResponse,
	commitSessionFrameSchema,
	type CommitSessionRequest,
	type DeletePathResponse,
	type ParsedCommitSessionFrame,
	type ParsedUploadActionDecision,
	type ParsedUploadCommitDecision,
	type ParsedUploadDecision,
	type ParsedUploadPathMetadata,
	pathDeletionResponseSchema,
	type PushId,
	type StatsResponse,
	uploadActionDecisionSchema,
	uploadCommitDecisionSchema,
	uploadDecisionSchema,
	uploadGraceFactsCapability,
	type UploadId,
	uploadIdSchema,
	type UploadNegotiateResponse,
	uploadNegotiateResponseSchema,
	type UploadPathMetadataFields,
	uploadPathMetadataSchema,
	type UploadStatusResponse,
	uploadStatusResponseSchema
} from '@cupboard/protocol/upload';
import { readUserInputSchema } from '@cupboard/shared/http';
import {
	createExecutionContext,
	runInDurableObject,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { expect, vi } from 'vitest';
import { z } from 'zod';

import migrations from '../drizzle/migrations.js';

import { issueAccessJwt } from './auth/auth.ts';
import { type NarVerification } from './blob/nar-verify.ts';
import {
	issuePushId,
	pushIdNonceSchema,
	pushIdSigningKeySchema
} from './blob/push-id.ts';
import {
	activeControlKey,
	ensureControlKey
} from './control/control-key-store.ts';
import {
	invalidateTenantRow,
	refreshTenantMembership
} from './control/tenant-membership.ts';
import { generateSigningKey, parseJwk } from './crypto/crypto.ts';
import * as d1Schema from './db/d1-schema.ts';
import {
	blobReference,
	blobState,
	controlTrust,
	tenantBlob
} from './db/d1-schema.ts';
import {
	authKeys,
	generationSeq,
	narInfoDeletions,
	narInfos,
	pendingAttestations,
	pendingUploads,
	signingKeys
} from './db/schema.ts';
import { chunk } from './do/bulk.ts';
import { MaintenanceEligibilityService } from './do/maintenance-eligibility-service.ts';
import { applyMigrations } from './do/migrate.ts';
import type { CupboardServer } from './do/server.ts';
import {
	attestationStagingObjectKey,
	blobReaperGraceMs,
	casObjectKey,
	internalOrigin,
	maxVerificationRpcRows,
	narInfoObjectKey,
	narObjectKey,
	type R2ObjectKey,
	stagingObjectKey
} from './http/http.ts';
import {
	generateReadPasswordSalt,
	hashReadPassword,
	type ReadPasswordHash,
	type ReadPasswordSalt
} from './read/read-auth.ts';
import { tenantServer } from './routing/durable-object.ts';
import { runBlobReaper, verifyTenant } from './routing/scheduled.ts';
import { fixtureTenant } from './routing/tenant-routing.test-support.ts';
import worker from './worker.ts';

// The control-plane bindings live only on the public `cupboard` Worker in
// production, never on the `cupboard-tenant` script the Durable Object runs in. The
// test harness mirrors that: these are absent from the Durable Object's env (the
// pool binds the tenant config) and are supplied only to the control handler when
// a test drives a bare-host control route.
export const testControlEnv = {
	CONTROL_KEY_WRAP_SECRET: 'AAcOFRwjKjE4P0ZNVFtiaXB3foWMk5qhqK+2vcTL0tk=',
	CUPBOARD_CONTROL_AUDIENCE: 'cupboard-control',
	// The signup issuer points at a host that is never reachable in the workers
	// pool, so a signup test exercises everything up to the JWKS fetch; the positive
	// claim is covered end to end against the stub issuer in the e2e suite.
	CUPBOARD_SIGNUP_ISSUER: 'https://signup.example.test',
	CUPBOARD_SIGNUP_AUDIENCE: 'cupboard-control-client'
} as const;

// A real zstd frame: it decompresses to a 1234-byte payload (the bytes
// `i % 256`), so the server's verify-before-serve decompress-and-rehash accepts
// it. `narHash`/`fileHash` are that payload's and this frame's Nix SHA-256s.
export const narBytes = new Uint8Array([
	40, 181, 47, 253, 96, 210, 3, 85, 8, 0, 4, 16, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
	10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
	29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
	48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66,
	67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85,
	86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103,
	104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118,
	119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133,
	134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148,
	149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163,
	164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178,
	179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193,
	194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208,
	209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223,
	224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238,
	239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253,
	254, 255, 1, 0, 0, 207, 7, 170, 53, 5
]);
export const narHash = nixSha256HashSchema.parse(
	'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347'
);
export const fileHash = NixSha256Hash.parse(
	'sha256:0wzw5pz9bciz84825admrb4b848maxa2fh1isbsw4547mvra9czv'
);
export const testBase = new Date('2026-01-01T00:00:00.000Z');

// The owner identity the fixture tenant is provisioned with, matching the
// triple the admin-token and trust-rule tests issue their subject tokens for.
export const fixtureOwner = {
	issuer: oidcIssuerSchema.parse('https://accounts.google.com'),
	subject: oidcSubjectSchema.parse('owner-subject'),
	audience: oidcAudienceSchema.parse('client-id.apps.googleusercontent.com')
} as const;

// The owner triple for a tenant provisioned without an owner: every field is
// empty, so no owner rule is seeded.
const emptyOwner = {
	ownerIssuer: oidcIssuerSchema.parse(''),
	ownerSubject: oidcSubjectSchema.parse(''),
	ownerAudience: oidcAudienceSchema.parse('')
} as const;

const harness = {
	origin: 'https://cupboard.test',
	server: testServerFor('initial'),
	serverName: 'initial',
	nextTestServerId: 0,
	nextProvisionConfigVersion: 1
};

export type UploadDecision = UploadNegotiateResponse['uploads'][number];

export interface GcResult {
	readonly ok: true;
	readonly pendingUploadsDeleted: number;
	readonly pendingAttestationsDeleted: number;
	readonly rootsExpired: number;
	readonly pathsCollected: number;
	readonly narInfosDeleted: number;
	readonly orphanStagingDeleted: number;
}

/**
 * Points the harness at a fresh, isolated Durable Object so each test starts
 * from empty state, and configures it as the fixture tenant. The origin and the
 * DO name share the same counter so the URL and the stub agree.
 */
export async function resetTestServer(): Promise<void> {
	harness.origin = `https://cupboard-${String(harness.nextTestServerId)}.test`;
	harness.serverName = `test-${String(harness.nextTestServerId)}`;
	harness.server = testServerFor(harness.serverName);
	harness.nextTestServerId += 1;

	await configureFixtureTenant(harness.server);
	await configureFixtureTenant(fixtureWorkerServer());
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	await database.delete(d1Schema.instanceConfig).run();
	await database
		.insert(d1Schema.instanceConfig)
		.values({
			id: 'singleton',
			name: instanceNameSchema.parse('cupboard'),
			createdAt: isoTimestamp(testBase)
		})
		.run();
	await provisionFixtureTenant();
}

/**
 * Writes the fixture tenant's authoritative D1 row and refreshes the negative
 * membership hints. `readMode` selects public or private reads; `read` supplies
 * the verifier for a private tenant. Repeated calls can change the mode without
 * resetting usage counters.
 */
export async function provisionFixtureTenant(
	options: {
		readonly readMode?: 'public' | 'private';
		readonly read?: { readonly user: string; readonly password: string };
		readonly quotaBytes?: number;
	} = {}
): Promise<void> {
	const readMode = options.readMode ?? 'public';
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const readUser =
		options.read === undefined
			? undefined
			: readUserInputSchema.parse(options.read.user);
	let readPasswordHash: ReadPasswordHash | undefined;
	let readPasswordSalt: ReadPasswordSalt | undefined;

	if (options.read !== undefined) {
		readPasswordSalt = generateReadPasswordSalt();
		readPasswordHash = await hashReadPassword(
			options.read.password,
			readPasswordSalt
		);
	}
	const now = isoTimestamp(testBase);

	await database
		.insert(d1Schema.tenant)
		.values({
			id: fixtureTenant,
			status: 'active',
			readMode,
			ownerIssuer: fixtureOwner.issuer,
			ownerSubject: fixtureOwner.subject,
			ownerAudience: fixtureOwner.audience,
			configVersion: 1,
			createdAt: now,
			readUser,
			readPasswordHash,
			readPasswordSalt
		})
		.onConflictDoUpdate({
			target: d1Schema.tenant.id,
			set: { readMode, readUser, readPasswordHash, readPasswordSalt }
		})
		.run();

	// The usage row is created with the tenant; a later call (e.g. switching read
	// mode) updates only the quota, leaving the accumulated counters intact.
	await database
		.insert(d1Schema.tenantUsage)
		.values({
			tenant: fixtureTenant,
			bytes: 0,
			narinfos: 0,
			blobs: 0,
			quotaBytes: options.quotaBytes,
			updatedAt: now
		})
		.onConflictDoUpdate({
			target: d1Schema.tenantUsage.tenant,
			set: { quotaBytes: options.quotaBytes, updatedAt: now }
		})
		.run();

	await refreshTenantMembership(env);
	await invalidateTenantRow(fixtureTenant);
}

/**
 * Provisions a named tenant for a route-level test: writes its D1 row,
 * optionally configures its Durable Object with its path-based issuer, and
 * seeds the membership filter and marker. Returns the tenant's issuer URL. Pass
 * `configure: false` to admit a slug whose Durable Object stays unconfigured, so a
 * test can prove that the route 500s on an unconfigured identity.
 */
export async function provisionNamedTenant(
	name: string,
	options: {
		readonly readMode?: 'public' | 'private';
		configure?: boolean;
	} = {}
): Promise<OidcIssuer> {
	const id = tenantIdSchema.parse(name);
	const readMode = options.readMode ?? 'public';
	const issuer = oidcIssuerSchema.parse(`${harness.origin}/t/${id}`);
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

	// The workers pool keeps a Durable Object warm across tests, so a fixed-name
	// tenant starts from empty private state before receiving this test's identity.
	harness.nextProvisionConfigVersion += 1;
	const configVersion = harness.nextProvisionConfigVersion;
	const stub = tenantServer(env, id);
	await stub.purgeStorage();

	await database
		.insert(d1Schema.tenant)
		.values({
			id,
			status: 'active',
			readMode,
			ownerIssuer: '',
			ownerSubject: '',
			ownerAudience: '',
			configVersion,
			createdAt: isoTimestamp(testBase)
		})
		.onConflictDoUpdate({
			target: d1Schema.tenant.id,
			set: { status: 'active', readMode, configVersion }
		})
		.run();

	await database
		.insert(d1Schema.tenantUsage)
		.values({
			tenant: id,
			bytes: 0,
			narinfos: 0,
			blobs: 0,
			updatedAt: isoTimestamp(testBase)
		})
		.onConflictDoNothing()
		.run();

	if (options.configure !== false) {
		await stub.configure({
			tenant: id,
			issuer,
			audience: oidcAudienceSchema.parse(issuer),
			...emptyOwner,
			configVersion
		});
	}

	await refreshTenantMembership(env);
	await invalidateTenantRow(tenantIdSchema.parse(id));

	return issuer;
}

/**
 * Marks a provisioned tenant suspended, as the control plane does. Every
 * admission reads the updated D1 status. The invalidation call remains as a
 * deployment-compatibility boundary and is a no-op in current code.
 */
export async function suspendTenant(id: string): Promise<void> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

	await database
		.update(d1Schema.tenant)
		.set({ status: 'suspended' })
		.where(eq(d1Schema.tenant.id, tenantIdSchema.parse(id)))
		.run();
	await invalidateTenantRow(tenantIdSchema.parse(id));
}

/**
 * Begins offboarding a provisioned tenant, as the control plane does. It updates
 * the authoritative D1 status and tells the Durable Object to stop
 * re-materialising its objects, so the cron can drain them. The invalidation
 * call is a no-op retained for deployments with the old row cache.
 */
export async function offboardTenant(id: string): Promise<void> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

	await database
		.update(d1Schema.tenant)
		.set({ status: 'offboarding' })
		.where(eq(d1Schema.tenant.id, tenantIdSchema.parse(id)))
		.run();
	await invalidateTenantRow(tenantIdSchema.parse(id));
	await tenantServer(env, tenantIdSchema.parse(id)).beginOffboard();
}

/**
A tenant's registry row, for asserting the offboarding lifecycle.
*/
export async function tenantRow(id: string): Promise<
	| undefined
	| {
			status: string;
			readUser: string | undefined;
			readPasswordHash: string | undefined;
			readPasswordSalt: string | undefined;
	  }
> {
	const row = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select({
			status: d1Schema.tenant.status,
			readUser: d1Schema.tenant.readUser,
			readPasswordHash: d1Schema.tenant.readPasswordHash,
			readPasswordSalt: d1Schema.tenant.readPasswordSalt
		})
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.id, tenantIdSchema.parse(id)))
		.get();

	if (row === undefined) {
		return undefined;
	}

	// A cleared credential reads as undefined, so a test asserts the scrub without a
	// null literal.
	return {
		status: row.status,
		readUser: row.readUser ?? undefined,
		readPasswordHash: row.readPasswordHash ?? undefined,
		readPasswordSalt: row.readPasswordSalt ?? undefined
	};
}

/**
The R2 object keys under a tenant's namespace, sorted, for drain assertions.
*/
export async function tenantObjectKeys(id: string): Promise<string[]> {
	const listed = await env.BLOBS.list({ prefix: `t/${id}/` });

	return listed.objects.map((object) => object.key).toSorted(byCodeUnit);
}

/**
The origin the harness is currently targeting.
*/
export function currentOrigin(): string {
	return harness.origin;
}

// The issuer and audience the Durable Object is configured with and issues under in
// low-level tests. A fixed value, independent of the per-test origin, so a token
// stays valid when a test switches origin via useTestServer. Route-level behaviour
// (a provisioned tenant's path-based issuer) is proved separately.
const tenantTestIssuer = 'cupboard';

// Configures a Durable Object as the fixture tenant, the way provisioning would,
// with the fixed legacy issuer for low-level token round-trips.
async function configureFixtureTenant(
	stub: DurableObjectStub<CupboardServer>
): Promise<void> {
	const issuer = tenantTestIssuer;

	await stub.configure({
		tenant: fixtureTenant,
		issuer: oidcIssuerSchema.parse(issuer),
		audience: oidcAudienceSchema.parse(issuer),
		ownerIssuer: fixtureOwner.issuer,
		ownerSubject: fixtureOwner.subject,
		ownerAudience: fixtureOwner.audience,
		configVersion: 1
	});
}

/**
 * Redirects the harness at a named server, e.g. for a test that needs a
 * distinct DO from the one {@link resetTestServer} assigned, configuring it.
 */
export async function useTestServer(name: string): Promise<void> {
	harness.origin = `https://cupboard-${name}.test`;
	harness.serverName = name;
	harness.server = testServerFor(name);

	await configureFixtureTenant(harness.server);
	await provisionFixtureTenant();
}

export function testServerFor(name: string): DurableObjectStub<CupboardServer> {
	return tenantServer(env, tenantIdSchema.parse(name));
}

/**
The Durable Object stub the harness is currently targeting.
*/
export function currentServer(): DurableObjectStub<CupboardServer> {
	return harness.server;
}

/**
 * Claims an upload and records one owner-fenced verification verdict.
 */
export async function recordClaimedVerification(
	uploadId: UploadId,
	verification: NarVerification
): Promise<number> {
	const claim = await currentServer().claimVerificationBatch(
		maxVerificationRpcRows,
		Number.MAX_SAFE_INTEGER
	);

	return currentServer().recordVerifications(claim.owner, [
		{ uploadId, verdict: { kind: 'verified', verification } }
	]);
}

/**
 * Claims an upload and records that its staged object is missing.
 */
export async function recordClaimedMissingObject(
	uploadId: UploadId
): Promise<number> {
	const claim = await currentServer().claimVerificationBatch(
		maxVerificationRpcRows,
		Number.MAX_SAFE_INTEGER
	);

	return currentServer().recordVerifications(claim.owner, [
		{ uploadId, verdict: { kind: 'missing' } }
	]);
}

/**
 * Clears any alarm the test's Durable Objects left armed. A test's objects
 * are abandoned when it ends (the next test points the harness elsewhere),
 * and an armed alarm on an abandoned object fires into a test environment
 * that has moved on: its handler's console output then races the pool's log
 * forwarding and surfaces as teardown errors. The shared `afterEach` calls
 * this. It covers the server the harness currently points at and the fixture
 * tenant's object; a test that arms an alarm on any other object clears that
 * one itself.
 */
export async function clearAbandonedAlarms(): Promise<void> {
	for (const stub of [harness.server, fixtureWorkerServer()]) {
		await runInDurableObject(stub, (_instance, state) =>
			state.storage.deleteAlarm()
		);
	}
}

/**
 * Drives a capped maintenance drain to completion: runs `step` until `isDone`
 * returns true, at most `maxSteps` times. A capped pass advances only when an
 * alarm or an explicit resume call runs it again, so a test watching one
 * drain makes those calls itself. Every call makes progress, so the number of
 * steps a drain needs follows from the fixture and the cap, not from how fast
 * the machine is.
 *
 * The caller asserts the terminal state after the loop. If the drain has not
 * finished within `maxSteps`, those assertions fail and their output shows
 * the state the drain reached. If `step` throws, the error propagates
 * immediately.
 */
export async function driveToCompletion(
	step: () => Promise<void>,
	isDone: () => Promise<boolean>,
	maxSteps: number
): Promise<void> {
	for (let taken = 0; taken < maxSteps; taken += 1) {
		if (await isDone()) {
			return;
		}

		await step();
	}
}

/**
 * The slug the current harness server is addressed by, for a worker-side call
 * (a queue consumer) that resolves the same Durable Object through
 * `tenantServer(env, tenant)`.
 */
export function currentServerTenant(): TenantId {
	return tenantIdSchema.parse(harness.serverName);
}

/**
Runs the production queue-consumer verification path for the current tenant.
*/
export function verifyCurrentTenant(): Promise<void> {
	return verifyTenant(rootLogger(), env, currentServerTenant());
}

export interface InitialisedServer {
	readonly url: string;
	readonly publicKey: string;
	readonly token: string;
}

/**
 * Brings a server up the way a deployment is: it issues an owner-equivalent admin
 * token from the active auth key and reads the published signing key, standing
 * in for what the old bootstrap exchange returned.
 */
export async function bootstrap(): Promise<InitialisedServer> {
	const token = await issueServerSignedToken(adminGrants());
	const response = await fetchPath('/pubkey');
	const body = await response.text();

	return { url: harness.origin, publicKey: body.trim(), token };
}

/**
An admin token against the current per-test server.
*/
export function initialise(): Promise<string> {
	return issueServerSignedToken(adminGrants());
}

/**
An admin token against the shared `v1` server the Worker routes to.
*/
export function initialiseViaWorker(): Promise<string> {
	return issueServerSignedTokenFor(fixtureWorkerServer(), adminGrants());
}

// The cache operations the old `write` scope (a CI push) carried: upload and
// attestation. Root writes are granted per root selector so a token can set
// only the roots its rule named.
const cacheWriteActions = [
	'upload:negotiate',
	'upload:status',
	'upload:commit',
	'attestation:negotiate',
	'attestation:attach'
] as const;

/**
The owner's grant set: a single wildcard covering every operation.
*/
export function adminGrants(): AuthorizationDetails {
	return [{ type: 'cupboard_wildcard' }];
}

/**
 * A CI-style write grant set: upload and attestation on one cache, plus
 * `root:set` on each named root selector. It authorises exactly the push path,
 * so tests can prove an admin-only route refuses it.
 */
export function cacheWriteGrants(
	roots: readonly string[] = [],
	cacheSelector: string = WIRE_DEFAULT_CACHE
): AuthorizationDetails {
	return authorizationDetailsSchema.parse([
		{
			type: 'cupboard_cache',
			actions: cacheWriteActions,
			cache: cacheSelector
		},
		...roots.map((root) => ({
			type: 'cupboard_cache',
			actions: ['root:set'],
			cache: cacheSelector,
			root
		}))
	]);
}

/**
 * Issues an access token signed by the active server key carrying an explicit
 * grant set, so tests can prove authorisation (e.g. a write grant refused by an
 * admin route). The active key is the newest one still in service, matching what
 * the server issues with, so a token stays valid across a rotation.
 */
export function issueServerSignedToken(
	grants: AuthorizationDetails,
	subject = 'grant-test'
): Promise<string> {
	return issueServerSignedTokenFor(harness.server, grants, subject);
}

async function issueServerSignedTokenFor(
	stub: DurableObjectStub<CupboardServer>,
	grants: AuthorizationDetails,
	subject = 'grant-test'
): Promise<string> {
	const key = await activeAuthKeyFor(stub);

	return issueAccessJwt(
		key.privateJwk,
		{
			issuer: oidcIssuerSchema.parse(tenantTestIssuer),
			audience: oidcAudienceSchema.parse(tenantTestIssuer),
			subject: oidcSubjectSchema.parse(subject),
			grants,
			kid: key.kid,
			ttlSeconds: ttlSecondsSchema.parse(600)
		},
		new Date()
	);
}

/**
 * Issues a token signed by a Durable Object's active auth key but pinned to an
 * explicit issuer and audience, so a route-level test can verify a tenant issues
 * under its own path-based issuer.
 */
export async function issueTokenForTenant(
	stub: DurableObjectStub<CupboardServer>,
	issuer: OidcIssuer,
	grants: AuthorizationDetails,
	subject = 'route-test'
): Promise<string> {
	const key = await activeAuthKeyFor(stub);

	return issueAccessJwt(
		key.privateJwk,
		{
			issuer,
			audience: oidcAudienceSchema.parse(issuer),
			subject: oidcSubjectSchema.parse(subject),
			grants,
			kid: key.kid,
			ttlSeconds: ttlSecondsSchema.parse(600)
		},
		new Date()
	);
}

async function activeAuthKeyFor(
	stub: DurableObjectStub<CupboardServer>
): Promise<{ kid: AuthKeyId; privateJwk: JsonWebKey }> {
	// The auth key is created on first use; a JWKS request creates it without
	// issuing anything, so reading it straight after always finds a key.
	const jwks = await stub.fetch(
		new URL('/.well-known/jwks.json', harness.origin)
	);
	expect(jwks.status).toBe(StatusCodes.OK);
	await jwks.text();

	return runInDurableObject(stub, (_instance, state) => {
		const database = drizzle(state.storage, { schema: { authKeys } });
		const row = z
			.object({
				kid: authKeyIdSchema,
				privateJwkJson: z.string()
			})
			.parse(
				database
					.select()
					.from(authKeys)
					.where(isNull(authKeys.retiredAt))
					.orderBy(sql`rowid`)
					.all()
					.at(-1)
			);

		return {
			kid: row.kid,
			privateJwk: parseJwk(row.privateJwkJson)
		};
	});
}

// Deployment endpoints stay at the bare host; everything else a read addresses is
// tenant content, served under the fixture tenant's prefix the Worker routes by.
function tenantReadPath(pathname: string): string {
	return pathname.startsWith('/_')
		? pathname
		: `/t/${fixtureTenant}${pathname}`;
}

export function fetchPath(
	pathname: string,
	init?: RequestInit
): Promise<Response> {
	return harness.server.fetch(new URL(pathname, harness.origin), init);
}

export function workerFetch(
	pathname: string,
	init?: RequestInit
): Promise<Response> {
	return fixtureWorkerServer().fetch(new URL(pathname, harness.origin), init);
}

export function readFetch(
	pathname: string,
	init?: RequestInit
): Promise<Response> {
	return handlerFetch(tenantReadPath(pathname), init);
}

// Drives the real Worker handler for an exact path (no tenant prefix added), so a
// test can exercise routing, admission and dispatch for any `/t/<slug>/…` path.
export async function handlerFetch(
	pathname: string,
	init?: RequestInit
): Promise<Response> {
	const ctx = createExecutionContext();
	const request = new Request<unknown, IncomingRequestCfProperties>(
		new URL(pathname, harness.origin),
		init as RequestInit<IncomingRequestCfProperties>
	);
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);

	return response;
}

/**
What {@link flakyD1} injects: how many matching reads throw before it heals.
*/
export interface FlakyD1Plan {
	failures: number;
	/**
	Restricts the faults to matching queries; every query when absent.
	*/
	readonly matches?: (query: string) => boolean;
	/**
	The error message to throw; defaults to 'transient D1 fault'.
	*/
	readonly message?: string;
	/**
	 * Runs when a matching query is prepared, before any fault is applied: a
	 * deterministic point for a test to interleave a concurrent mutation with
	 * the code under test.
	 */
	readonly onMatch?: () => void;
}

/**
 * A D1 binding whose next `failures` matching reads throw, then delegates: the
 * shape of a transient control-plane fault under an authoritative D1 read.
 */
export function flakyD1(inner: D1Database, plan: FlakyD1Plan): D1Database {
	return {
		prepare(query) {
			if (plan.matches?.(query) ?? true) {
				plan.onMatch?.();

				if (plan.failures > 0) {
					plan.failures -= 1;
					throw new Error(plan.message ?? 'transient D1 fault');
				}
			}

			return inner.prepare(query);
		},
		batch: (statements) => inner.batch(statements),
		exec: (query) => inner.exec(query),
		withSession: (constraint) => inner.withSession(constraint),
		// The request-path reads never dump; the member exists only to satisfy
		// the binding's shape.
		dump: () => Promise.reject(new Error('dump is not supported here'))
	};
}

export interface FlakyR2Plan {
	failures: number;
	/**
	The error message to throw; defaults to 'transient R2 fault'.
	*/
	readonly message?: string;
	/**
	 * Runs when a head probe is issued, before any fault is applied: a
	 * deterministic point for a test to interleave a concurrent mutation with
	 * the code under test.
	 */
	readonly onMatch?: () => void;
}

/**
 * An R2 binding whose next `failures` head probes throw, then delegates: the
 * shape of a transient storage fault under a presence check. Every other
 * operation passes straight through.
 */
export function flakyR2(inner: R2Bucket, plan: FlakyR2Plan): R2Bucket {
	return {
		head(key) {
			plan.onMatch?.();

			if (plan.failures > 0) {
				plan.failures -= 1;
				throw new Error(plan.message ?? 'transient R2 fault');
			}

			return inner.head(key);
		},
		get: inner.get.bind(inner),
		put: inner.put.bind(inner),
		delete: inner.delete.bind(inner),
		list: inner.list.bind(inner),
		createMultipartUpload: inner.createMultipartUpload.bind(inner),
		resumeMultipartUpload: inner.resumeMultipartUpload.bind(inner)
	};
}

// Fetches a bare-host path through the real Worker (the control surface, with no
// tenant prefix). A per-call env copy lets a test vary the control configuration.
export async function controlFetch(
	pathname: string,
	init?: RequestInit,
	envOverride: Readonly<Record<string, string>> = {}
): Promise<Response> {
	const ctx = createExecutionContext();
	const request = new Request<unknown, IncomingRequestCfProperties>(
		new URL(pathname, harness.origin),
		init as RequestInit<IncomingRequestCfProperties>
	);
	const response = await worker.fetch(
		request,
		Object.assign({}, env, testControlEnv, envOverride),
		ctx
	);
	await waitOnExecutionContext(ctx);

	return response;
}

// The Request-shaped variant of {@link controlFetch}, for callers that build
// their own requests (the derived contract client's link).
export async function controlWorkerFetch(request: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		new Request<unknown, IncomingRequestCfProperties>(request),
		Object.assign({}, env, testControlEnv),
		ctx
	);
	await waitOnExecutionContext(ctx);

	return response;
}

// A control admin token, issued the way the control plane does: signed by the
// active control key for the control issuer (the current origin) and audience.
export async function issueControlAdminToken(
	subject = 'global-admin',
	grants: AuthorizationDetails = adminGrants()
): Promise<string> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const wrappingSecret = testControlEnv.CONTROL_KEY_WRAP_SECRET;

	const ensureAt = new Date();
	await ensureControlKey(database, wrappingSecret, isoTimestamp(ensureAt));
	const active = await activeControlKey(database, wrappingSecret);

	const originUrl = new URL(harness.origin);
	return issueAccessJwt(
		active.privateJwk,
		{
			issuer: oidcIssuerSchema.parse(originUrl.origin),
			audience: oidcAudienceSchema.parse(
				testControlEnv.CUPBOARD_CONTROL_AUDIENCE
			),
			subject: oidcSubjectSchema.parse(subject),
			grants,
			kid: active.kid,
			ttlSeconds: ttlSecondsSchema.parse(600)
		},
		new Date()
	);
}

// Seeds a control trust rule directly, standing in for the gated first-signup
// claim that will seed it. A pinned `sub` goes in `claims`, matched exactly.
export async function seedControlTrust(fields: {
	readonly issuer: string;
	readonly audience: string;
	readonly claims?: Readonly<Record<string, string>>;
}): Promise<void> {
	const createdAt = new Date();
	await drizzleD1(env.CUPBOARD_DB, { schema: { controlTrust } })
		.insert(controlTrust)
		.values({
			id: trustRuleIdSchema.parse(crypto.randomUUID()),
			issuer: fields.issuer,
			audience: fields.audience,
			claimsJson: JSON.stringify(fields.claims ?? {}),
			createdAt: isoTimestamp(createdAt)
		})
		.run();
}

export async function authorisedFetch(
	pathname: string,
	token: string,
	init: RequestInit = {}
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('authorization', `Bearer ${token}`);

	return fetchPath(pathname, {
		...init,
		headers
	});
}

export async function authorisedWorkerFetch(
	pathname: string,
	token: string,
	init: RequestInit = {}
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('authorization', `Bearer ${token}`);

	return workerFetch(pathname, {
		...init,
		headers
	});
}

export async function clearBlobStorage(): Promise<void> {
	const listed = await env.BLOBS.list();
	const keys = listed.objects.map((object) => object.key);

	await env.BLOBS.delete(keys);
}

/**
The R2 key for the incarnation D1 currently records for a NAR.
*/
export async function currentNarObjectKey(
	narHash: NixSha256HashString
): Promise<R2ObjectKey> {
	const row = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select({ incarnation: d1Schema.objectIncarnation.incarnation })
		.from(d1Schema.objectIncarnation)
		.where(
			and(
				eq(d1Schema.objectIncarnation.kind, 'nar'),
				eq(d1Schema.objectIncarnation.objectId, narHash)
			)
		)
		.get();

	if (row === undefined) {
		throw new TypeError(`No NAR incarnation is registered for ${narHash}`);
	}

	return narObjectKey(narHash, row.incarnation);
}

/**
The R2 key for the incarnation D1 currently records for a CAS object.
*/
export async function currentCasObjectKey(
	digest: Sha256HexDigest
): Promise<R2ObjectKey> {
	const row = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select({ incarnation: d1Schema.objectIncarnation.incarnation })
		.from(d1Schema.objectIncarnation)
		.where(
			and(
				eq(d1Schema.objectIncarnation.kind, 'cas'),
				eq(d1Schema.objectIncarnation.objectId, digest)
			)
		)
		.get();

	if (row === undefined) {
		throw new TypeError(`No CAS incarnation is registered for ${digest}`);
	}

	return casObjectKey(digest, row.incarnation);
}

/**
The shared `blob_state` rows in D1, sorted by NAR hash for deterministic assertions.
*/
export async function blobStateNarHashes(): Promise<
	{ narHash: NixSha256HashString }[]
> {
	const rows = await drizzleD1(env.CUPBOARD_DB, { schema: { blobState } })
		.select({ narHash: blobState.narHash })
		.from(blobState)
		.all();

	return rows.toSorted((left, right) =>
		byCodeUnit(left.narHash, right.narHash)
	);
}

/**
How many shared blobs D1 records as available.
*/
export async function blobStateCount(): Promise<number> {
	const row = await drizzleD1(env.CUPBOARD_DB, { schema: { blobState } })
		.select({ count: count() })
		.from(blobState)
		.get();

	return row?.count ?? 0;
}

// The Nix base32 alphabet (no e, o, t or u), for fabricating syntactically
// valid hashes when a test seeds shared facts in volume.
const nixBase32Alphabet = '0123456789abcdfghijklmnpqrsvwxyz';

/**
A deterministic, syntactically valid NAR hash derived from an index.
*/
export function syntheticNarHash(index: number): NixSha256HashString {
	let remaining = index;
	let suffix = '';

	for (let position = 0; position < 8; position += 1) {
		suffix = nixBase32Alphabet.charAt(remaining % 32) + suffix;
		remaining = Math.floor(remaining / 32);
	}

	return nixSha256HashSchema.parse(`sha256:${'0'.repeat(44)}${suffix}`);
}

/**
 * A deterministic, syntactically valid store-path hash derived from an index,
 * whose lexical order tracks the index so a seeded backlog drains predictably.
 */
export function syntheticStorePathHash(index: number): StorePathHash {
	let remaining = index;
	let suffix = '';

	for (let position = 0; position < 4; position += 1) {
		suffix = nixBase32Alphabet.charAt(remaining % 32) + suffix;
		remaining = Math.floor(remaining / 32);
	}

	return storePathHashSchema.parse(`${'0'.repeat(28)}${suffix}`);
}

/**
A deterministic, syntactically valid CAS digest derived from an index.
*/
export function syntheticCasDigest(index: number): Sha256HexDigest {
	return sha256HexDigestSchema.parse(index.toString(16).padStart(64, '0'));
}

/**
Seeds shared blob facts directly, for tests that need candidate volume.
*/
export async function seedBlobStates(
	narHashes: readonly NixSha256HashString[]
): Promise<void> {
	const verifiedAt = isoTimestamp(new Date());
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

	// Each row binds six parameters, so the insert is chunked under D1's
	// bound-parameter limit.
	for (const batch of chunk(narHashes, 12)) {
		await database.batch([
			database.insert(blobState).values(
				batch.map((narHash) => ({
					narHash,
					fileHash: narHash,
					fileSize: 1,
					compression: 'zstd' as const,
					narSize: 1,
					verifiedAt
				}))
			),
			database.insert(d1Schema.objectIncarnation).values(
				batch.map((narHash) => ({
					kind: 'nar' as const,
					objectId: narHash,
					incarnation: 1,
					state: 'live' as const
				}))
			)
		]);
	}
}

/**
Seeds shared CAS object facts directly, for tests that need candidate volume.
*/
export async function seedCasObjects(
	digests: readonly Sha256HexDigest[]
): Promise<void> {
	const storedAt = isoTimestamp(new Date());
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

	for (const batch of chunk(digests, 20)) {
		await database.batch([
			database
				.insert(d1Schema.casObject)
				.values(batch.map((digest) => ({ digest, size: 1, storedAt }))),
			database.insert(d1Schema.objectIncarnation).values(
				batch.map((digest) => ({
					kind: 'cas' as const,
					objectId: digest,
					incarnation: 1,
					state: 'live' as const
				}))
			)
		]);
	}
}

/**
Arms a shared blob's reaper grace timer directly.
*/
export async function armBlobReaperTimer(
	narHash: NixSha256HashString,
	graceUntil: IsoTimestamp = isoTimestamp(new Date(Date.now() + 60_000))
): Promise<void> {
	await drizzleD1(env.CUPBOARD_DB, { schema: { blobState } })
		.update(blobState)
		.set({ deleteAfter: graceUntil })
		.where(eq(blobState.narHash, narHash))
		.run();
}

/**
The shared blob facts with their reaper timers, sorted by NAR hash.
*/
export async function blobStateArmTimes(): Promise<
	{ narHash: NixSha256HashString; deleteAfter: string | undefined }[]
> {
	const rows = await drizzleD1(env.CUPBOARD_DB, { schema: { blobState } })
		.select({ narHash: blobState.narHash, deleteAfter: blobState.deleteAfter })
		.from(blobState)
		.all();

	return rows
		.map((row) => ({ ...row, deleteAfter: row.deleteAfter ?? undefined }))
		.toSorted((left, right) => byCodeUnit(left.narHash, right.narHash));
}

/**
 * Whether the cron has stamped a tenant as maintained, for asserting which tenants a
 * pass picked up: the maintenance pass orders active tenants by `last_maintained_at`
 * (oldest first, NULL first) and stamps the batch it processes.
 */
export async function wasTenantMaintained(id: string): Promise<boolean> {
	const row = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select({ lastMaintainedAt: d1Schema.tenant.lastMaintainedAt })
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.id, tenantIdSchema.parse(id)))
		.get();

	return (row?.lastMaintainedAt ?? undefined) !== undefined;
}

/**
The durable cron pass record for one tenant/pass pair.
*/
export async function tenantMaintenanceFailureRow(
	id: string,
	pass: typeof d1Schema.tenantMaintenanceFailure.$inferSelect.pass
): Promise<
	| undefined
	| {
			consecutiveFailures: number;
			lastError: string | undefined;
			lastFailedAt: string | undefined;
			lastSuccessAt: string | undefined;
	  }
> {
	const tenant = tenantIdSchema.parse(id);
	const row = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select({
			consecutiveFailures:
				d1Schema.tenantMaintenanceFailure.consecutiveFailures,
			lastError: d1Schema.tenantMaintenanceFailure.lastError,
			lastFailedAt: d1Schema.tenantMaintenanceFailure.lastFailedAt,
			lastSuccessAt: d1Schema.tenantMaintenanceFailure.lastSuccessAt
		})
		.from(d1Schema.tenantMaintenanceFailure)
		.where(
			and(
				eq(d1Schema.tenantMaintenanceFailure.tenant, tenant),
				eq(d1Schema.tenantMaintenanceFailure.pass, pass)
			)
		)
		.get();

	if (row === undefined) {
		return undefined;
	}

	return {
		consecutiveFailures: row.consecutiveFailures,
		lastError: row.lastError ?? undefined,
		lastFailedAt: row.lastFailedAt ?? undefined,
		lastSuccessAt: row.lastSuccessAt ?? undefined
	};
}

/**
The D1 reference edges, sorted for deterministic assertions.
*/
export async function blobReferenceRows(): Promise<
	{
		tenant: TenantId;
		cache: string;
		storePathHash: StorePathHash;
		generation: number;
		narHash: NixSha256HashString;
	}[]
> {
	const rows = await drizzleD1(env.CUPBOARD_DB, { schema: { blobReference } })
		.select()
		.from(blobReference)
		.all();

	return rows.toSorted((left, right) =>
		`${left.storePathHash}:${String(left.generation)}` >
		`${right.storePathHash}:${String(right.generation)}`
			? 1
			: -1
	);
}

/**
The per-tenant blob-presence rows, sorted by NAR hash.
*/
export async function tenantBlobRows(): Promise<
	{ tenant: TenantId; narHash: NixSha256HashString; fileSize: number }[]
> {
	const rows = await drizzleD1(env.CUPBOARD_DB, { schema: { tenantBlob } })
		.select()
		.from(tenantBlob)
		.all();

	return rows.toSorted((left, right) =>
		byCodeUnit(left.narHash, right.narHash)
	);
}

export async function casObjectRows(): Promise<
	{ digest: Sha256HexDigest; size: number; deleteAfter: string | undefined }[]
> {
	const rows = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select({
			digest: d1Schema.casObject.digest,
			size: d1Schema.casObject.size,
			deleteAfter: d1Schema.casObject.deleteAfter
		})
		.from(d1Schema.casObject)
		.all();

	return rows
		.map((row) => ({ ...row, deleteAfter: row.deleteAfter ?? undefined }))
		.toSorted((left, right) => byCodeUnit(left.digest, right.digest));
}

export async function attestationReferenceRows(): Promise<
	{
		tenant: TenantId;
		cache: string;
		storePathHash: StorePathHash;
		generation: number;
		predicateType: string;
		digest: Sha256HexDigest;
	}[]
> {
	const rows = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select()
		.from(d1Schema.attestationReference)
		.all();

	return rows.toSorted((left, right) =>
		byCodeUnit(
			`${left.storePathHash}:${String(left.generation)}:${left.predicateType}`,
			`${right.storePathHash}:${String(right.generation)}:${right.predicateType}`
		)
	);
}

export async function tenantCasBlobRows(): Promise<
	{ tenant: TenantId; digest: Sha256HexDigest; size: number }[]
> {
	const rows = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select()
		.from(d1Schema.tenantCasBlob)
		.all();

	return rows.toSorted(
		(left, right) =>
			byCodeUnit(left.digest, right.digest) ||
			byCodeUnit(left.tenant, right.tenant)
	);
}

export async function pendingAttestationRows(): Promise<
	{ id: string; r2Key: string; expiresAt: string }[]
> {
	const rows = await runInDurableObject(
		fixtureWorkerServer(),
		(_instance, state) =>
			drizzle(state.storage, { schema: { pendingAttestations } })
				.select({
					id: pendingAttestations.id,
					r2Key: pendingAttestations.r2Key,
					expiresAt: pendingAttestations.expiresAt
				})
				.from(pendingAttestations)
				.all()
	);

	return rows.toSorted((left, right) => byCodeUnit(left.id, right.id));
}

export async function stageAttestationBundle(
	uploadId: string,
	bytes: Uint8Array
): Promise<R2ObjectKey> {
	const key = attestationStagingObjectKey(
		testPushId,
		uploadIdSchema.parse(uploadId)
	);
	await env.BLOBS.put(key, bytes);

	return key;
}

export async function fileAttestationReference(options: {
	readonly uploadId: string;
	readonly bytes: Uint8Array;
	readonly cache?: string;
	readonly storePathHash: StorePathHash;
	readonly generation: number;
	readonly predicateType?: string;
	readonly tenant?: string;
}): Promise<{
	digest: Sha256HexDigest;
	size: number;
	stagingKey: R2ObjectKey;
}> {
	const stagingKey = await stageAttestationBundle(
		options.uploadId,
		options.bytes
	);
	const measured = await testServerFor(
		options.tenant ?? fixtureTenant
	).measureAttestationBundle(stagingKey);
	await testServerFor(options.tenant ?? fixtureTenant).promoteAttestationBundle(
		stagingKey,
		measured
	);

	await testServerFor(
		options.tenant ?? fixtureTenant
	).reserveAttestationReference(
		{
			cache: storedCacheSchema.parse(options.cache ?? DEFAULT_CACHE),
			storePathHash: options.storePathHash,
			generation: narInfoGenerationSchema.parse(options.generation),
			predicateType: predicateTypeSchema.parse(
				options.predicateType ?? 'https://slsa.dev/provenance/v1'
			),
			digest: measured.digest
		},
		measured.size
	);

	return { ...measured, stagingKey };
}

/**
The fixture tenant's usage counters and quota, for asserting charge and credit.
*/
export async function tenantUsageRow(): Promise<
	| undefined
	| {
			bytes: number;
			narinfos: number;
			blobs: number;
			casBytes: number;
			casBlobs: number;
			quotaBytes: number | undefined;
	  }
> {
	const row = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select({
			bytes: d1Schema.tenantUsage.bytes,
			narinfos: d1Schema.tenantUsage.narinfos,
			blobs: d1Schema.tenantUsage.blobs,
			casBytes: d1Schema.tenantUsage.casBytes,
			casBlobs: d1Schema.tenantUsage.casBlobs,
			quotaBytes: d1Schema.tenantUsage.quotaBytes
		})
		.from(d1Schema.tenantUsage)
		.where(eq(d1Schema.tenantUsage.tenant, fixtureTenant))
		.get();

	if (row === undefined) {
		return undefined;
	}

	// An unset quota reads as undefined, so a test asserts it without a null literal.
	return { ...row, quotaBytes: row.quotaBytes ?? undefined };
}

/**
Whether a tenant still has a usage row, for asserting offboard finalisation.
*/
export async function isTenantUsagePresent(id: string): Promise<boolean> {
	const row = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
		.select({ tenant: d1Schema.tenantUsage.tenant })
		.from(d1Schema.tenantUsage)
		.where(eq(d1Schema.tenantUsage.tenant, tenantIdSchema.parse(id)))
		.get();

	return row !== undefined;
}

/**
 * Models a delete whose row-first transaction committed but whose queued cleanup
 * did not reach D1, leaving the captured reference edge behind.
 */
export async function queueUnflushedNarInfoDeletion(fields: {
	readonly storePathHash: StorePathHash;
	readonly cache?: string;
}): Promise<void> {
	const cache = storedCacheSchema.parse(fields.cache ?? DEFAULT_CACHE);

	await runInDurableObject(currentServer(), (_instance, state) => {
		const database = drizzle(state.storage, {
			schema: { narInfoDeletions, narInfos }
		});

		database.transaction((tx) => {
			const row = tx
				.select({
					cache: narInfos.cache,
					storePathHash: narInfos.storePathHash,
					narHash: narInfos.narHash,
					generation: narInfos.generation
				})
				.from(narInfos)
				.where(
					and(
						eq(narInfos.cache, cache),
						eq(narInfos.storePathHash, fields.storePathHash)
					)
				)
				.get();

			const deletion = z
				.object({
					cache: storedCacheSchema,
					storePathHash: storePathHashSchema,
					narHash: nixSha256HashSchema,
					generation: z.number()
				})
				.parse(row);
			expect({
				cache: deletion.cache,
				storePathHash: deletion.storePathHash
			}).toStrictEqual({
				cache,
				storePathHash: fields.storePathHash
			});

			tx.delete(narInfos)
				.where(
					and(
						eq(narInfos.cache, deletion.cache),
						eq(narInfos.storePathHash, deletion.storePathHash)
					)
				)
				.run();
			const createdAt = new Date();
			tx.insert(narInfoDeletions)
				.values({
					cache: deletion.cache,
					storePathHash: deletion.storePathHash,
					narHash: deletion.narHash,
					generation: narInfoGenerationSchema.parse(deletion.generation),
					createdAt: isoTimestamp(createdAt)
				})
				.onConflictDoNothing()
				.run();
		});
	});
}

export async function seedNarInfoDeletion(fields: {
	readonly storePathHash: StorePathHash;
	readonly narHash: NixSha256HashString;
	readonly generation: number;
}): Promise<void> {
	const createdAt = new Date();
	await runInDurableObject(currentServer(), (_instance, state) => {
		drizzle(state.storage, { schema: { narInfoDeletions } })
			.insert(narInfoDeletions)
			.values({
				cache: DEFAULT_CACHE,
				storePathHash: fields.storePathHash,
				narHash: fields.narHash,
				generation: narInfoGenerationSchema.parse(fields.generation),
				createdAt: isoTimestamp(createdAt)
			})
			.onConflictDoNothing()
			.run();
	});
}

// The queued narinfo-deletion markers, sorted by store-path hash. A surviving
// marker is the durable record of an in-flight delete the repair pass re-drives.
export async function narInfoDeletionRows(): Promise<
	{
		cache: string;
		storePathHash: StorePathHash;
		narHash: NixSha256HashString;
		generation: number;
	}[]
> {
	return runInDurableObject(currentServer(), (_instance, state) =>
		drizzle(state.storage, { schema: { narInfoDeletions } })
			.select({
				cache: narInfoDeletions.cache,
				storePathHash: narInfoDeletions.storePathHash,
				narHash: narInfoDeletions.narHash,
				generation: narInfoDeletions.generation
			})
			.from(narInfoDeletions)
			.all()
			.toSorted((left, right) =>
				byCodeUnit(left.storePathHash, right.storePathHash)
			)
	);
}

// Deletes a committed narinfo row directly, leaving its D1 edge, shared fact and
// R2 object behind: the cross-store state a delete leaves after its row
// transaction but before the repair retires the edge and object.
export async function deleteNarInfoRow(
	storePathHash: StorePathHash
): Promise<void> {
	await runInDurableObject(currentServer(), (_instance, state) => {
		drizzle(state.storage, { schema: { narInfos } })
			.delete(narInfos)
			.where(eq(narInfos.storePathHash, storePathHash))
			.run();
	});
}

// Deletes a shared blob's `blob_state` fact directly while leaving its R2 object,
// standing in for the residue a reaper crash leaves between the D1 delete and the
// R2 delete: an orphan object with no fact, which the next promote must adopt.
export async function deleteBlobState(
	narHash: NixSha256HashString
): Promise<void> {
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	const registryFilter = and(
		eq(d1Schema.objectIncarnation.kind, 'nar'),
		eq(d1Schema.objectIncarnation.objectId, narHash)
	);

	await database.batch([
		database
			.update(d1Schema.objectIncarnation)
			.set({ state: 'absent' })
			.where(registryFilter),
		database.delete(blobState).where(eq(blobState.narHash, narHash))
	]);
}

export async function deleteBlobReferenceEdge(
	storePathHash: StorePathHash,
	generation: number
): Promise<void> {
	const captured = narInfoGenerationSchema.parse(generation);

	await drizzleD1(env.CUPBOARD_DB, { schema: { blobReference } })
		.delete(blobReference)
		.where(
			and(
				eq(blobReference.storePathHash, storePathHash),
				eq(blobReference.generation, captured)
			)
		)
		.run();
}

/**
The generation stamped on a committed narinfo, or undefined if absent.
*/
export async function narInfoGeneration(
	storePathHash: StorePathHash
): Promise<number | undefined> {
	return runInDurableObject(currentServer(), (_instance, state) => {
		const row = drizzle(state.storage, { schema: { narInfos } })
			.select({ generation: narInfos.generation })
			.from(narInfos)
			.where(eq(narInfos.storePathHash, storePathHash))
			.get();

		return row?.generation;
	});
}

export function scheduledController(): ScheduledController {
	return {
		cron: '0 4 * * *',
		noRetry() {
			return;
		},
		scheduledTime: Date.now()
	};
}

export function fixtureWorkerServer(): DurableObjectStub<CupboardServer> {
	return tenantServer(env, fixtureTenant);
}

/**
Prepends the `/cache/<selector>` prefix to a cache-scoped route.
*/
function cacheScopedPath(cache: string, suffix: string): string {
	return `/cache/${selectorForCache(storedCacheSchema.parse(cache))}${suffix}`;
}

// A push id signed with the test signing key (the PUSH_ID_SIGNING_KEY the worker
// pool binds) over a fixed nonce, so a negotiated decision's staging key under
// `staging/<pushId>/` is deterministic to assert. The server verifies it exactly
// as production would.
const testPushIdSigningKey = pushIdSigningKeySchema.parse(
	'test-push-id-signing-key'
);
export async function testPushIdFor(tenant: string): Promise<PushId> {
	return issuePushId(
		testPushIdSigningKey,
		tenantIdSchema.parse(tenant),
		0xff_ff_ff_ff,
		pushIdNonceSchema.parse(new Uint8Array(16))
	);
}

export const testPushId = await testPushIdFor('v1');

export async function negotiateUploads(
	token: string,
	paths: readonly ParsedUploadPathMetadata[],
	cache: string = DEFAULT_CACHE,
	shouldReportGrace = false
): Promise<UploadNegotiateResponse> {
	const response = await authorisedFetch(
		cacheScopedPath(cache, '/uploads'),
		token,
		{
			body: JSON.stringify({
				pushId: testPushId,
				paths: paths.map((path) => uploadPathNegotiation(path))
			}),
			headers: {
				'content-type': 'application/json',
				...(shouldReportGrace && {
					[acceptCapabilitiesHeader]: uploadGraceFactsCapability
				})
			},
			method: 'POST'
		}
	);

	expect(response.status).toBe(StatusCodes.OK);

	return uploadNegotiateResponseSchema.parse(await response.json());
}

// Drives a single-path negotiate straight at a Durable Object instance, for a
// test that needs the request and its cost on the same object call.
export function negotiateViaInstance(
	instance: { fetch(request: Request): Promise<Response> },
	token: string,
	storePathHash: string,
	cache: string = DEFAULT_CACHE
): Promise<Response> {
	const metadata = uploadMetadata({ storePathHash, fileSize: 1 });
	const url = new URL(cacheScopedPath(cache, '/uploads'), currentOrigin());
	const request = new Request(url, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json'
		},
		body: JSON.stringify({
			pushId: testPushId,
			paths: [uploadPathNegotiation(metadata)]
		})
	});

	return instance.fetch(request);
}

export async function negotiateViaWorker(
	token: string,
	paths: readonly ParsedUploadPathMetadata[]
): Promise<UploadNegotiateResponse> {
	const response = await authorisedWorkerFetch(
		`/cache/${WIRE_DEFAULT_CACHE}/uploads`,
		token,
		{
			body: JSON.stringify({
				pushId: testPushId,
				paths: paths.map((path) => uploadPathNegotiation(path))
			}),
			headers: {
				'content-type': 'application/json'
			},
			method: 'POST'
		}
	);

	expect(response.status).toBe(StatusCodes.OK);

	return uploadNegotiateResponseSchema.parse(await response.json());
}

/**
Pushes one path without making assertions against the upload expiry clock.
*/
export async function pushPath(
	token: string,
	metadata: ParsedUploadPathMetadata,
	cache: string = DEFAULT_CACHE,
	nar?: VerifiableNar
): Promise<void> {
	const decision = singleDecision(
		await negotiateUploads(token, [metadata], cache)
	);

	if (decision.action === 'skip') {
		return;
	}

	if (decision.action === 'upload') {
		await putNarBytes(decision.r2Key, nar);
	}

	await commitUpload(token, decision.uploadId, cache);
}

export async function pushPathToTenant(
	tenant: TenantId,
	token: string,
	metadata: ParsedUploadPathMetadata,
	nar?: VerifiableNar,
	cache: string = WIRE_DEFAULT_CACHE
): Promise<void> {
	const pushId = await testPushIdFor(tenant);
	const negotiated = await tenantWorkerFetch(
		tenant,
		`/cache/${cache}/uploads`,
		token,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				pushId,
				paths: [uploadPathNegotiation(metadata)]
			})
		}
	);

	expect(negotiated.status).toBe(StatusCodes.OK);
	const decision = singleDecision(
		uploadNegotiateResponseSchema.parse(await negotiated.json())
	);

	if (decision.action === 'skip') {
		return;
	}

	if (decision.action === 'upload') {
		await putNarBytes(decision.r2Key, nar);
	}

	const committed = await commitUploadViaWorker(token, decision.uploadId, {
		tenant,
		cache
	});

	expect(committed.status).toBe('committed');
}

/**
 * Negotiates, uploads and commits a tenant path through the Worker, returning the
 * HTTP status the commit refusal carried (or OK when it settles), so a test can
 * assert a commit that the Durable Object refuses (for example one settling after
 * offboarding began).
 */
export async function attemptPushToTenant(
	tenant: TenantId,
	token: string,
	metadata: ParsedUploadPathMetadata,
	nar?: VerifiableNar
): Promise<number> {
	const pushId = await testPushIdFor(tenant);
	const negotiated = await tenantWorkerFetch(
		tenant,
		`/cache/${WIRE_DEFAULT_CACHE}/uploads`,
		token,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				pushId,
				paths: [uploadPathNegotiation(metadata)]
			})
		}
	);

	expect(negotiated.status).toBe(StatusCodes.OK);
	const decision = expectSingleUploadDecision(
		uploadNegotiateResponseSchema.parse(await negotiated.json()),
		metadata,
		pushId
	);

	await putNarBytes(decision.r2Key, nar);

	const upgraded = await tenantWorkerFetch(tenant, '/commit', token, {
		headers: { upgrade: 'websocket' }
	});

	const switchingProtocols: number = StatusCodes.SWITCHING_PROTOCOLS;

	if (upgraded.status !== switchingProtocols) {
		return upgraded.status;
	}

	try {
		await completeCommitSession(
			commitSessionFromResponse(upgraded),
			decision.uploadId,
			() => verifyTenant(rootLogger(), env, tenant),
			{}
		);
	} catch (error) {
		if (error instanceof CommitSocketError) {
			return error.status;
		}

		throw error;
	}

	return StatusCodes.OK;
}

// Leave the upload pending so a test can run scheduled verification for the
// named tenant without first opening a commit session.
export async function stageDeferredForTenant(
	tenant: TenantId,
	token: string,
	metadata: ParsedUploadPathMetadata,
	nar?: VerifiableNar
): Promise<UploadId> {
	const pushId = await testPushIdFor(tenant);
	const negotiated = await tenantWorkerFetch(
		tenant,
		`/cache/${WIRE_DEFAULT_CACHE}/uploads`,
		token,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				pushId,
				paths: [uploadPathNegotiation(metadata)]
			})
		}
	);

	expect(negotiated.status).toBe(StatusCodes.OK);
	const decision = expectSingleUploadDecision(
		uploadNegotiateResponseSchema.parse(await negotiated.json()),
		metadata,
		pushId
	);

	await putNarBytes(decision.r2Key, nar);
	await markUploadPendingVerification(decision.uploadId, testServerFor(tenant));

	return decision.uploadId;
}

function tenantWorkerFetch(
	tenant: TenantId,
	path: string,
	token: string,
	init: RequestInit
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('authorization', `Bearer ${token}`);

	return handlerFetch(`/t/${tenant}${path}`, { ...init, headers });
}

/**
What the commit socket said when it refused the commit.
*/
export class CommitSocketError extends Error {
	constructor(
		public readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'CommitSocketError';
	}
}

/**
A deferred upload's verification settled on a non-servable verdict.
*/
export class CommitVerdictError extends Error {
	constructor(public readonly verdict: string) {
		super(`Upload verification settled on ${verdict}`);
		this.name = 'CommitVerdictError';
	}
}

/**
The commit socket conversation departed from the frame protocol.
*/
export class CommitSocketProtocolError extends Error {
	constructor(detail: string) {
		super(`Commit socket protocol violation: ${detail}`);
		this.name = 'CommitSocketProtocolError';
	}
}

/**
 * Accepts the client end of a commit upgrade and returns it alongside a frame
 * reader. The listener attaches before `accept()` so no frame the server sent
 * during the commit transition is missed.
 */
export interface CommitConversation {
	readonly socket: WebSocket;
	readonly send: (request: CommitSessionRequest) => void;
	readonly nextFrame: () => Promise<ParsedCommitSessionFrame>;
	// The capability header the 101 carried, which is where a credited session's
	// opening grant is advertised.
	readonly capabilities: string | null;
}

export function commitSessionFromResponse(
	response: Response
): CommitConversation {
	expect(response.status).toBe(StatusCodes.SWITCHING_PROTOCOLS);
	const socket = response.webSocket;

	if (socket === null) {
		throw new CommitSocketProtocolError(
			'the upgrade response did not include a WebSocket'
		);
	}

	const frames: ParsedCommitSessionFrame[] = [];
	const waiters: {
		resolve: (frame: ParsedCommitSessionFrame) => void;
		reject: (reason: Error) => void;
	}[] = [];

	socket.addEventListener('message', (event) => {
		const frame = commitSessionFrameSchema.parse(
			JSON.parse(String(event.data))
		);
		const waiter = waiters.shift();

		if (waiter === undefined) {
			frames.push(frame);
		} else {
			waiter.resolve(frame);
		}
	});
	socket.addEventListener('close', () => {
		const pending = [...waiters];
		waiters.length = 0;
		for (const waiter of pending) {
			waiter.reject(
				new CommitSocketProtocolError('the socket closed before the frame')
			);
		}
	});
	socket.accept();

	const nextFrame = (): Promise<ParsedCommitSessionFrame> => {
		const queued = frames.shift();

		if (queued !== undefined) {
			return Promise.resolve(queued);
		}

		const waiter = Promise.withResolvers<ParsedCommitSessionFrame>();
		waiters.push(waiter);

		return waiter.promise;
	};

	const send = (request: CommitSessionRequest): void => {
		socket.send(JSON.stringify(request));
	};

	return {
		socket,
		send,
		nextFrame,
		capabilities: response.headers.get(commitCapabilitiesHeader)
	};
}

// What a client declares on the upgrade to be paced by the server's credit. A
// session that declares nothing is admitted the way an older client is: it
// spends no credit and the server does not pace it.
export const commitCreditAccept = `${commitBatchCapability},${commitCreditCapability}`;

/**
Opens a push's commit session WebSocket against the Durable Object stub.
*/
export async function openCommitSession(
	token: string,
	cache: string = DEFAULT_CACHE,
	accepted?: string
): Promise<CommitConversation> {
	const response = await fetchPath(cacheScopedPath(cache, '/commit'), {
		headers: {
			authorization: `Bearer ${token}`,
			upgrade: 'websocket',
			...(accepted !== undefined && {
				[commitAcceptCapabilitiesHeader]: accepted
			})
		}
	});

	return commitSessionFromResponse(response);
}

// Closes a session socket and waits for the close handshake to complete, so
// the server has handled the close before the caller opens another session; a
// close still in flight counts against the commit sockets the tenant holds.
function closeSessionAndWait(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.READY_STATE_CLOSED) {
		return Promise.resolve();
	}

	return new Promise((resolve) => {
		socket.addEventListener('close', () => {
			resolve();
		});
		socket.close();
	});
}

// Sends a commit operation and waits for its response. For a deferred upload,
// the helper runs the verification pass that the queue runs in production and
// waits for the verdict. With `wait: false`, it returns `pending` immediately.
// The helper closes the session after receiving the final result.
async function completeCommitSession(
	conversation: CommitConversation,
	uploadId: UploadId,
	runVerification: () => Promise<void>,
	options: { readonly wait?: boolean }
): Promise<CommitResponse> {
	const { socket, send, nextFrame } = conversation;
	send({ op: 'commit', uploadId });
	const first = await nextFrame();

	if (first.ev === 'settled') {
		await closeSessionAndWait(socket);

		return first.response;
	}

	if (first.ev === 'error') {
		await closeSessionAndWait(socket);
		throw new CommitSocketError(first.status, first.message);
	}

	if (first.ev !== 'deferred') {
		await closeSessionAndWait(socket);
		throw new CommitSocketProtocolError(`unexpected first frame: ${first.ev}`);
	}

	if (options.wait === false) {
		await closeSessionAndWait(socket);

		return {
			storePathHash: first.storePathHash,
			narHash: first.narHash,
			status: 'pending'
		};
	}

	await runVerification();
	const verdict = await nextFrame();
	await closeSessionAndWait(socket);

	if (verdict.ev !== 'verdict') {
		throw new CommitSocketProtocolError(`unexpected frame: ${verdict.ev}`);
	}

	if (verdict.status !== 'servable') {
		throw new CommitVerdictError(verdict.status);
	}

	return {
		storePathHash: first.storePathHash,
		narHash: first.narHash,
		status: 'committed'
	};
}

/**
 * Commits an upload over the session WebSocket the way a client does, against
 * the Durable Object stub. A deferred upload's verification is driven
 * synchronously and the verdict awaited, so callers see the settled
 * `committed` result; `wait: false` returns the deferral as `pending`
 * instead. A refused commit throws {@link CommitSocketError} with the status
 * the error frame carried; a non-servable verdict throws
 * {@link CommitVerdictError}.
 */
export async function commitUpload(
	token: string,
	uploadId: UploadId,
	cache: string = DEFAULT_CACHE,
	options: { readonly wait?: boolean } = {}
): Promise<CommitResponse> {
	const conversation = await openCommitSession(token, cache);

	return completeCommitSession(
		conversation,
		uploadId,
		() => verifyTenant(rootLogger(), env, currentServerTenant()),
		options
	);
}

/**
 * Runs a commit that the server is expected to refuse. Returns the rejection so
 * the test can compare it structurally. Fails if the commit succeeds.
 */
export async function commitUploadRejection(
	token: string,
	uploadId: UploadId,
	cache: string = DEFAULT_CACHE
): Promise<unknown> {
	let result:
		| { kind: 'committed'; response: Awaited<ReturnType<typeof commitUpload>> }
		| { kind: 'rejected'; error: unknown };
	try {
		result = {
			kind: 'committed',
			response: await commitUpload(token, uploadId, cache)
		};
	} catch (error: unknown) {
		result = { kind: 'rejected', error };
	}

	expect({
		kind: result.kind,
		uploadId
	}).toStrictEqual({
		kind: 'rejected',
		uploadId
	});

	if (result.kind === 'rejected') {
		return result.error;
	}

	return result.response;
}

/**
As {@link commitUpload}, routed through the Worker like a real client.
*/
export async function commitUploadViaWorker(
	token: string,
	uploadId: UploadId,
	options: {
		readonly wait?: boolean;
		readonly tenant?: string;
		readonly cache?: string;
	} = {}
): Promise<CommitResponse> {
	const tenant = tenantIdSchema.parse(options.tenant ?? fixtureTenant);
	const socketPath =
		options.cache === undefined ? '/commit' : `/cache/${options.cache}/commit`;
	const response = await tenantWorkerFetch(tenant, socketPath, token, {
		headers: { upgrade: 'websocket' }
	});

	return completeCommitSession(
		commitSessionFromResponse(response),
		uploadId,
		() => verifyTenant(rootLogger(), env, tenant),
		options
	);
}

export async function commitPath(
	token: string,
	metadata: ParsedUploadPathMetadata,
	nar?: VerifiableNar
): Promise<void> {
	const upload = expectSingleUploadDecision(
		await negotiateUploads(token, [metadata]),
		metadata
	);
	await putNarBytes(upload.r2Key, nar);
	await commitUpload(token, upload.uploadId);
}

export async function commitSharedPath(
	token: string,
	metadata: ParsedUploadPathMetadata
): Promise<void> {
	const decision = expectSingleCommitDecision(
		await negotiateUploads(token, [metadata]),
		metadata
	);
	await commitUpload(token, decision.uploadId);
}

export async function deletePath(
	token: string,
	storePathHash: StorePathHash
): Promise<DeletePathResponse> {
	const response = await authorisedFetch(
		`/cache/${WIRE_DEFAULT_CACHE}/paths/${storePathHash}`,
		token,
		{
			method: 'DELETE'
		}
	);

	expect(response.status).toBe(StatusCodes.OK);

	return pathDeletionResponseSchema.parse(await response.json());
}

export async function setRoot(
	token: string,
	fields: RootSetBody & { readonly name: string }
): Promise<RootSetResponse> {
	const { name, ...body } = fields;
	const response = await authorisedFetch(
		`/cache/${WIRE_DEFAULT_CACHE}/roots/${encodeURIComponent(name)}`,
		token,
		{
			body: JSON.stringify(body),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		}
	);

	expect(response.status).toBe(StatusCodes.OK);

	return rootSetResponseSchema.parse(await response.json());
}

export async function listRoots(
	token: string,
	options: { readonly cursor?: string; readonly limit?: number } = {}
): Promise<RootListResponse> {
	const response = await authorisedFetch(
		`/cache/${WIRE_DEFAULT_CACHE}/roots${listPageQuery(options)}`,
		token
	);

	expect(response.status).toBe(StatusCodes.OK);

	return rootListResponseSchema.parse(await response.json());
}

/**
One page of a root's targets, with the per-target serve probe applied.
*/
export async function listRootTargets(
	token: string,
	name: string,
	options: { readonly cursor?: string; readonly limit?: number } = {}
): Promise<z.output<typeof rootTargetsPageSchema>> {
	const response = await authorisedFetch(
		`/cache/${WIRE_DEFAULT_CACHE}/roots/${encodeURIComponent(name)}/targets${listPageQuery(options)}`,
		token
	);

	expect(response.status).toBe(StatusCodes.OK);

	return rootTargetsPageSchema.parse(await response.json());
}

function listPageQuery(options: {
	readonly cursor?: string;
	readonly limit?: number;
}): string {
	const query = new URLSearchParams({
		...(options.cursor !== undefined && { cursor: options.cursor }),
		...(options.limit !== undefined && { limit: String(options.limit) })
	}).toString();

	return query === '' ? '' : `?${query}`;
}

export async function removeRoot(
	token: string,
	name: string
): Promise<RootRemoveResponse> {
	const response = await authorisedFetch(
		`/cache/${WIRE_DEFAULT_CACHE}/roots/${encodeURIComponent(name)}`,
		token,
		{
			method: 'DELETE'
		}
	);

	expect(response.status).toBe(StatusCodes.OK);

	return rootRemoveResponseSchema.parse(await response.json());
}

export async function runGcResult(): Promise<GcResult> {
	const token = await initialise();
	const response = await authorisedFetch('/gc', token, { method: 'POST' });

	expect(response.status).toBe(StatusCodes.OK);

	return gcResponseSchema.parse(await response.json());
}

/**
Calls the HTTP GC route from an origin that has no edge-cache purge binding.
*/
export async function runGcFromInternalOrigin(): Promise<void> {
	const token = await initialise();
	const response = await harness.server.fetch(new URL('/gc', internalOrigin), {
		headers: { authorization: `Bearer ${token}` },
		method: 'POST'
	});

	expect(response.status).toBe(StatusCodes.OK);
	await response.text();
}

export function afterGrace(): Date {
	return new Date(testBase.getTime() + blobReaperGraceMs + 60_000);
}

// Runs the reaper to completion against the current server: a first GC pass arms
// the unreferenced shared blobs, then time advances past the grace and a second
// pass collects them. Tests anchored at `testBase` use this to assert blob
// reclamation under the two-pass grace model. Requires fake timers.
export async function reapBlobsPastGrace(): Promise<void> {
	// Repair pass first: the owning Durable Object flushes any delete markers and
	// retires edges. Then the Worker reaper arms the now-unreferenced blobs and,
	// past the grace, collects them.
	await currentServer().runGarbageCollection();
	await runBlobReaper(rootLogger(), env);
	vi.setSystemTime(afterGrace());
	await runBlobReaper(rootLogger(), env);
}

export async function fetchNarInfo(
	storePathHash: StorePathHash
): Promise<NarInfo> {
	const response = await readFetch(`/${storePathHash}.narinfo`);

	expect(response.status).toBe(StatusCodes.OK);

	return NarInfo.parse(await response.text());
}

export async function expectNarResponse(
	hash: string,
	method: 'GET' | 'HEAD'
): Promise<void> {
	const narHash = nixSha256HashSchema.parse(decodeURIComponent(hash));
	const response = await readFetch(`/${await currentNarObjectKey(narHash)}`, {
		method
	});
	const etag = response.headers.get('etag');

	expect({
		status: response.status,
		cacheControl: response.headers.get('cache-control'),
		contentLength: response.headers.get('content-length'),
		contentType: response.headers.get('content-type'),
		etag: typeof etag,
		lastModified: typeof response.headers.get('last-modified')
	}).toStrictEqual({
		status: StatusCodes.OK,
		cacheControl: 'public, max-age=31536000, immutable',
		contentLength: String(narBytes.length),
		contentType: 'application/zstd',
		etag: 'string',
		lastModified: 'string'
	});

	const body = new Uint8Array(await response.arrayBuffer());

	expect([...body]).toStrictEqual(method === 'HEAD' ? [] : [...narBytes]);
}

export async function expectConditionalNotModified(
	pathname: string,
	fetcher: (
		pathname: string,
		init?: RequestInit
	) => Promise<Response> = fetchPath
): Promise<void> {
	const fresh = await fetcher(pathname);
	const etag = fresh.headers.get('etag');

	expect(typeof etag).toBe('string');

	const response = await fetcher(pathname, {
		headers: {
			'if-none-match': etag ?? ''
		}
	});

	expect({
		status: response.status,
		body: await response.text(),
		cacheControl: response.headers.get('cache-control'),
		contentLength: response.headers.get('content-length'),
		etag: response.headers.get('etag')
	}).toStrictEqual({
		status: StatusCodes.NOT_MODIFIED,
		body: '',
		cacheControl: fresh.headers.get('cache-control'),
		contentLength: fresh.headers.get('content-length'),
		etag
	});
}

export async function expectDateConditionalNotModified(
	pathname: string,
	fetcher: (
		pathname: string,
		init?: RequestInit
	) => Promise<Response> = fetchPath
): Promise<void> {
	const fresh = await fetcher(pathname);
	const lastModified = fresh.headers.get('last-modified');

	expect(typeof lastModified).toBe('string');

	const response = await fetcher(pathname, {
		headers: {
			'if-modified-since': lastModified ?? ''
		}
	});

	expect({
		status: response.status,
		body: await response.text(),
		cacheControl: response.headers.get('cache-control'),
		contentLength: response.headers.get('content-length'),
		lastModified: response.headers.get('last-modified')
	}).toStrictEqual({
		status: StatusCodes.NOT_MODIFIED,
		body: '',
		cacheControl: fresh.headers.get('cache-control'),
		contentLength: fresh.headers.get('content-length'),
		lastModified
	});
}

export async function expectTextResponse(
	pathname: string,
	expected: {
		readonly body: string;
		readonly cacheControl: string;
		readonly contentType: string;
		readonly method: 'GET' | 'HEAD';
	},
	fetcher: (
		pathname: string,
		init?: RequestInit
	) => Promise<Response> = fetchPath
): Promise<void> {
	const response = await fetcher(pathname, { method: expected.method });
	const body = await response.text();
	const encoder = new TextEncoder();

	expect({
		status: response.status,
		body,
		cacheControl: response.headers.get('cache-control'),
		contentLength: response.headers.get('content-length'),
		contentType: response.headers.get('content-type'),
		etag: typeof response.headers.get('etag'),
		lastModified:
			response.headers.get('last-modified') === null
				? undefined
				: typeof response.headers.get('last-modified')
	}).toStrictEqual({
		status: StatusCodes.OK,
		body: expected.method === 'HEAD' ? '' : expected.body,
		cacheControl: expected.cacheControl,
		contentLength: String(encoder.encode(expected.body).length),
		contentType: expected.contentType,
		etag: 'string',
		lastModified: pathname.endsWith('.narinfo') ? 'string' : undefined
	});
}

// The contract addresses the default cache as `_default`; there is no bare
// `/stats` route.
export const defaultCacheStatsPath = `/cache/${WIRE_DEFAULT_CACHE}/stats`;

export async function expectStats(
	token: string,
	expected: StatsExpectation
): Promise<void> {
	const response = await authorisedFetch(defaultCacheStatsPath, token);

	expect(response.status).toBe(StatusCodes.OK);
	expect(await response.json()).toStrictEqual(statsExpectation(expected));
}

export async function expectStatsViaWorker(
	token: string,
	expected: StatsExpectation
): Promise<void> {
	const response = await authorisedWorkerFetch(defaultCacheStatsPath, token);

	expect(response.status).toBe(StatusCodes.OK);
	expect(await response.json()).toStrictEqual(statsExpectation(expected));
}

export async function expectStatsForTenant(
	tenant: TenantId,
	token: string,
	expected: StatsExpectation
): Promise<void> {
	const response = await tenantWorkerFetch(
		tenant,
		defaultCacheStatsPath,
		token,
		{
			method: 'GET'
		}
	);

	expect(response.status).toBe(StatusCodes.OK);
	expect(await response.json()).toStrictEqual(statsExpectation(expected));
}

type StatsExpectation = Omit<
	StatsResponse,
	'casFileSize' | 'casObjects' | 'narFileSize' | 'totalFileSize'
> &
	Partial<
		Pick<
			StatsResponse,
			'casFileSize' | 'casObjects' | 'narFileSize' | 'totalFileSize'
		>
	>;

export function statsExpectation(expected: StatsExpectation): StatsResponse {
	const narFileSize = expected.narFileSize ?? expected.totalFileSize ?? 0;
	const casFileSize = expected.casFileSize ?? 0;

	return {
		...expected,
		narFileSize,
		casObjects: expected.casObjects ?? 0,
		casFileSize,
		totalFileSize: expected.totalFileSize ?? narFileSize + casFileSize
	};
}

export interface VerifiableNar {
	readonly narBytes: Uint8Array;
	readonly narHash: NixSha256HashString;
	readonly narSize: number;
	readonly fileHash: NixSha256HashString;
}

const defaultNar: VerifiableNar = {
	narBytes,
	narHash,
	narSize: 1234,
	fileHash: fileHash.value
};

export async function putNarBytes(
	r2Key: string,
	nar: VerifiableNar = defaultNar
): Promise<void> {
	await env.BLOBS.put(r2Key, nar.narBytes, {
		sha256: NixSha256Hash.parse(nar.fileHash).digestBytes()
	});
}

/**
 * Seeds an already-available shared blob: writes its canonical object and the
 * `blob_state` row recording its compressed size, so a later upload of a different
 * encoding of the same NAR adopts this canonical size at promote. Lets a test
 * set up a canonical size that differs from the staged size, so it can check
 * that the quota charge uses the canonical size.
 */
export async function seedCanonicalBlob(nar: VerifiableNar): Promise<void> {
	await putNarBytes(narObjectKey(nar.narHash), nar);
	const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

	await database.batch([
		database
			.insert(d1Schema.blobState)
			.values({
				narHash: nar.narHash,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength,
				compression: 'zstd',
				narSize: nar.narSize,
				verifiedAt: isoTimestamp(testBase)
			})
			.onConflictDoNothing(),
		database
			.insert(d1Schema.objectIncarnation)
			.values({
				kind: 'nar',
				objectId: nar.narHash,
				incarnation: 1,
				state: 'live'
			})
			.onConflictDoNothing()
	]);
}

function singleChunkStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		}
	});
}

/**
 * A distinct, self-consistent NAR for a seed: real zstd bytes whose decompressed
 * payload hashes to `narHash`, so the server's verify-before-serve accepts it.
 * Tests that need several distinct blobs (reference graphs, per-blob GC) build one
 * per path with this helper.
 */
export async function verifiableNar(seed: string): Promise<VerifiableNar> {
	const encoder = new TextEncoder();
	const uncompressed = encoder.encode(`cupboard-nar:${seed}\n`.repeat(64));
	const compressedStream = singleChunkStream(uncompressed).pipeThrough(
		zstdCompressionStream()
	);
	const compressedResponse = new Response(compressedStream);
	const compressed = new Uint8Array(await compressedResponse.arrayBuffer());
	const narDigest = await crypto.subtle.digest('SHA-256', uncompressed);
	const narHash = NixSha256Hash.fromDigest(new Uint8Array(narDigest));
	const narHashValue = narHash.value;
	const fileDigest = await crypto.subtle.digest('SHA-256', compressed);
	const fileHash = NixSha256Hash.fromDigest(new Uint8Array(fileDigest));
	const fileHashValue = fileHash.value;

	return {
		narBytes: compressed,
		narHash: narHashValue,
		narSize: uncompressed.byteLength,
		fileHash: fileHashValue
	};
}

/**
 * A minimal sigstore DSSE bundle whose in-toto statement attests the given
 * subject digest, byte-encoded the way the attach flow stages it.
 */
export function sigstoreBundleBytes(
	subjectDigest: string,
	predicateType = 'https://slsa.dev/provenance/v1'
): Uint8Array {
	const statement = {
		_type: 'https://in-toto.io/Statement/v1',
		subject: [{ name: 'nar', digest: { sha256: subjectDigest } }],
		predicateType,
		predicate: { buildDefinition: {}, runDetails: {} }
	};
	const bundle = {
		mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
		verificationMaterial: {
			publicKey: { hint: 'test-key' },
			tlogEntries: []
		},
		dsseEnvelope: {
			payload: btoa(JSON.stringify(statement)),
			payloadType: 'application/vnd.in-toto+json',
			signatures: [{ sig: btoa('signature') }]
		}
	};

	const encoder = new TextEncoder();
	return encoder.encode(JSON.stringify(bundle));
}

/**
The lowercase hex digest of a `sha256:<base32>` NAR hash.
*/
export function narDigestHex(narHash: NixSha256HashString): string {
	return [...NixSha256Hash.parse(narHash).digestBytes()]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/**
Decodes a lowercase hex digest into its bytes.
*/
export function hexBytes(value: string): Uint8Array {
	const bytes = new Uint8Array(value.length / 2);

	for (let index = 0; index < bytes.byteLength; index += 1) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}

	return bytes;
}

// Wraps `payload` in a single uncompressed-block ("stored") zstd frame. It
// decompresses to `payload` unchanged, so it shares its NAR hash with a normally
// compressed frame of the same bytes, but its compressed bytes differ. Valid for a
// payload of 257..65791 bytes (the 2-byte frame-content-size encoding).
function storedZstdFrame(payload: Uint8Array): Uint8Array {
	const size = payload.byteLength;
	const contentSize = size - 256; // 2-byte Frame_Content_Size stores value − 256
	const blockHeader = (size << 3) | 0b001; // last block, Raw_Block, `size` bytes

	return new Uint8Array([
		0x28,
		0xb5,
		0x2f,
		0xfd, // magic
		0x60, // header descriptor: 2-byte FCS, single segment
		contentSize & 0xff,
		(contentSize >> 8) & 0xff,
		blockHeader & 0xff,
		(blockHeader >> 8) & 0xff,
		(blockHeader >> 16) & 0xff,
		...payload
	]);
}

/**
 * The same NAR payload as {@link verifiableNar} for a seed, but encoded as an
 * uncompressed "stored" zstd frame. It decompresses to the same bytes (sharing
 * the seed's `narHash`), yet its compressed bytes and thus `fileHash` differ,
 * modelling a client that compressed the same NAR with other zstd settings.
 */
export async function verifiableNarStored(
	seed: string
): Promise<VerifiableNar> {
	const encoder = new TextEncoder();
	const uncompressed = encoder.encode(`cupboard-nar:${seed}\n`.repeat(64));
	const frame = storedZstdFrame(uncompressed);

	const narDigest = await crypto.subtle.digest('SHA-256', uncompressed);
	const narHash = NixSha256Hash.fromDigest(new Uint8Array(narDigest));
	const fileDigest = await crypto.subtle.digest('SHA-256', frame);
	const fileHash = NixSha256Hash.fromDigest(new Uint8Array(fileDigest));

	return {
		narBytes: frame,
		narHash: narHash.value,
		narSize: uncompressed.byteLength,
		fileHash: fileHash.value
	};
}

/**
 * Reads a pending upload's verification verdict: `undefined` if the row is gone,
 * otherwise the stored verdict (`null`, `'committing'`, `'pending'`, `'servable'`,
 * `'mismatch'`, or `'over-quota'`).
 */
export async function pendingUploadVerdict(
	uploadId: UploadId
): Promise<string | null | undefined> {
	return runInDurableObject(currentServer(), (_instance, state) => {
		const row = drizzle(state.storage, { schema: { pendingUploads } })
			.select({ verdict: pendingUploads.verdict })
			.from(pendingUploads)
			.where(eq(pendingUploads.id, uploadId))
			.get();

		return row === undefined ? undefined : row.verdict;
	});
}

/**
 * Snapshots a pending upload's verdict and observation window, `undefined` if
 * the row is gone. A terminal row must survive a straggling verdict unchanged,
 * so tests compare whole snapshots taken either side of the straggler.
 */
export async function pendingUploadSnapshot(
	uploadId: UploadId
): Promise<{ verdict: string | null; expiresAt: string } | undefined> {
	return runInDurableObject(currentServer(), (_instance, state) => {
		const row = drizzle(state.storage, { schema: { pendingUploads } })
			.select({
				verdict: pendingUploads.verdict,
				expiresAt: pendingUploads.expiresAt
			})
			.from(pendingUploads)
			.where(eq(pendingUploads.id, uploadId))
			.get();

		return row;
	});
}

/**
Polls a deferred upload's status the way `push --wait` does, by its uploadId.
*/
export async function uploadStatus(
	uploadId: UploadId
): Promise<UploadStatusResponse['status']> {
	const token = await initialise();
	const response = await authorisedFetch(`/uploads/${uploadId}/status`, token, {
		method: 'GET'
	});

	expect(response.status).toBe(StatusCodes.OK);

	const body = uploadStatusResponseSchema.parse(await response.json());

	return body.status;
}

// The status a named tenant's `push --wait` would read, queried through the Worker
// under that tenant's prefix with its own write token.
export async function tenantUploadStatus(
	tenant: TenantId,
	token: string,
	uploadId: UploadId
): Promise<UploadStatusResponse['status']> {
	const response = await tenantWorkerFetch(
		tenant,
		`/uploads/${uploadId}/status`,
		token,
		{ method: 'GET' }
	);

	expect(response.status).toBe(StatusCodes.OK);

	const body = uploadStatusResponseSchema.parse(await response.json());

	return body.status;
}

export async function verifiablePath(
	seed: string,
	fields: {
		readonly name?: string;
		readonly storePathHash?: string;
		readonly references?: string[];
	}
): Promise<{ metadata: ParsedUploadPathMetadata; nar: VerifiableNar }> {
	const nar = await verifiableNar(seed);
	const metadata = uploadMetadata({
		name: fields.name,
		storePathHash: fields.storePathHash,
		references: fields.references,
		narHash: nar.narHash,
		narSize: nar.narSize,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength
	});

	return { metadata, nar };
}

/**
 * Negotiates, uploads and commits a path backed by a distinct verifiable NAR for
 * the seed, returning its metadata. Use for the second and later paths in a test:
 * each needs its own NAR hash so negotiate returns a fresh `upload` for each.
 */
export async function commitVerifiablePath(
	token: string,
	seed: string,
	fields: {
		readonly name?: string;
		readonly storePathHash?: string;
		readonly references?: string[];
	}
): Promise<ParsedUploadPathMetadata> {
	const { metadata, nar } = await verifiablePath(seed, fields);
	await commitPath(token, metadata, nar);

	return metadata;
}

/**
 * Collects every message the current server sends through its own queue
 * binding (the path `requestVerification` and its continuations take), by
 * swapping a recording stub onto the live instance before the code under test
 * runs.
 */
export async function collectVerificationPasses(): Promise<unknown[]> {
	const sent: unknown[] = [];
	const metrics = { backlogCount: 0, backlogBytes: 0 };
	await runInDurableObject(currentServer(), (instance) => {
		instance.context.env = {
			...instance.context.env,
			MAINTENANCE_QUEUE: {
				send: (message: unknown) => {
					sent.push(message);

					return Promise.resolve({ metadata: { metrics } });
				},
				sendBatch: () => Promise.resolve({ metadata: { metrics } }),
				metrics: () => Promise.resolve(metrics)
			}
		};

		return Promise.resolve();
	});

	return sent;
}

/**
 * Negotiates one fresh path, stages its bytes, and defers it as `pending`
 * background verification, returning the facts a verify claim carries for it.
 */
export async function deferFreshUpload(
	token: string,
	seed: string,
	storePathHash: string
): Promise<{
	uploadId: UploadId;
	r2Key: string;
	metadata: ParsedUploadPathMetadata;
	nar: VerifiableNar;
}> {
	const { metadata, nar } = await verifiablePath(seed, {
		storePathHash,
		name: seed
	});
	const upload = expectSingleUploadDecision(
		await negotiateUploads(token, [metadata]),
		metadata
	);

	await putNarBytes(upload.r2Key, nar);
	await markUploadPendingVerification(upload.uploadId);

	return { uploadId: upload.uploadId, r2Key: upload.r2Key, metadata, nar };
}

/**
 * Marks a staged upload as pending so a test can run background verification
 * without opening a commit session.
 */
export async function markUploadPendingVerification(
	uploadId: UploadId,
	stub: DurableObjectStub<CupboardServer> = currentServer()
): Promise<void> {
	await runInDurableObject(stub, (instance, state) => {
		drizzle(state.storage, { schema: { pendingUploads } })
			.update(pendingUploads)
			.set({ verdict: 'pending' })
			.where(eq(pendingUploads.id, uploadId))
			.run();
		const service = new MaintenanceEligibilityService(instance.context);
		return service.reconcile();
	});
}

// Reproduce a commit interrupted after its durable marker was written. A later
// verification pass must resume the same upload.
export async function markUploadCommitting(uploadId: UploadId): Promise<void> {
	await runInDurableObject(currentServer(), (_instance, state) => {
		drizzle(state.storage, { schema: { pendingUploads } })
			.update(pendingUploads)
			.set({ verdict: 'committing' })
			.where(eq(pendingUploads.id, uploadId))
			.run();
	});
}

// Plants a reserved-but-unmaterialised narinfo row, the state a crashed inline
// commit leaves between reserving the row and materialising it: the row exists at
// its generation with no D1 edge, no shared fact, and no R2 object. Signatures are
// a placeholder, since this row only ever exists mid-saga.
export async function seedReservedNarInfo(
	metadata: ParsedUploadPathMetadata,
	generation = 0
): Promise<void> {
	await runInDurableObject(currentServer(), (_instance, state) => {
		const database = drizzle(state.storage, {
			schema: { generationSeq, narInfos }
		});
		const reserved = narInfoGenerationSchema.parse(generation);
		const nextGeneration = narInfoGenerationSchema.parse(generation + 1);

		database
			.insert(narInfos)
			.values({
				cache: '',
				storePathHash: metadata.storePathHash,
				storePath: metadata.storePath,
				narHash: metadata.narHash,
				narSize: metadata.narSize,
				referencesJson: JSON.stringify(metadata.references),
				deriver: metadata.deriver,
				ca: metadata.ca,
				sigsJson: '[]',
				generation: reserved,
				createdAt: isoTimestamp(testBase)
			})
			.run();
		database
			.insert(generationSeq)
			.values({
				cache: '',
				storePathHash: metadata.storePathHash,
				nextGeneration
			})
			.onConflictDoUpdate({
				target: [generationSeq.cache, generationSeq.storePathHash],
				set: { nextGeneration }
			})
			.run();
	});
}

/**
 * Rewrites fields on a committed narinfo row directly, to plant a stored blob
 * that disagrees with the hash or size its narinfo signed. This is a state a
 * normal verified commit cannot produce, so the deep storage check's NAR
 * re-derivation can be exercised.
 */
export async function corruptCommittedNarInfo(
	storePathHash: StorePathHash,
	fields: Partial<{
		narHash: NixSha256HashString;
		narSize: number;
		deriver: string;
		ca: string;
	}>
): Promise<void> {
	await runInDurableObject(currentServer(), (_instance, state) => {
		drizzle(state.storage, { schema: { narInfos } })
			.update(narInfos)
			.set(fields)
			.where(eq(narInfos.storePathHash, storePathHash))
			.run();
	});
}

export async function isNarInfoSignatureValid(
	narInfo: NarInfo,
	publicKey: string
): Promise<boolean> {
	const key = new NixPublicKey(publicKey);
	// Each signature names its signing key, so only the signatures naming this
	// key are checked against it.
	const signatures = NixSignature.parseAll(narInfo.sigs).filter(
		(signature) => signature.name === key.name
	);

	if (signatures.length === 0) {
		return false;
	}

	const imported = await crypto.subtle.importKey(
		'raw',
		key.bytes,
		'Ed25519',
		false,
		['verify']
	);
	const encoder = new TextEncoder();
	const fingerprint = encoder.encode(narInfo.fingerprint());

	const verifications = await Promise.all(
		signatures.map((signature) =>
			crypto.subtle.verify('Ed25519', imported, signature.bytes, fingerprint)
		)
	);

	return verifications.some(Boolean);
}

export async function readStoredNarInfo(storePathHash: StorePathHash): Promise<{
	readonly body: string;
	readonly etag: string;
	readonly contentType: string | undefined;
	readonly cacheControl: string | undefined;
}> {
	const object = z
		.custom<R2ObjectBody>((value) => value !== null)
		.parse(await env.BLOBS.get(narInfoObjectKey(fixtureTenant, storePathHash)));

	return {
		body: await object.text(),
		etag: object.httpEtag,
		contentType: object.httpMetadata?.contentType,
		cacheControl: object.httpMetadata?.cacheControl
	};
}

export function uploadPathNegotiation(metadata: ParsedUploadPathMetadata) {
	return {
		storePathHash: metadata.storePathHash,
		storePath: metadata.storePath,
		narHash: metadata.narHash,
		narSize: metadata.narSize,
		references: metadata.references,
		deriver: metadata.deriver,
		ca: metadata.ca
	};
}

export function uploadMetadata(
	fields: Partial<UploadPathMetadataFields> & {
		readonly fileSize: number;
		readonly name?: string;
		readonly storePathHash?: string;
	}
): ParsedUploadPathMetadata {
	const storePathHash =
		fields.storePathHash ?? '11111111111111111111111111111111';
	const name = fields.name ?? 'first';

	return uploadPathMetadataSchema.parse({
		storePathHash,
		storePath: `/nix/store/${storePathHash}-${name}`,
		narHash: fields.narHash ?? narHash,
		narSize: fields.narSize ?? 1234,
		fileHash: fields.fileHash ?? fileHash.toString(),
		fileSize: fields.fileSize,
		compression: 'zstd',
		references: fields.references ?? [`${storePathHash}-${name}`],
		deriver: fields.deriver,
		ca: fields.ca
	});
}

export function nixSha256Hash(character: string): NixSha256HashString {
	// The most-significant base32 digit must leave the digest's overflow bits
	// zero, so pin it to '0' and fill the rest with the marker character to keep
	// each fixture canonical and distinct.
	return nixSha256HashSchema.parse(`sha256:0${character.repeat(51)}`);
}

export function tenantId(name: string): TenantId {
	return tenantIdSchema.parse(name);
}

export function expectSingleUploadDecision(
	response: UploadNegotiateResponse,
	metadata: ParsedUploadPathMetadata,
	pushId: PushId = testPushId
): ParsedUploadActionDecision {
	const decision = uploadActionDecisionSchema.parse(singleDecision(response));
	const expectedExpiresAt = uploadExpiryFromNow();

	expect(response.uploads).toStrictEqual([
		{
			action: 'upload',
			storePathHash: metadata.storePathHash,
			narHash: metadata.narHash,
			uploadId: decision.uploadId,
			r2Key: stagingObjectKey(pushId, decision.uploadId),
			expiresAt: expectedExpiresAt
		}
	]);

	return decision;
}

export function expectSingleCommitDecision(
	response: UploadNegotiateResponse,
	metadata: ParsedUploadPathMetadata
): ParsedUploadCommitDecision {
	const decision = uploadCommitDecisionSchema.parse(singleDecision(response));

	expect(response.uploads).toStrictEqual([
		{
			action: 'commit',
			storePathHash: metadata.storePathHash,
			narHash: metadata.narHash,
			uploadId: decision.uploadId
		}
	]);

	return decision;
}

export function singleDecision(
	response: UploadNegotiateResponse
): ParsedUploadDecision {
	const [decision] = z.tuple([uploadDecisionSchema]).parse(response.uploads);
	return uploadDecisionSchema.parse(decision);
}

export function uploadExpiryFromNow(): IsoTimestamp {
	return isoTimestamp(new Date(Date.now() + 15 * 60 * 1000));
}

/**
The highest migration index registered in `drizzle/migrations.js`.
*/
export const latestMigrationIndex = Math.max(
	...migrations.journal.entries.map((entry) => entry.idx)
);

function migrationsThrough(throughIndex: number) {
	return {
		journal: {
			...migrations.journal,
			entries: migrations.journal.entries.filter(
				(entry) => entry.idx <= throughIndex
			)
		},
		migrations: Object.fromEntries(
			Object.entries(migrations.migrations).filter(
				([key]) => Math.trunc(Number(key.slice(1))) <= throughIndex
			)
		)
	};
}

/**
 * Applies the registered migrations up to and including `throughIndex` against
 * a Durable Object's raw storage. Calling it twice with seeding in between lets
 * a test plant rows in an older table shape and then assert how a later
 * migration backfills them; the migrator skips migrations already applied.
 */
export function migrateThrough(
	state: DurableObjectState,
	throughIndex: number
): Promise<void> {
	applyMigrations(drizzle(state.storage), migrationsThrough(throughIndex));

	return Promise.resolve();
}

export interface SigningKeySeed {
	readonly id: SigningKeyId;
	readonly name: string;
	readonly signing: boolean;
	readonly published: boolean;
}

export interface SeededSigningKey {
	readonly id: SigningKeyId;
	readonly name: string;
	readonly publicKey: string;
}

/**
 * Plants signing keys directly in the current Durable Object's storage so a
 * test can exercise multi-key signing without going through key rotation. Run
 * it before the DO first loads its keys (the load is cached for the DO's
 * lifetime), before the first bootstrap or read.
 */
export async function seedSigningKeys(
	seeds: readonly SigningKeySeed[]
): Promise<SeededSigningKey[]> {
	return runInDurableObject(harness.server, async (_instance, state) => {
		await migrateThrough(state, latestMigrationIndex);

		const database = drizzle(state.storage, { schema: { signingKeys } });
		const seeded: SeededSigningKey[] = [];

		for (const seed of seeds) {
			const generated = await generateSigningKey(
				nixKeyNameSchema.parse(seed.name)
			);
			const createdAt = new Date();

			database
				.insert(signingKeys)
				.values({
					id: seed.id,
					privateJwkJson: JSON.stringify(generated.privateJwk),
					publicKey: generated.publicKey.value,
					signing: seed.signing,
					published: seed.published,
					createdAt: isoTimestamp(createdAt)
				})
				.run();

			seeded.push({
				id: seed.id,
				name: seed.name,
				publicKey: generated.publicKey.value
			});
		}

		return seeded;
	});
}

export {
	type UploadActionDecision,
	type UploadCommitDecision
} from '@cupboard/protocol/upload';
