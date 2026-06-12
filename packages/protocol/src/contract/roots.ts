import { cacheSelectorSchema, rootNameSchema } from '@cupboard/nix/scalars';
import { z } from 'zod';

import {
	rootListResponseSchema,
	rootRemoveResponseSchema,
	rootSetBodySchema,
	rootSetResponseSchema
} from '../retention.ts';

import { adminProcedure } from './base.ts';

export const rootsContract = {
	list: adminProcedure
		.route({ method: 'GET', path: '/cache/{cacheName}/roots' })
		.input(z.strictObject({ cacheName: cacheSelectorSchema }))
		.output(rootListResponseSchema),

	// CI sets roots with a write token bound to the root names its grant
	// permits, so this is the one write-scoped procedure whose handler reads
	// the verified claims.
	set: adminProcedure
		.meta({ scope: 'write', maintenance: true })
		.route({ method: 'PUT', path: '/cache/{cacheName}/roots/{name}' })
		.input(
			z.strictObject({
				cacheName: cacheSelectorSchema,
				name: rootNameSchema,
				...rootSetBodySchema.shape
			})
		)
		.output(rootSetResponseSchema),

	remove: adminProcedure
		.meta({ scope: 'admin', maintenance: true })
		.route({ method: 'DELETE', path: '/cache/{cacheName}/roots/{name}' })
		.input(
			z.strictObject({ cacheName: cacheSelectorSchema, name: rootNameSchema })
		)
		.output(rootRemoveResponseSchema)
};
