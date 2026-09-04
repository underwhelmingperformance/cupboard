import { storePathHashSchema } from '@cupboard/nix-store/scalars';

import { pathDeletionResponseSchema } from '../upload.ts';

import { cacheScopedProcedure } from './cache-scoped.ts';

export const pathsContract = {
	remove: cacheScopedProcedure(
		{
			method: 'DELETE',
			suffix: '/paths/{hash}',
			requires: 'narinfo:delete',
			maintenance: true
		},
		{ hash: storePathHashSchema },
		pathDeletionResponseSchema
	)
};
