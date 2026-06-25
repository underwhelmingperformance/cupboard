import {
	cacheSelectorSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { pathInspectionSchema } from '../paths.ts';
import { pathDeletionResponseSchema } from '../upload.ts';

import { baseProcedure } from './base.ts';

export const pathsContract = {
	inspect: baseProcedure
		.meta({
			requires: 'narinfo:read',
			resource: { cache: { field: 'cacheName' } }
		})
		.route({ method: 'GET', path: '/cache/{cacheName}/paths/{hash}' })
		.input(
			z.strictObject({
				cacheName: cacheSelectorSchema,
				hash: storePathHashSchema
			})
		)
		.output(pathInspectionSchema),

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
