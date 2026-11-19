import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import { StatusCodes } from 'http-status-codes';

import {
	buildInputsClearBodySchema,
	buildInputsClearResponseSchema,
	buildInputsPageLimitErrorCode,
	buildInputsPageLimitErrorDataSchema,
	buildInputsReadResponseSchema,
	buildInputsRecordBodySchema,
	buildInputsRecordResponseSchema
} from '../build-inputs.ts';

import {
	cacheScopedProcedure,
	writableCacheScopedProcedure
} from './cache-scoped.ts';

const pageLimitError = {
	[buildInputsPageLimitErrorCode]: {
		status: StatusCodes.REQUEST_TOO_LONG,
		data: buildInputsPageLimitErrorDataSchema
	}
};

const record = writableCacheScopedProcedure(
	{
		method: 'POST',
		suffix: '/build-inputs',
		requires: 'build-inputs:record',
		replaySafety: 'replay-safe',
		workBound: 'size'
	},
	buildInputsRecordBodySchema.shape,
	buildInputsRecordResponseSchema
);

export const buildInputsContract = {
	// Add build inputs to narinfo rows that the cache already has. The token
	// must grant `build-inputs:record` for the cache, because the build inputs
	// of a row decide which other paths collection keeps. A page has at most
	// `buildInputsRecordMaxEntries` entries and
	// `buildInputsRecordMaxBuildInputs` build inputs.
	record: {
		inDefaultCache: record.inDefaultCache.errors(pageLimitError),
		inNamedCache: record.inNamedCache.errors(pageLimitError)
	},

	// Read the build inputs and their version from one path's row. Build inputs
	// list store paths of the cache, as a narinfo's references do, so reading
	// them needs the grant that reads the cache's content.
	read: cacheScopedProcedure(
		{
			method: 'GET',
			suffix: '/build-inputs/{hash}',
			requires: 'cache:content-read',
			replaySafety: 'replay-safe',
			workBound: 'time'
		},
		{ hash: storePathHashSchema },
		buildInputsReadResponseSchema
	),

	// Clear the build inputs and their version from the rows of up to
	// `buildInputsClearMaxPaths` paths. Clearing build inputs can leave paths
	// that nothing keeps, so it needs the same `narinfo:delete` grant as
	// deleting a path, and a clear that changes a row makes a collection scan of
	// the cache due.
	clear: cacheScopedProcedure(
		{
			method: 'POST',
			suffix: '/build-inputs/clear',
			requires: 'narinfo:delete',
			maintenance: 'when-changed',
			replaySafety: 'replay-safe',
			workBound: 'time'
		},
		buildInputsClearBodySchema.shape,
		buildInputsClearResponseSchema
	)
};
