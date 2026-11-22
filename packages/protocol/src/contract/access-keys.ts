import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import {
	accessKeyCreateRequestSchema,
	accessKeyCreateResponseSchema,
	accessKeyDeleteResponseSchema,
	accessKeyIdSchema,
	accessKeyLimitErrorCode,
	accessKeyLimitErrorDataSchema,
	accessKeyListRequestSchema,
	accessKeyListResponseSchema,
	accessKeyRefusedErrorCode,
	accessKeyRefusedErrorDataSchema
} from '../access-keys.ts';

import { baseProcedure } from './base.ts';

/**
Create derives a key from the caller's authority, so it declares a
derivation. Delete and list act on stored keys, whose grants decide the
resources involved.
*/
export const accessKeysContract = {
	create: baseProcedure
		.meta({
			derives: { grantsIn: 'grants', expiresAtIn: 'expiresAt' },
			maintenance: true,
			workBound: 'time'
		})
		.route({ method: 'POST', path: '/access-keys' })
		.input(accessKeyCreateRequestSchema)
		.output(accessKeyCreateResponseSchema)
		.errors({
			[accessKeyRefusedErrorCode]: {
				status: StatusCodes.FORBIDDEN,
				data: accessKeyRefusedErrorDataSchema
			},
			[accessKeyLimitErrorCode]: {
				status: StatusCodes.CONFLICT,
				data: accessKeyLimitErrorDataSchema
			}
		}),

	list: baseProcedure
		.meta({
			requires: 'access-key:list',
			resource: { accessKey: { listed: true } },
			replaySafety: 'replay-safe',
			workBound: 'size'
		})
		.route({ method: 'GET', path: '/access-keys' })
		.input(accessKeyListRequestSchema.optional())
		.output(accessKeyListResponseSchema),

	delete: baseProcedure
		.meta({
			requires: 'access-key:delete',
			resource: { accessKey: { field: 'id', self: true } },
			workBound: 'time'
		})
		.route({ method: 'DELETE', path: '/access-keys/{id}' })
		.input(z.strictObject({ id: accessKeyIdSchema }))
		.output(accessKeyDeleteResponseSchema)
};
