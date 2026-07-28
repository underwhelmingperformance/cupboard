import { type AuthKeyId, authKeyIdSchema } from '@cupboard/nix-store/scalars';
import {
	type AuthKeyListResponse,
	type AuthKeyRetireResponse,
	type AuthKeyRotateResponse,
	type AuthKeySummary
} from '@cupboard/protocol/keys';
import {
	refreshTokenGrantType,
	tokenExchangeGrantType
} from '@cupboard/protocol/oidc';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';

import {
	type AccessClaims,
	authJwtAlgorithm,
	type AuthPublicKey,
	bearerToken,
	generateAuthKeyPair,
	scheduledAccessKeyRetireAt,
	verifyAccessJwt
} from '../auth/auth.ts';
import { parseJwk } from '../crypto/crypto.ts';
import * as schema from '../db/schema.ts';
import {
	LastAuthKeyError,
	TenantNotConfiguredError,
	UnauthenticatedError
} from '../errors.ts';
import { type RequestOrigin } from '../http/http.ts';

import { type AuthKey, type ServerContext } from './context.ts';
import {
	type TenantIdentity,
	type TenantIdentityService
} from './tenant-identity-service.ts';

/** The RFC 8414 document a tenant advertises for its token endpoint. */
export interface AuthorizationServerMetadata {
	issuer: string;
	token_endpoint: string;
	jwks_uri: string;
	grant_types_supported: string[];
	authorization_details_types_supported: string[];
	token_endpoint_auth_methods_supported: string[];
}

export class AuthKeysService {
	private authKeysPromise: Promise<readonly AuthKey[]> | undefined;

	constructor(
		private readonly context: ServerContext,
		private readonly tenantIdentity: TenantIdentityService
	) {}

	// Identity is the sole source for the issuer and audience the tenant issues and
	// verifies under. An unconfigured Durable Object has no identity and cannot issue
	// or verify; an unconfigured tenant always fails with a 500.
	private requireIdentity(): TenantIdentity {
		const identity = this.tenantIdentity.current();

		if (identity === undefined) {
			throw new TenantNotConfiguredError();
		}

		return identity;
	}

	private authKeys(): Promise<readonly AuthKey[]> {
		// A shared in-flight promise so concurrent first requests against an
		// empty DO generate and insert the bootstrap key exactly once. A failed
		// attempt clears the cache so a later request can create it.
		this.authKeysPromise ??= this.loadAuthKeysClearingCacheOnFailure();

		return this.authKeysPromise;
	}

	private async loadAuthKeysClearingCacheOnFailure(): Promise<
		readonly AuthKey[]
	> {
		try {
			return await this.loadOrCreateAuthKeys();
		} catch (error: unknown) {
			this.authKeysPromise = undefined;
			throw error;
		}
	}

	private async loadOrCreateAuthKeys(): Promise<readonly AuthKey[]> {
		// Insertion order (rowid) decides which key is active, so a rotation always
		// supersedes the previous key regardless of timestamp resolution.
		const rows = this.context.db
			.select()
			.from(schema.authKeys)
			.orderBy(sql`rowid`)
			.all();

		if (rows.length > 0) {
			return rows.map((row) => this.authKeyFromRow(row));
		}

		const generated = await generateAuthKeyPair();
		const kid = authKeyIdSchema.parse(crypto.randomUUID());
		const createdAtIso = isoTimestamp(new Date());

		this.context.db
			.insert(schema.authKeys)
			.values({
				id: 'active',
				kid,
				privateJwkJson: JSON.stringify(generated.privateJwk),
				publicJwkJson: JSON.stringify(generated.publicJwk),
				createdAt: createdAtIso
			})
			.run();

		return [{ kid, ...generated, createdAt: createdAtIso, retired: false }];
	}

	private authKeyFromRow(row: typeof schema.authKeys.$inferSelect): AuthKey {
		// A pre-rotation row predates `kid`; give it one on first load so every
		// key the verifier and JWKS see is addressable.
		const kid = row.kid === '' ? this.backfillAuthKeyKid(row.id) : row.kid;

		return {
			kid,
			privateJwk: parseJwk(row.privateJwkJson),
			publicJwk: parseJwk(row.publicJwkJson),
			createdAt: row.createdAt,
			scheduledRetireAt: row.scheduledRetireAt ?? undefined,
			retired: Boolean(row.retiredAt)
		};
	}

	private backfillAuthKeyKid(id: string): AuthKeyId {
		const kid = authKeyIdSchema.parse(crypto.randomUUID());

		this.context.db
			.update(schema.authKeys)
			.set({ kid })
			.where(eq(schema.authKeys.id, id))
			.run();

		return kid;
	}

	private async authKeySummaries(): Promise<AuthKeySummary[]> {
		const active = await this.activeAuthKey();
		const keys = await this.authKeys();

		// Listed in insertion order, the same order that decides the active key.
		return keys
			.filter((key) => !key.retired)
			.map((key) => ({
				kid: key.kid,
				createdAt: key.createdAt,
				active: key.kid === active.kid,
				...(key.scheduledRetireAt !== undefined && {
					scheduledRetireAt: key.scheduledRetireAt
				})
			}));
	}

	// RFC 8414 authorization-server metadata. Served from the Durable Object (not the
	// edge) so an unconfigured tenant 500s through the fetch guard and advertises
	// no identity until one has been assigned. The endpoints are built from
	// the request's own path-based URL, which provisioning stamps as the issuer, so
	// the advertised issuer equals the `iss` of a token this tenant issues.
	authorizationServerMetadata(
		origin: RequestOrigin
	): AuthorizationServerMetadata {
		const base = `${origin}/t/${this.context.requireTenant()}`;

		return {
			issuer: base,
			token_endpoint: `${base}/token`,
			jwks_uri: `${base}/.well-known/jwks.json`,
			grant_types_supported: [tokenExchangeGrantType, refreshTokenGrantType],
			authorization_details_types_supported: [
				'cupboard_cache',
				'cupboard_domain',
				'cupboard_wildcard'
			],
			token_endpoint_auth_methods_supported: ['none']
		};
	}

	async authKeyList(): Promise<AuthKeyListResponse> {
		return { keys: await this.authKeySummaries() };
	}

	authIssuer(): string {
		return this.requireIdentity().issuer;
	}

	authAudience(): string {
		return this.requireIdentity().audience;
	}

	resetAuthKeyCache(): void {
		this.authKeysPromise = undefined;
	}

	// The issuing key: the last key inserted that is still in service, so a fresh
	// rotation takes over issuing at once.
	async activeAuthKey(): Promise<AuthKey> {
		const keys = await this.authKeys();
		const active =
			keys.findLast(
				(key) => !key.retired && key.scheduledRetireAt === undefined
			) ?? keys.findLast((key) => !key.retired);

		if (active === undefined) {
			throw new Error('no active auth key in the key set');
		}

		return active;
	}

	async authVerificationKeys(): Promise<readonly AuthPublicKey[]> {
		const keys = await this.authKeys();

		return keys
			.filter((key) => !key.retired)
			.map((key) => ({ kid: key.kid, publicJwk: key.publicJwk }));
	}

	async rotateAuthKey(): Promise<AuthKeyRotateResponse> {
		// Generate the new key pair before the gate: it is independent of the
		// stored key set, so the keygen need not hold the input gate. Only the read
		// of the outgoing key, the insert and the cache reset need the critical
		// section, which must not interleave with a concurrent rotation or a
		// verification reading the key set.
		const generated = await generateAuthKeyPair();
		const kid = authKeyIdSchema.parse(crypto.randomUUID());
		const rotatedAt = new Date();
		const scheduledRetireAt = scheduledAccessKeyRetireAt(rotatedAt);

		return this.context.criticalSection(async () => {
			const outgoing = await this.activeAuthKey();

			this.context.db
				.update(schema.authKeys)
				.set({ scheduledRetireAt })
				.where(eq(schema.authKeys.kid, outgoing.kid))
				.run();
			this.context.db
				.insert(schema.authKeys)
				.values({
					id: crypto.randomUUID(),
					kid,
					privateJwkJson: JSON.stringify(generated.privateJwk),
					publicJwkJson: JSON.stringify(generated.publicJwk),
					createdAt: isoTimestamp(rotatedAt)
				})
				.run();
			this.resetAuthKeyCache();

			return {
				rotated: kid,
				retiring: { kid: outgoing.kid, scheduledRetireAt },
				keys: await this.authKeySummaries()
			};
		});
	}

	async retireAuthKey(kid: AuthKeyId): Promise<AuthKeyRetireResponse> {
		// The last-key check and the retirement share one critical section so two
		// concurrent retirements cannot both see themselves as safe. A refused
		// retirement is returned as an outcome and thrown afterwards: throwing
		// inside blockConcurrencyWhile would break the input gate.
		const outcome = await this.context.criticalSection(
			async (): Promise<{ retired: boolean } | { refused: true }> => {
				const keys = await this.authKeys();
				const live = keys.filter((key) => !key.retired);
				const target = live.find((key) => key.kid === kid);

				if (target === undefined) {
					return { retired: false };
				}

				if (live.length <= 1) {
					return { refused: true };
				}

				this.context.db
					.update(schema.authKeys)
					.set({ retiredAt: isoTimestamp(new Date()) })
					.where(eq(schema.authKeys.kid, kid))
					.run();
				this.resetAuthKeyCache();

				return { retired: true };
			}
		);

		if ('refused' in outcome) {
			throw new LastAuthKeyError(kid);
		}

		return { kid, retired: outcome.retired };
	}

	async retireScheduledAuthKeys(now: Date = new Date()): Promise<number> {
		return this.context.criticalSection(() => {
			const nowIso = isoTimestamp(now);
			const due = this.context.db
				.select({ kid: schema.authKeys.kid })
				.from(schema.authKeys)
				.where(
					and(
						isNull(schema.authKeys.retiredAt),
						isNotNull(schema.authKeys.scheduledRetireAt),
						lte(schema.authKeys.scheduledRetireAt, nowIso)
					)
				)
				.orderBy(schema.authKeys.scheduledRetireAt, schema.authKeys.createdAt)
				.all();
			let retired = 0;

			for (const key of due) {
				const live = this.context.db
					.select({ kid: schema.authKeys.kid })
					.from(schema.authKeys)
					.where(isNull(schema.authKeys.retiredAt))
					.all();

				if (live.length <= 1) {
					continue;
				}

				this.context.db
					.update(schema.authKeys)
					.set({ retiredAt: nowIso })
					.where(eq(schema.authKeys.kid, key.kid))
					.run();
				retired += 1;
			}

			if (retired > 0) {
				this.resetAuthKeyCache();
			}

			return Promise.resolve(retired);
		});
	}

	async authPublicJwks(): Promise<JsonWebKeyWithKid[]> {
		const keys = await this.authVerificationKeys();

		return keys.map((key) => ({
			...key.publicJwk,
			kid: key.kid,
			alg: authJwtAlgorithm,
			use: 'sig'
		}));
	}

	// Authenticate the bearer token and return its claims (subject and grants).
	// Authorisation against what those grants cover is a separate decision the
	// router makes via the contract's per-procedure metadata.
	async authenticate(request: Request): Promise<AccessClaims> {
		const token = bearerToken(request);

		if (token === undefined) {
			throw new UnauthenticatedError();
		}

		const keys = await this.authVerificationKeys();

		try {
			return await verifyAccessJwt(
				keys,
				token,
				{ issuer: this.authIssuer(), audience: this.authAudience() },
				new Date()
			);
		} catch {
			throw new UnauthenticatedError();
		}
	}
}
