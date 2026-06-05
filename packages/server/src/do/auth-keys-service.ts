import {
	type AuthKeyListResponse,
	type AuthKeyRetireResponse,
	type AuthKeyRotateResponse,
	type AuthKeySummary
} from '@cupboard/protocol/keys';
import {
	defaultAuthAudience,
	defaultAuthIssuer
} from '@cupboard/protocol/oidc-issuer';
import { eq, sql } from 'drizzle-orm';

import {
	type AccessClaims,
	type AccessScope,
	authJwtAlgorithm,
	type AuthPublicKey,
	bearerToken,
	generateAuthKeyPair,
	verifyAccessJwt
} from '../auth/auth.ts';
import * as schema from '../db/schema.ts';
import {
	InsufficientScopeError,
	LastAuthKeyError,
	UnauthenticatedError
} from '../errors.ts';

import { type AuthKey, type ServerContext } from './context.ts';

export class AuthKeysService {
	private authKeysPromise: Promise<readonly AuthKey[]> | undefined;

	constructor(private readonly context: ServerContext) {}

	async handleJwks(_request: Request): Promise<Response> {
		const keys = await this.authPublicJwks();

		// Served uncached so a key rotation is visible across colos at once.
		return Response.json(
			{ keys },
			{ headers: { 'cache-control': 'no-cache' } }
		);
	}

	async handleAuthKeyList(request: Request): Promise<Response> {
		await this.requireScope(request, 'admin');

		return Response.json({
			keys: await this.authKeySummaries()
		} satisfies AuthKeyListResponse);
	}

	async handleAuthKeyRotate(request: Request): Promise<Response> {
		await this.requireScope(request, 'admin');

		return Response.json(
			(await this.rotateAuthKey()) satisfies AuthKeyRotateResponse
		);
	}

	async handleAuthKeyRetire(request: Request, kid: string): Promise<Response> {
		await this.requireScope(request, 'admin');

		return Response.json(
			(await this.retireAuthKey(kid)) satisfies AuthKeyRetireResponse
		);
	}

	authIssuer(): string {
		return this.context.env.CUPBOARD_AUTH_ISSUER || defaultAuthIssuer;
	}

	authAudience(): string {
		return this.context.env.CUPBOARD_AUTH_AUDIENCE || defaultAuthAudience;
	}

	private authKeys(): Promise<readonly AuthKey[]> {
		// A shared in-flight promise so concurrent first requests against an
		// empty DO generate and insert the bootstrap key exactly once. A failed
		// attempt clears the cache so a later request can create it.
		this.authKeysPromise ??= this.loadOrCreateAuthKeys().catch(
			(error: unknown) => {
				this.authKeysPromise = undefined;
				throw error;
			}
		);

		return this.authKeysPromise;
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
		const kid = crypto.randomUUID();
		const createdAt = new Date().toISOString();

		this.context.db
			.insert(schema.authKeys)
			.values({
				id: 'active',
				kid,
				privateJwkJson: JSON.stringify(generated.privateJwk),
				publicJwkJson: JSON.stringify(generated.publicJwk),
				createdAt
			})
			.run();

		return [{ kid, ...generated, createdAt, retired: false }];
	}

	private authKeyFromRow(row: typeof schema.authKeys.$inferSelect): AuthKey {
		// A pre-rotation row predates `kid`; give it one on first load so every
		// key the verifier and JWKS see is addressable.
		const kid = row.kid === '' ? this.backfillAuthKeyKid(row.id) : row.kid;

		return {
			kid,
			privateJwk: JSON.parse(row.privateJwkJson) as JsonWebKey,
			publicJwk: JSON.parse(row.publicJwkJson) as JsonWebKey,
			createdAt: row.createdAt,
			retired: Boolean(row.retiredAt)
		};
	}

	private backfillAuthKeyKid(id: string): string {
		const kid = crypto.randomUUID();

		this.context.db
			.update(schema.authKeys)
			.set({ kid })
			.where(eq(schema.authKeys.id, id))
			.run();

		return kid;
	}

	private resetAuthKeyCache(): void {
		this.authKeysPromise = undefined;
	}

	// The minting key: the last key inserted that is still in service, so a fresh
	// rotation takes over minting at once.
	async activeAuthKey(): Promise<AuthKey> {
		const keys = await this.authKeys();
		const active = keys.findLast((key) => !key.retired);

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

	private async authKeySummaries(): Promise<AuthKeySummary[]> {
		const active = await this.activeAuthKey();
		const keys = await this.authKeys();

		// Listed in insertion order, the same order that decides the active key.
		return keys
			.filter((key) => !key.retired)
			.map((key) => ({
				kid: key.kid,
				createdAt: key.createdAt,
				active: key.kid === active.kid
			}));
	}

	private rotateAuthKey(): Promise<AuthKeyRotateResponse> {
		// One critical section: the insert and cache reset must not interleave
		// with a concurrent rotation or a verification reading the key set.
		return this.context.ctx.blockConcurrencyWhile(async () => {
			const generated = await generateAuthKeyPair();
			const kid = crypto.randomUUID();

			this.context.db
				.insert(schema.authKeys)
				.values({
					id: crypto.randomUUID(),
					kid,
					privateJwkJson: JSON.stringify(generated.privateJwk),
					publicJwkJson: JSON.stringify(generated.publicJwk),
					createdAt: new Date().toISOString()
				})
				.run();
			this.resetAuthKeyCache();

			return { rotated: kid, keys: await this.authKeySummaries() };
		});
	}

	private async retireAuthKey(kid: string): Promise<AuthKeyRetireResponse> {
		// The last-key check and the retirement share one critical section so two
		// concurrent retirements cannot both see themselves as safe. A refused
		// retirement is returned as an outcome and thrown afterwards: throwing
		// inside blockConcurrencyWhile would break the input gate.
		const outcome = await this.context.ctx.blockConcurrencyWhile(
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
					.set({ retiredAt: new Date().toISOString() })
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

	async authPublicJwks(): Promise<JsonWebKeyWithKid[]> {
		const keys = await this.authVerificationKeys();

		return keys.map((key) => ({
			...key.publicJwk,
			kid: key.kid,
			alg: authJwtAlgorithm,
			use: 'sig'
		}));
	}

	async requireScope(
		request: Request,
		required: AccessScope
	): Promise<AccessClaims> {
		const token = bearerToken(request);

		if (token === undefined) {
			throw new UnauthenticatedError();
		}

		const keys = await this.authVerificationKeys();
		let claims: AccessClaims;

		try {
			claims = await verifyAccessJwt(
				keys,
				token,
				{ issuer: this.authIssuer(), audience: this.authAudience() },
				new Date()
			);
		} catch {
			throw new UnauthenticatedError();
		}

		// admin satisfies any write-gated route; write satisfies only write.
		if (claims.scope !== 'admin' && claims.scope !== required) {
			throw new InsufficientScopeError();
		}

		return claims;
	}
}
