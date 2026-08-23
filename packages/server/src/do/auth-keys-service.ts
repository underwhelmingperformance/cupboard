import { type AuthKeyId, authKeyIdSchema } from '@cupboard/nix-store/scalars';
import {
	type AuthKeyListResponse,
	type AuthKeyRetireResponse,
	type AuthKeyRotateResponse,
	type AuthKeySummary
} from '@cupboard/protocol/keys';
import {
	type OidcAudience,
	type OidcIssuer,
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

	// Token issuance and verification use the identity assigned during tenant
	// configuration. An unconfigured object cannot authenticate tokens.
	private requireIdentity(): TenantIdentity {
		const identity = this.tenantIdentity.current();

		if (identity === undefined) {
			throw new TenantNotConfiguredError();
		}

		return identity;
	}

	private authKeys(): Promise<readonly AuthKey[]> {
		// Share bootstrap key creation across concurrent first requests. Clear a
		// failed promise so a later request can retry.
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
		// Use insertion order instead of timestamps so every rotation has a strict
		// order even within one clock tick.
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
		// Backfill legacy rows so every verification key is addressable by `kid`.
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

	// Build RFC 8414 metadata from the assigned tenant URL. An unconfigured tenant
	// publishes no issuer, and the advertised issuer matches its token `iss` value.
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

	authIssuer(): OidcIssuer {
		return this.requireIdentity().issuer;
	}

	authAudience(): OidcAudience {
		return this.requireIdentity().audience;
	}

	resetAuthKeyCache(): void {
		this.authKeysPromise = undefined;
	}

	// The newest live, non-retiring key signs new tokens. Retiring keys remain
	// available for verification.
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
		// Generate independent key material before entering the input gate. Read the
		// outgoing key and insert its replacement atomically with respect to other
		// rotations and key-set reads.
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
		// Check and retire inside one critical section so concurrent calls cannot
		// remove the last key. Return refusal from the gate and throw afterwards;
		// an exception inside `blockConcurrencyWhile` would break the input gate.
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

	// Authentication verifies the token and returns its subject and grants. The
	// router separately checks those grants against procedure metadata.
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
