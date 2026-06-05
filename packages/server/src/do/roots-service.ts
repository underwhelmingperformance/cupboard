import { rootNameSchema } from '@cupboard/nix/scalars';
import { resolveRootTargets } from '@cupboard/nix/store-path';
import {
	type RootListResponse,
	type RootRemoveResponse,
	rootSetBodySchema,
	type RootSetResponse,
	type RootSummary,
	type RootTarget
} from '@cupboard/protocol/retention';
import { and, eq } from 'drizzle-orm';

import { type AccessClaims } from '../auth/auth.ts';
import * as schema from '../db/schema.ts';
import { RootNotPermittedError } from '../errors.ts';
import { parseRequestBody, parseRequestValue } from '../http/parse.ts';
import { coldPathTtlSeconds, resolveRootExpiry } from '../policy/cold-path.ts';

import { type AuthKeysService } from './auth-keys-service.ts';
import { type CacheAdminService } from './cache-admin-service.ts';
import {
	type RootSetCommand,
	rootWithinConstraint,
	type ServerContext
} from './context.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import { type RetentionService } from './retention-service.ts';

export class RootsService {
	constructor(
		private readonly context: ServerContext,
		private readonly authKeys: AuthKeysService,
		private readonly cacheAdmin: CacheAdminService,
		private readonly narInfoObjects: NarInfoObjectsService,
		private readonly retention: RetentionService
	) {}

	async handleSetRoot(
		request: Request,
		cache: string,
		name: string
	): Promise<Response> {
		const claims = await this.authKeys.requireScope(request, 'write');
		const rootName = parseRequestValue(rootNameSchema, name);

		this.enforceRootConstraint(claims, rootName);

		const body = await parseRequestBody(rootSetBodySchema, request);
		const requested: RootSetCommand = {
			name: rootName,
			targets: resolveRootTargets(body.targets),
			ttlSeconds: body.ttlSeconds
		};

		return Response.json(
			(await this.setRoot(cache, requested)) satisfies RootSetResponse
		);
	}

	private enforceRootConstraint(claims: AccessClaims, rootName: string): void {
		// An admin token (owner) may set any root. A write token (CI) may set only
		// the roots its `cb_roots` permits; carrying none — absent or empty — it
		// may set nothing.
		if (claims.scope === 'admin') {
			return;
		}

		const permitted = claims.cbRoots ?? [];

		if (permitted.some((entry) => rootWithinConstraint(rootName, entry))) {
			return;
		}

		throw new RootNotPermittedError(rootName);
	}

	async handleListRoots(request: Request, cache: string): Promise<Response> {
		await this.authKeys.requireScope(request, 'admin');

		return Response.json(
			(await this.listRoots(cache)) satisfies RootListResponse
		);
	}

	async handleRemoveRoot(
		request: Request,
		cache: string,
		name: string
	): Promise<Response> {
		await this.authKeys.requireScope(request, 'admin');

		const rootName = parseRequestValue(rootNameSchema, name);

		return Response.json(
			this.removeRoot(cache, rootName) satisfies RootRemoveResponse
		);
	}

	private async setRoot(
		cache: string,
		request: RootSetCommand
	): Promise<RootSetResponse> {
		const now = new Date();
		const nowIso = now.toISOString();
		// Precedence: an explicit TTL, then a matching retention policy, then the
		// cold-path default for an implicit pin, otherwise permanent.
		const expiresAt = resolveRootExpiry({
			explicitTtlSeconds: request.ttlSeconds,
			policyTtlSeconds: this.retention.resolvePolicyTtl(cache, request.name),
			name: request.name,
			coldPathTtlSeconds: coldPathTtlSeconds(this.context.env),
			now
		});

		this.cacheAdmin.loadOrCreateCache(cache);

		// Replace the root wholesale: a re-set fully declares the channel, so the
		// old row and target set are dropped and rewritten. The createdAt of an
		// existing channel is preserved; an absent expiry stores SQL NULL via the
		// undefined insert value.
		const createdAt = this.context.db.transaction((tx) => {
			const existing = tx
				.select()
				.from(schema.retentionRoots)
				.where(
					and(
						eq(schema.retentionRoots.cache, cache),
						eq(schema.retentionRoots.name, request.name)
					)
				)
				.get();
			const created = existing?.createdAt ?? nowIso;

			tx.delete(schema.retentionRootTargets)
				.where(
					and(
						eq(schema.retentionRootTargets.cache, cache),
						eq(schema.retentionRootTargets.rootName, request.name)
					)
				)
				.run();
			tx.delete(schema.retentionRoots)
				.where(
					and(
						eq(schema.retentionRoots.cache, cache),
						eq(schema.retentionRoots.name, request.name)
					)
				)
				.run();

			tx.insert(schema.retentionRoots)
				.values({
					cache,
					name: request.name,
					expiresAt,
					createdAt: created,
					updatedAt: nowIso
				})
				.run();

			tx.insert(schema.retentionRootTargets)
				.values(
					request.targets.map((target) => ({
						cache,
						rootName: request.name,
						storePathHash: target.storePathHash,
						storePath: target.storePath
					}))
				)
				.run();

			return created;
		});

		return this.rootSummary(
			cache,
			request.name,
			expiresAt,
			createdAt,
			nowIso,
			nowIso
		);
	}

	private async listRoots(cache: string): Promise<RootListResponse> {
		const now = new Date().toISOString();
		const roots = this.context.db
			.select()
			.from(schema.retentionRoots)
			.where(eq(schema.retentionRoots.cache, cache))
			.all();

		return {
			roots: (
				await Promise.all(
					roots.map((root) =>
						this.rootSummary(
							cache,
							root.name,
							root.expiresAt ?? undefined,
							root.createdAt,
							root.updatedAt,
							now
						)
					)
				)
			).toSorted((a, b) => (a.name > b.name ? 1 : -1))
		};
	}

	private removeRoot(cache: string, name: string): RootRemoveResponse {
		return this.context.db.transaction((tx) => {
			const existing = tx
				.select()
				.from(schema.retentionRoots)
				.where(
					and(
						eq(schema.retentionRoots.cache, cache),
						eq(schema.retentionRoots.name, name)
					)
				)
				.get();

			tx.delete(schema.retentionRootTargets)
				.where(
					and(
						eq(schema.retentionRootTargets.cache, cache),
						eq(schema.retentionRootTargets.rootName, name)
					)
				)
				.run();
			tx.delete(schema.retentionRoots)
				.where(
					and(
						eq(schema.retentionRoots.cache, cache),
						eq(schema.retentionRoots.name, name)
					)
				)
				.run();

			return { name, removed: existing !== undefined };
		});
	}

	private async rootSummary(
		cache: string,
		name: string,
		expiresAt: string | undefined,
		createdAt: string,
		updatedAt: string,
		now: string
	): Promise<RootSummary> {
		const targets = this.context.db
			.select()
			.from(schema.retentionRootTargets)
			.where(
				and(
					eq(schema.retentionRootTargets.cache, cache),
					eq(schema.retentionRootTargets.rootName, name)
				)
			)
			.all();

		return {
			name,
			...(expiresAt === undefined ? {} : { expiresAt }),
			expired: expiresAt !== undefined && expiresAt <= now,
			createdAt,
			updatedAt,
			targets: await this.rootTargets(cache, targets)
		};
	}

	private async rootTargets(
		cache: string,
		pairs: readonly { storePathHash: string; storePath: string }[]
	): Promise<RootTarget[]> {
		const targets = await Promise.all(
			pairs.map(async (pair) => ({
				storePathHash: pair.storePathHash,
				storePath: pair.storePath,
				present: await this.hasCommittedNarInfo(cache, pair.storePathHash)
			}))
		);

		return targets.toSorted((a, b) =>
			a.storePathHash > b.storePathHash ? 1 : -1
		);
	}

	private async hasCommittedNarInfo(
		cache: string,
		storePathHash: string
	): Promise<boolean> {
		return (
			(await this.narInfoObjects.committedNarInfoRow(cache, storePathHash)) !==
			undefined
		);
	}
}
