import {
	cacheSelectorSchema,
	storePathHashSchema
} from '@cupboard/nix/scalars';
import { z } from 'zod';

import { deletePathResponseSchema } from '../upload.ts';

import { adminProcedure } from './base.ts';

export const pathsContract = {
	remove: adminProcedure
		.meta({ scope: 'admin', maintenance: true })
		.route({ method: 'DELETE', path: '/cache/{cacheName}/paths/{hash}' })
		.input(
			z.strictObject({
				cacheName: cacheSelectorSchema,
				hash: storePathHashSchema
			})
		)
		.output(deletePathResponseSchema)
};
