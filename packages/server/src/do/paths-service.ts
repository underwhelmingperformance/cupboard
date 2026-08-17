import {
	referencesSchema,
	type StoredCache,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { type PathInspection } from '@cupboard/protocol/paths';
import { and, eq } from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import {
	StoredReferencesInvalidError,
	StorePathNotFoundError
} from '../errors.ts';
import { parseStored } from '../http/parse.ts';
import { parseStoredS3Committer } from '../s3/upload-origin.ts';

import { type ServerContext } from './context.ts';

export class PathsService {
	constructor(private readonly context: ServerContext) {}

	inspect(
		cache: StoredCache,
		hash: StorePathHash,
		canSeeOrigin: boolean
	): PathInspection {
		const row = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cache, cache),
					eq(schema.narInfos.storePathHash, hash)
				)
			)
			.get();

		if (row === undefined) {
			throw new StorePathNotFoundError(hash);
		}

		const origin: PathInspection['origin'] =
			row.origin === null
				? { kind: 'native' }
				: canSeeOrigin
					? {
							kind: 's3',
							...parseStoredS3Committer(row.storePathHash, row.origin)
						}
					: { kind: 'redacted' };

		return {
			cache: row.cache,
			storePathHash: row.storePathHash,
			storePath: row.storePath,
			narHash: row.narHash,
			narSize: row.narSize,
			references: parseStored(
				referencesSchema,
				row.referencesJson,
				(cause) => new StoredReferencesInvalidError(row.storePathHash, cause)
			),
			deriver: row.deriver ?? undefined,
			ca: row.ca ?? undefined,
			generation: row.generation,
			createdAt: row.createdAt,
			origin
		};
	}
}
