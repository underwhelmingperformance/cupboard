import { StatusCodes } from 'http-status-codes';

import {
	buildInputsPageLimitErrorCode,
	buildInputsPageLimitErrorDataSchema,
	buildInputsRecordBodySchema,
	buildInputsRecordResponseSchema
} from '../build-inputs.ts';

import { writableCacheScopedProcedure } from './cache-scoped.ts';

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
	}
};
