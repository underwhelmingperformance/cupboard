import {
	referencesSchema,
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
import { parseUploadOrigin } from '../s3/upload-origin.ts';

import { type ServerContext } from './context.ts';

export class PathsService {
	constructor(private readonly context: ServerContext) {}

	inspect(
		cache: string,
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
			// The push origin names the credential that wrote the path; it is shown
			// only to a caller that may already enumerate credentials, not to a bare
			// read token.
			origin: canSeeOrigin
				? parseUploadOrigin(row.origin ?? undefined)
				: undefined
		};
	}
}
