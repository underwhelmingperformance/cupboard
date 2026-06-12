import { NixSha256Hash } from '@cupboard/nix/hash';
import { type ResolvedRootTarget } from '@cupboard/nix/store-path';
import {
	type SigningKeyStage,
	type SigningKeySummary
} from '@cupboard/protocol/keys';
import { type OidcTrustSummary } from '@cupboard/protocol/oidc';
import { type RetentionPolicySummary } from '@cupboard/protocol/retention';
import {
	type UploadBlobMetadataFields,
	type UploadPathMetadataFields,
	uploadPathMetadataSchema,
	type UploadPathNegotiationFields,
	uploadPathNegotiationSchema
} from '@cupboard/protocol/upload';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';
import {
	drizzle,
	type DrizzleSqliteDODatabase
} from 'drizzle-orm/durable-sqlite';
import { z } from 'zod';

import { R2Presigner } from '../blob/presign.ts';
import { parseJwk } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	type R2PresignBindingName,
	R2PresignConfigurationMissingError,
	StoredOidcTrustInvalidError,
	StoredUploadMetadataInvalidError,
	TenantNotConfiguredError,
	UploadedObjectChecksumMissingError,
	UploadNotPreparedError
} from '../errors.ts';
import { parseStored, parseStoredJson } from '../http/parse.ts';
import { OidcDiscoveryStore } from '../oidc/oidc.ts';
import { type OidcTrustRule } from '../oidc/oidc-trust.ts';

type WidenStringBindings<T> = {
	readonly [Key in keyof T]: T[Key] extends string ? string : T[Key];
};

// `TenantEnv` is generated from `wrangler.tenant.jsonc`, the config for the script
// this Durable Object actually runs in. It deliberately excludes the control-plane
// bindings (the signing-key wrapping secret, the control audience): the Durable
// Object runs in its own script's context and cannot reach them, and this type
// makes any attempt to read one a compile error.
export type RuntimeEnv = WidenStringBindings<TenantEnv>;

export type SchemaDatabase = DrizzleSqliteDODatabase<typeof schema>;

// Either the DO database or a transaction handle from db.transaction(...); both
// expose the same query builder, so writes can be parameterised over the handle.
export type SchemaWriter =
	| SchemaDatabase
	| Parameters<Parameters<SchemaDatabase['transaction']>[0]>[0];

export const storedSignaturesSchema = z.array(z.string());

export interface SigningKey {
	readonly id: string;
	readonly name: string;
	readonly privateJwk: JsonWebKey;
	readonly publicKey: string;
	readonly signing: boolean;
	readonly published: boolean;
	readonly createdAt: string;
}

export const bootstrapKeyName = 'cupboard-1';

// The owner's admin trust rule is seeded under a fixed id from deploy config;
// the admin CRUD uses generated ids, so it never collides with this one.
export const ownerRuleId = 'owner';

export const storedClaimsSchema = z.record(z.string(), z.string());
export const storedAllowedRootsSchema = z.array(z.string());

export interface OwnerConfig {
	readonly issuer: string;
	readonly subject: string;
	readonly audience: string;
}

export interface GarbageCollectionOutcome {
	readonly pendingUploadsDeleted: number;
	readonly pendingAttestationsDeleted: number;
	readonly rootsExpired: number;
	readonly pathsSwept: number;
	readonly narInfosDeleted: number;
}

// A key in the auth signing set. The newest non-retired key mints; every
// non-retired key verifies and is published in the JWKS. Retiring sets
// `retired`, dropping the key from minting, verification and the JWKS at once.
export interface AuthKey {
	readonly kid: string;
	readonly privateJwk: JsonWebKey;
	readonly publicJwk: JsonWebKey;
	readonly createdAt: string;
	readonly scheduledRetireAt?: string;
	readonly retired: boolean;
}

export interface RootSetCommand {
	readonly name: string;
	readonly targets: readonly ResolvedRootTarget[];
	readonly ttlSeconds: number | undefined;
}

// The outcome of reserving a narinfo row: `reserved` when this commit inserted
// the row (it owns the path and reports `committed`), `mine` when an identical
// commit already holds it (a concurrent winner or this same upload re-driven),
// `lost` when a different narinfo version holds it.
export type ReserveOutcome =
	| { kind: 'reserved'; generation: number }
	| { kind: 'mine'; generation: number }
	| { kind: 'lost'; narHash: string };

// The outcome of materialising a reserved narinfo: `materialised` on success;
// `superseded` when a concurrent recommit replaced the reserved version;
// `blob-gone` when the shared blob (`blob_state` or the canonical object) is no
// longer present and the path must be re-uploaded; `over-quota` when charging the
// blob's canonical size would exceed the tenant's quota, so the caller reclaims the
// reserved row rather than charging; `tenant-inactive` when the tenant is no longer
// active (suspended, offboarding, offboarded, or gone), so the caller reclaims the
// reserved row rather than publishing an edge and object the drain would have to chase.
export type MaterialiseOutcome =
	| 'materialised'
	| 'superseded'
	| 'blob-gone'
	| 'over-quota'
	| 'tenant-inactive';

// The compressed metadata of the one canonical object served for a NAR hash.
// Read from the object itself so a committed narinfo always advertises the
// encoding actually stored, regardless of which upload promoted it.
export interface CanonicalBlob {
	readonly fileHash: string;
	readonly fileSize: number;
}

// The shared state every service is constructed with: the DO SQLite handle, the
// global D1 handle, the runtime environment, the DO state (for critical
// sections), the inbound-OIDC discovery store, and the lazy R2 presigner.
export class ServerContext {
	readonly db: SchemaDatabase;
	readonly d1: DrizzleD1Database<typeof d1Schema>;
	env: RuntimeEnv;
	readonly ctx: DurableObjectState;
	discovery = new OidcDiscoveryStore();
	// Set once the control plane begins offboarding this tenant, so the verify-restore
	// path no-ops rather than re-materialising a narinfo object the drain is removing.
	// In-memory is sufficient: a new write is already refused by the Worker's status
	// gate, so the only caller to guard is an in-flight commit settling on this warm
	// instance, which sees the flag set by the same instance's offboard RPC.
	offboarding = false;
	private presigner: R2Presigner | undefined;

	constructor(ctx: DurableObjectState, env: RuntimeEnv) {
		this.ctx = ctx;
		this.env = env;
		this.db = drizzle(ctx.storage, { schema });
		// The global shared-blob facts live in D1, readable and writable by every
		// tenant DO and the Worker, rather than in this DO's own SQLite.
		this.d1 = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
	}

	r2Presigner(): R2Presigner {
		this.presigner ??= new R2Presigner(r2PresignConfiguration(this.env));

		return this.presigner;
	}

	// This Durable Object's tenant slug, the one source for its tenant-scoped D1
	// reference edges and R2 narinfo keys. It comes from the assigned identity, so a
	// route that reaches a write has already passed the 503 guard; an absent row
	// here is a programming error, surfaced rather than defaulted.
	requireTenant(): string {
		const row = this.db
			.select({ tenant: schema.tenantIdentity.tenant })
			.from(schema.tenantIdentity)
			.get();

		if (row === undefined) {
			throw new TenantNotConfiguredError();
		}

		return row.tenant;
	}
}

interface R2PresignConfiguration {
	readonly accountId: string;
	readonly accessKeyId: string;
	readonly bucketName: string;
	readonly secretAccessKey: string;
}

// The generated env types say `string`, but a secret never put has no binding
// at all and reads as undefined; both spellings of "missing" must count.
interface R2PresignEnv {
	readonly R2_ACCOUNT_ID: string | undefined;
	readonly R2_ACCESS_KEY_ID: string | undefined;
	readonly R2_BUCKET_NAME: string | undefined;
	readonly R2_SECRET_ACCESS_KEY: string | undefined;
}

function r2PresignConfiguration(env: R2PresignEnv): R2PresignConfiguration {
	const missingBindings: R2PresignBindingName[] = [];
	const accountId = env.R2_ACCOUNT_ID ?? '';
	const accessKeyId = env.R2_ACCESS_KEY_ID ?? '';
	const bucketName = env.R2_BUCKET_NAME ?? '';
	const secretAccessKey = env.R2_SECRET_ACCESS_KEY ?? '';

	if (accountId === '') {
		missingBindings.push('R2_ACCOUNT_ID');
	}

	if (accessKeyId === '') {
		missingBindings.push('R2_ACCESS_KEY_ID');
	}

	if (bucketName === '') {
		missingBindings.push('R2_BUCKET_NAME');
	}

	if (secretAccessKey === '') {
		missingBindings.push('R2_SECRET_ACCESS_KEY');
	}

	if (missingBindings.length > 0) {
		throw new R2PresignConfigurationMissingError(missingBindings);
	}

	return { accountId, accessKeyId, bucketName, secretAccessKey };
}

export function oidcTrustRuleFromRow(
	row: typeof schema.oidcTrust.$inferSelect
): OidcTrustRule {
	const fault = (cause: Error): StoredOidcTrustInvalidError =>
		new StoredOidcTrustInvalidError(row.id, cause);

	return {
		id: row.id,
		issuer: row.issuer,
		audience: row.audience,
		scope: row.scope,
		claims: parseStored(storedClaimsSchema, row.claimsJson, fault),
		allowedRoots: parseStored(
			storedAllowedRootsSchema,
			row.allowedRootsJson,
			fault
		)
	};
}

// The admin-facing view of a rule. It omits `jwks_url`, so the listing says who
// is trusted without restating where their keys are fetched from.
export function oidcTrustSummaryFromRow(
	row: typeof schema.oidcTrust.$inferSelect
): OidcTrustSummary {
	const rule = oidcTrustRuleFromRow(row);

	return {
		id: rule.id,
		issuer: rule.issuer,
		audience: rule.audience,
		scope: rule.scope,
		claims: { ...rule.claims },
		allowedRoots: [...rule.allowedRoots],
		disabled: Boolean(row.disabledAt)
	};
}

export function policySummaryFromRow(
	row: typeof schema.retentionPolicies.$inferSelect
): RetentionPolicySummary {
	return {
		id: row.id,
		scope: row.scope,
		pattern: row.pattern,
		ttlSeconds: row.defaultTtlSeconds
	};
}

export function signingKeyFromRow(
	row: typeof schema.signingKeys.$inferSelect
): SigningKey {
	return {
		id: row.id,
		name: row.publicKey.slice(0, row.publicKey.indexOf(':')),
		privateJwk: parseJwk(row.privateJwkJson),
		publicKey: row.publicKey,
		signing: row.signing,
		published: row.published,
		createdAt: row.createdAt
	};
}

// A stable order keeps the rendered `/pubkey` body and the narinfo `Sig:`
// lines deterministic, so a re-materialised narinfo hashes identically.
export function byPublicKey(left: SigningKey, right: SigningKey): number {
	return left.publicKey > right.publicKey ? 1 : -1;
}

function keyStage(key: SigningKey): SigningKeyStage {
	if (key.signing) {
		return 'signing';
	}

	return key.published ? 'publication' : 'absent';
}

export function keySummary(key: SigningKey): SigningKeySummary {
	return {
		id: key.id,
		publicKey: key.publicKey,
		stage: keyStage(key),
		createdAt: key.createdAt
	};
}

const keyNamePattern = /^cupboard-(\d+)$/;

// Each key needs a distinct Nix key name so old and new keys can coexist in a
// client's trusted set during a rotation. Names follow `cupboard-<n>`; the next
// rotation takes the highest existing index plus one.
export function nextKeyName(keys: readonly SigningKey[]): string {
	const indices = keys.flatMap((key) => {
		const match = keyNamePattern.exec(key.name);

		return match === null ? [] : [Number.parseInt(match[1] ?? '0', 10)];
	});
	const next = indices.length === 0 ? 1 : Math.max(...indices) + 1;

	return `cupboard-${String(next)}`;
}

export function commitMetadataFromPathAndBlob(
	path: UploadPathNegotiationFields,
	blob: UploadBlobMetadataFields
): UploadPathMetadataFields {
	return {
		...path,
		fileHash: blob.fileHash,
		fileSize: blob.fileSize,
		compression: blob.compression
	};
}

export function canonicalBlobOf(key: string, object: R2Object): CanonicalBlob {
	const sha256 = object.checksums.sha256;

	if (sha256 === undefined) {
		throw new UploadedObjectChecksumMissingError(key);
	}

	return {
		fileHash: NixSha256Hash.fromDigest(new Uint8Array(sha256)).toString(),
		fileSize: object.size
	};
}

export function parseStoredUploadMetadata(
	uploadId: string,
	source: string
): UploadPathMetadataFields {
	const onInvalid = (cause: Error): StoredUploadMetadataInvalidError =>
		new StoredUploadMetadataInvalidError(uploadId, cause);
	const json = parseStoredJson(source, onInvalid);
	const prepared = uploadPathMetadataSchema.safeParse(json);

	if (prepared.success) {
		return prepared.data;
	}

	// Negotiation stores the path metadata alone until the upload is prepared
	// with its blob details. A well-formed path-only record means the client
	// committed before preparing, not that the stored state is corrupt.
	if (uploadPathNegotiationSchema.safeParse(json).success) {
		throw new UploadNotPreparedError(uploadId);
	}

	throw onInvalid(prepared.error);
}

export function parseStoredUploadPathMetadata(
	uploadId: string,
	source: string
): UploadPathNegotiationFields {
	return parseStored(
		uploadPathNegotiationSchema,
		source,
		(cause) => new StoredUploadMetadataInvalidError(uploadId, cause)
	);
}

export function uploadHeadersFor(
	metadata: UploadPathMetadataFields
): Readonly<Record<string, string>> {
	return {
		'x-amz-checksum-sha256': NixSha256Hash.parse(
			metadata.fileHash
		).digestBase64()
	};
}

// A `cb_roots` entry permits a root by exact name, or — when the entry ends with
// `/` — any root beneath that prefix. The trailing slash is the boundary, so
// `github:owner/` permits `github:owner/repo` while `github:owner` permits only
// itself, never the sibling `github:owner-evil/repo`.
export function rootWithinConstraint(rootName: string, entry: string): boolean {
	if (rootName === entry) {
		return true;
	}

	return entry.endsWith('/') && rootName.startsWith(entry);
}
