import type { ArtifactTaskId } from '@cupboard/protocol/artifact-jobs';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { eq, inArray } from 'drizzle-orm';

import { ListingFactStore } from '../db/listing-facts.ts';
import * as schema from '../db/schema.ts';
import { casObjectKey } from '../http/http.ts';

import { maxOutgoingConnections } from './bulk.ts';
import type { ServerContext } from './context.ts';
import { jsonValueList } from './json-list.ts';

export class ListingReuseAdmissionService {
	constructor(private readonly context: ServerContext) {}

	async reusableInSection(
		ids: readonly ArtifactTaskId[]
	): Promise<ReadonlySet<ArtifactTaskId>> {
		if (ids.length === 0) {
			return new Set();
		}
		const rows = this.context.db
			.select({
				id: schema.artifactTasks.id,
				source: schema.artifactTasks.source,
				definition: schema.artifactJobs.definition
			})
			.from(schema.artifactTasks)
			.innerJoin(
				schema.artifactJobs,
				eq(schema.artifactJobs.id, schema.artifactTasks.jobId)
			)
			.where(inArray(schema.artifactTasks.id, jsonValueList(ids)))
			.all();
		const candidates = rows.flatMap((row) =>
			row.definition.kind === 'listing' && row.source.kind === 'nar'
				? [
						{
							id: row.id,
							narHash: row.source.narHash,
							generatorRevision: row.definition.generatorRevision
						}
					]
				: []
		);
		const stored = await new ListingFactStore(this.context.d1).findStored(
			candidates
		);
		const objects = new Map(
			stored.map(
				(entry) =>
					[casObjectKey(entry.fact.digest, entry.incarnation), entry] as const
			)
		);
		const present = await mapWithConcurrency(
			[...objects],
			maxOutgoingConnections,
			async ([key, entry]) => {
				const head = await this.context.env.BLOBS.head(key);
				return head?.size === entry.fact.size ? key : undefined;
			}
		);
		const keys = new Set(present);
		const reusable = stored.filter((entry) =>
			keys.has(casObjectKey(entry.fact.digest, entry.incarnation))
		);
		return new Set(
			candidates
				.filter((candidate) =>
					reusable.some(
						(entry) =>
							entry.fact.narHash === candidate.narHash &&
							entry.fact.generatorRevision === candidate.generatorRevision
					)
				)
				.map((candidate) => candidate.id)
		);
	}
}
