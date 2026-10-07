import { z } from 'zod';

import {
	refreshSessionIdSchema,
	refreshSessionListResponseSchema,
	refreshSessionRevokeResponseSchema
} from '../sessions.ts';

import { baseProcedure } from './base.ts';

export const sessionsContract = {
	list: baseProcedure
		.meta({ requires: 'session:list', replaySafety: 'replay-safe' })
		.route({ method: 'GET', path: '/sessions' })
		.output(refreshSessionListResponseSchema),

	revoke: baseProcedure
		.meta({ requires: 'session:revoke' })
		.route({ method: 'DELETE', path: '/sessions/{id}' })
		.input(z.strictObject({ id: refreshSessionIdSchema }))
		.output(refreshSessionRevokeResponseSchema)
};
