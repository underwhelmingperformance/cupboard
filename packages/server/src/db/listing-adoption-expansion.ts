import {
	type NarListingIdentity,
	narListingIdentitySchema
} from '@cupboard/protocol/artifacts';
import { and, asc, desc, eq, gt, lte, or, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import {
	type ListingAdoptionCaptureSource,
	listingAdoptionCaptureSourceSchema
} from '../blob/listing-adoption-capture.ts';
import {
	type ListingAdoptionExpansionOpenResult,
	type ListingAdoptionExpansionPageResult,
	type ListingAdoptionExpansionWindow,
	listingAdoptionExpansionWindowSchema
} from '../blob/listing-adoption-expansion.ts';
import {
	type ListingAdoptionParent,
	listingAdoptionParentSchema
} from '../blob/listing-adoption-parents.ts';
import { registeredLiveObjectIncarnation } from '../blob/object-incarnation.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import { cacheIdentityCondition } from './cache.ts';
import * as schema from './d1-schema.ts';
import { recordedTransitions } from './deployment-transitions.ts';
import { ListingAdoptionParentStore } from './listing-adoption-parents.ts';
import { ListingFactStore } from './listing-facts.ts';

type ParentWindow = Extract<ListingAdoptionExpansionWindow, { kind: 'parent' }>;
type ListingWindow = Extract<
	ListingAdoptionExpansionWindow,
	{ kind: 'listing' }
>;
type CasWindow = Extract<ListingAdoptionExpansionWindow, { kind: 'cas' }>;
const pageSize = 32;

/**
Refreshes parent hints and discovers bounded metadata fan-out within fixed
windows. Targets remain advisory; publication requires the tenant DO authority.
*/
export class ListingAdoptionExpansionDiscovery {
	constructor(private readonly database: DrizzleD1Database<typeof schema>) {}

	private async execute<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof SharedFactsUnavailableError) {
				throw error;
			}
			throw new SharedFactsUnavailableError(error);
		}
	}

	private async ready(
		kind: ListingAdoptionCaptureSource['kind']
	): Promise<boolean> {
		const table = schema.deploymentTransition;
		const transitions = or(
			eq(table.id, 'listing-adoption-capture'),
			eq(table.id, 'listing-adoption-parents')
		);
		const rows = await this.database
			.select({ id: table.id, state: table.state })
			.from(table)
			.where(transitions);
		const states = recordedTransitions(rows);
		if (
			states.get('listing-adoption-capture') !== 'complete' ||
			(kind !== 'cas' && states.get('listing-adoption-parents') !== 'complete')
		) {
			return false;
		}
		const capture = await this.database
			.select({ isReady: schema.listingAdoptionCaptureState.isReady })
			.from(schema.listingAdoptionCaptureState)
			.where(eq(schema.listingAdoptionCaptureState.id, 1))
			.get();
		return capture?.isReady === true;
	}

	private async currentParent(parent: ListingAdoptionParent): Promise<boolean> {
		const table = schema.listingAdoptionParent;
		const cache = cacheIdentityCondition(
			table.cacheKind,
			table.cacheName,
			parent.cache
		);
		const identity = and(
			eq(table.id, parent.id),
			eq(table.tenant, parent.tenant),
			cache,
			eq(table.cacheGeneration, parent.cacheGeneration),
			eq(table.storePathHash, parent.storePathHash),
			eq(table.generation, parent.generation),
			eq(table.narHash, parent.narHash)
		);
		const row = await this.database
			.select({ id: table.id })
			.from(table)
			.where(identity)
			.get();
		return row !== undefined;
	}

	private async currentCas(
		source: Pick<CasWindow, 'digest' | 'incarnation'>
	): Promise<boolean> {
		const table = schema.casObject;
		const live = registeredLiveObjectIncarnation(
			this.database,
			'cas',
			source.digest,
			source.incarnation
		);
		const current = and(
			eq(table.digest, source.digest),
			eq(table.incarnation, source.incarnation),
			live
		);
		const row = await this.database
			.select({ digest: table.digest })
			.from(table)
			.where(current)
			.get();
		return row !== undefined;
	}

	private toParent(
		row: typeof schema.listingAdoptionParent.$inferSelect
	): ListingAdoptionParent {
		return listingAdoptionParentSchema.parse({
			id: row.id,
			tenant: row.tenant,
			cache:
				row.cacheKind === 'default'
					? { kind: 'default' }
					: { kind: 'named', name: row.cacheName },
			cacheGeneration: row.cacheGeneration,
			storePathHash: row.storePathHash,
			generation: row.generation,
			narHash: row.narHash,
			updatedAt: row.updatedAt
		});
	}

	private async openParent(
		source: Extract<ListingAdoptionCaptureSource, { kind: 'parent' }>
	): Promise<ListingAdoptionExpansionOpenResult> {
		const result = await new ListingAdoptionParentStore(this.database).refresh({
			tenant: source.tenant,
			cache: source.cache,
			storePathHashes: [source.storePathHash]
		});
		if (result.kind === 'unavailable') {
			return result;
		}
		const parent = result.parents[0];
		if (parent === undefined) {
			return { kind: 'empty' };
		}
		const fact = schema.listingFact;
		const last = await this.database
			.select({ revision: fact.generatorRevision })
			.from(fact)
			.where(eq(fact.narHash, parent.narHash))
			.orderBy(desc(fact.generatorRevision))
			.limit(1)
			.get();
		if (last === undefined) {
			return { kind: 'empty' };
		}
		return {
			kind: 'window',
			window: listingAdoptionExpansionWindowSchema.parse({
				kind: 'parent',
				parent,
				through: last.revision
			})
		};
	}

	private async openListing(
		source: Extract<ListingAdoptionCaptureSource, { kind: 'listing' }>
	): Promise<ListingAdoptionExpansionOpenResult> {
		if (
			(await new ListingFactStore(this.database).find(source.identity)) ===
			undefined
		) {
			return { kind: 'empty' };
		}
		const table = schema.listingAdoptionParent;
		const last = await this.database
			.select({ id: table.id })
			.from(table)
			.where(eq(table.narHash, source.identity.narHash))
			.orderBy(desc(table.id))
			.limit(1)
			.get();
		if (last === undefined) {
			return { kind: 'empty' };
		}
		return {
			kind: 'window',
			window: listingAdoptionExpansionWindowSchema.parse({
				kind: 'listing',
				identity: source.identity,
				through: last.id
			})
		};
	}

	private async openCas(
		source: Extract<ListingAdoptionCaptureSource, { kind: 'cas' }>
	): Promise<ListingAdoptionExpansionOpenResult> {
		if (!(await this.currentCas(source))) {
			return { kind: 'empty' };
		}
		const fact = schema.listingAdoptionFact;
		const last = await this.database
			.select({
				narHash: fact.narHash,
				generatorRevision: fact.generatorRevision
			})
			.from(fact)
			.where(eq(fact.digest, source.digest))
			.orderBy(desc(fact.narHash), desc(fact.generatorRevision))
			.limit(1)
			.get();
		if (last === undefined) {
			return { kind: 'empty' };
		}
		return {
			kind: 'window',
			window: listingAdoptionExpansionWindowSchema.parse({
				kind: 'cas',
				digest: source.digest,
				incarnation: source.incarnation,
				through: last
			})
		};
	}

	private async parentPage(
		window: ParentWindow
	): Promise<ListingAdoptionExpansionPageResult> {
		if (!(await this.currentParent(window.parent))) {
			return { kind: 'obsolete' };
		}
		const fact = schema.listingFact;
		const lower =
			window.after === undefined
				? undefined
				: gt(fact.generatorRevision, window.after);
		const selected = and(
			eq(fact.narHash, window.parent.narHash),
			lower,
			lte(fact.generatorRevision, window.through)
		);
		const rows = await this.database
			.select({
				narHash: fact.narHash,
				generatorRevision: fact.generatorRevision
			})
			.from(fact)
			.where(selected)
			.orderBy(asc(fact.generatorRevision))
			.limit(pageSize + 1);
		const identities = rows
			.slice(0, pageSize)
			.map((row) => narListingIdentitySchema.parse(row));
		const isComplete = rows.length <= pageSize;
		const after = isComplete
			? window.through
			: identities.at(-1)?.generatorRevision;
		return {
			kind: 'page',
			page: {
				kind: 'parent',
				window: { ...window, after },
				targets: identities.map((identity) => ({
					parent: window.parent,
					identity
				})),
				scanned: identities.length,
				isComplete
			}
		};
	}

	private async listingPage(
		window: ListingWindow
	): Promise<ListingAdoptionExpansionPageResult> {
		if (
			(await new ListingFactStore(this.database).find(window.identity)) ===
			undefined
		) {
			return { kind: 'obsolete' };
		}
		const table = schema.listingAdoptionParent;
		const lower =
			window.after === undefined ? undefined : gt(table.id, window.after);
		const selected = and(
			eq(table.narHash, window.identity.narHash),
			lower,
			lte(table.id, window.through)
		);
		const rows = await this.database
			.select()
			.from(table)
			.where(selected)
			.orderBy(asc(table.id))
			.limit(pageSize + 1);
		const parents = rows.slice(0, pageSize).map((row) => this.toParent(row));
		const isComplete = rows.length <= pageSize;
		const after = isComplete ? window.through : parents.at(-1)?.id;
		return {
			kind: 'page',
			page: {
				kind: 'listing',
				window: { ...window, after },
				targets: parents.map((parent) => ({
					parent,
					identity: window.identity
				})),
				scanned: parents.length,
				isComplete
			}
		};
	}

	private async casPage(
		window: CasWindow
	): Promise<ListingAdoptionExpansionPageResult> {
		if (!(await this.currentCas(window))) {
			return { kind: 'obsolete' };
		}
		const fact = schema.listingAdoptionFact;
		const lower =
			window.after === undefined
				? undefined
				: sql`(${fact.narHash},${fact.generatorRevision}) > (${window.after.narHash},${window.after.generatorRevision})`;
		const upper = sql`(${fact.narHash},${fact.generatorRevision}) <= (${window.through.narHash},${window.through.generatorRevision})`;
		const selected = and(eq(fact.digest, window.digest), lower, upper);
		const rows = await this.database
			.select({
				narHash: fact.narHash,
				generatorRevision: fact.generatorRevision
			})
			.from(fact)
			.where(selected)
			.orderBy(asc(fact.narHash), asc(fact.generatorRevision))
			.limit(pageSize + 1);
		const identities: readonly NarListingIdentity[] = rows
			.slice(0, pageSize)
			.map((row) => narListingIdentitySchema.parse(row));
		const isComplete = rows.length <= pageSize;
		const after = isComplete ? window.through : identities.at(-1);
		return {
			kind: 'page',
			page: {
				kind: 'cas',
				window: { ...window, after },
				identities,
				scanned: identities.length,
				isComplete
			}
		};
	}

	async open(
		input: ListingAdoptionCaptureSource
	): Promise<ListingAdoptionExpansionOpenResult> {
		const source = listingAdoptionCaptureSourceSchema.parse(input);
		return this.execute(async () => {
			if (!(await this.ready(source.kind))) {
				return { kind: 'unavailable' };
			}
			if (source.kind === 'parent') {
				return this.openParent(source);
			}
			if (source.kind === 'listing') {
				return this.openListing(source);
			}
			return this.openCas(source);
		});
	}

	async page(
		input: ListingAdoptionExpansionWindow
	): Promise<ListingAdoptionExpansionPageResult> {
		const window = listingAdoptionExpansionWindowSchema.parse(input);
		return this.execute(async () => {
			if (!(await this.ready(window.kind))) {
				return { kind: 'unavailable' };
			}
			if (window.kind === 'parent') {
				return this.parentPage(window);
			}
			if (window.kind === 'listing') {
				return this.listingPage(window);
			}
			return this.casPage(window);
		});
	}
}
