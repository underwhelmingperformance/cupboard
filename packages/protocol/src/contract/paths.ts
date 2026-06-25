import {
	cacheSelectorSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { pathDeletionResponseSchema } from '../upload.ts';

import { baseProcedure } from './base.ts';

export const pathsContract = {
	remove: baseProcedure
		.meta({
			requires: 'narinfo:delete',
			resource: { cache: { field: 'cacheName' } },
			maintenance: true
		})
		.route({ method: 'DELETE', path: '/cache/{cacheName}/paths/{hash}' })
		.input(
			z.strictObject({
				cacheName: cacheSelectorSchema,
				hash: storePathHashSchema
			})
		)
		.output(pathDeletionResponseSchema)
};
