import { z } from 'zod';

import {
	refreshSessionIdSchema,
	tenantSessionListResponseSchema,
	tenantSessionRevokeResponseSchema
} from '../sessions.ts';

import { baseProcedure } from './base.ts';

export const sessionsContract = {
	list: baseProcedure
		.meta({
			requires: 'session:list',
			replaySafety: 'replay-safe',
			workBound: 'size'
		})
		.route({ method: 'GET', path: '/sessions' })
		.output(tenantSessionListResponseSchema),

	revoke: baseProcedure
		.meta({ requires: 'session:revoke', workBound: 'time' })
		.route({ method: 'DELETE', path: '/sessions/{id}' })
		.input(z.strictObject({ id: refreshSessionIdSchema }))
		.output(tenantSessionRevokeResponseSchema)
};
