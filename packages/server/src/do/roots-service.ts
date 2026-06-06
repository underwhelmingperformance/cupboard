import { rootNameSchema } from '@cupboard/nix/scalars';
import { resolveRootTargets } from '@cupboard/nix/store-path';
import {
	type RootListResponse,
	type RootRemoveResponse,
	rootSetBodySchema,
	type RootSetResponse,
	type RootSummary
} from '@cupboard/protocol/retention';
import { and, eq } from 'drizzle-orm';

import { type AccessClaims } from '../auth/auth.ts';
import * as schema from '../db/schema.ts';
import {
	RootNotPermittedError,
	RootTargetsUnavailableError
} from '../errors.ts';
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

interface StoredRoot {
	readonly expiresAt: string | undefined;
	readonly createdAt: string;
	readonly updatedAt: string;
}

type RootActivation =
	| { readonly kind: 'rejected'; readonly unavailable: readonly string[] }
	| {
			readonly kind: 'written';
			readonly stored: StoredRoot;
			readonly presence: ReadonlyMap<string, boolean>;
	  };

export class RootsService {
	constructor(
		private readonly context: ServerContext,
		private readonly authKeys: AuthKeysService,
		private readonly cacheAdmin: CacheAdminService,
		private readonly retention: RetentionService,
		private readonly narInfoObjects: NarInfoObjectsService
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

		// Activation gates on the serve predicate so a root never advertises a path
		// that is not yet substitutable. The check (repairing a merely-lost object)
		// and the write share one critical section, so a concurrent delete cannot
		// remove a target between them and leave a root over an unservable path; an
		// unavailable target rejects without writing, leaving the existing root
		// untouched. The rejection is thrown after the section so a validation error
		// does not reset the Durable Object.
		const activation = await this.context.ctx.blockConcurrencyWhile(
			async (): Promise<RootActivation> => {
				const presence = await this.presence(cache, requested.targets, (hash) =>
					this.narInfoObjects.isServableLocked(cache, hash)
				);
				const unavailable = requested.targets
					.filter((target) => presence.get(target.storePathHash) !== true)
					.map((target) => target.storePath);

				if (unavailable.length > 0) {
					return { kind: 'rejected', unavailable };
				}

				return {
					kind: 'written',
					stored: this.writeRoot(cache, requested),
					presence
				};
			}
		);

		if (activation.kind === 'rejected') {
			throw new RootTargetsUnavailableError(rootName, activation.unavailable);
		}

		return Response.json(
			this.rootSummaryFrom(
				rootName,
				activation.stored,
				activation.stored.updatedAt,
				requested.targets,
				activation.presence
			) satisfies RootSetResponse
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

	private writeRoot(cache: string, request: RootSetCommand): StoredRoot {
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

		return { expiresAt, createdAt, updatedAt: nowIso };
	}

	private async listRoots(cache: string): Promise<RootListResponse> {
		const now = new Date().toISOString();
		const roots = this.context.db
			.select()
			.from(schema.retentionRoots)
			.where(eq(schema.retentionRoots.cache, cache))
			.all();

		const summaries: RootSummary[] = [];

		for (const root of roots) {
			const targets = this.rootTargetRows(cache, root.name);
			const presence = await this.presence(cache, targets, (hash) =>
				this.narInfoObjects.isServable(cache, hash)
			);

			summaries.push(
				this.rootSummaryFrom(
					root.name,
					{
						expiresAt: root.expiresAt ?? undefined,
						createdAt: root.createdAt,
						updatedAt: root.updatedAt
					},
					now,
					targets,
					presence
				)
			);
		}

		return { roots: summaries.toSorted((a, b) => (a.name > b.name ? 1 : -1)) };
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

	private rootTargetRows(
		cache: string,
		name: string
	): readonly { storePathHash: string; storePath: string }[] {
		return this.context.db
			.select({
				storePathHash: schema.retentionRootTargets.storePathHash,
				storePath: schema.retentionRootTargets.storePath
			})
			.from(schema.retentionRootTargets)
			.where(
				and(
					eq(schema.retentionRootTargets.cache, cache),
					eq(schema.retentionRootTargets.rootName, name)
				)
			)
			.all();
	}

	// The serve predicate for each distinct target hash, repairing a merely-lost
	// object on the way. The caller supplies the predicate: the activation gate
	// passes the locked variant so it runs inside the gate's critical section,
	// while a summary passes the section-opening variant. Both report exactly what
	// serving would, so the gate and the `present` flag cannot drift.
	private async presence(
		cache: string,
		targets: readonly { storePathHash: string }[],
		isServable: (storePathHash: string) => Promise<boolean>
	): Promise<ReadonlyMap<string, boolean>> {
		const presence = new Map<string, boolean>();

		for (const { storePathHash } of targets) {
			if (presence.has(storePathHash)) {
				continue;
			}

			presence.set(storePathHash, await isServable(storePathHash));
		}

		return presence;
	}

	private rootSummaryFrom(
		name: string,
		stored: StoredRoot,
		now: string,
		targets: readonly { storePathHash: string; storePath: string }[],
		presence: ReadonlyMap<string, boolean>
	): RootSummary {
		return {
			name,
			...(stored.expiresAt === undefined
				? {}
				: { expiresAt: stored.expiresAt }),
			expired: stored.expiresAt !== undefined && stored.expiresAt <= now,
			createdAt: stored.createdAt,
			updatedAt: stored.updatedAt,
			targets: targets
				.map((target) => ({
					storePathHash: target.storePathHash,
					storePath: target.storePath,
					present: presence.get(target.storePathHash) === true
				}))
				.toSorted((a, b) => (a.storePathHash > b.storePathHash ? 1 : -1))
		};
	}
}
