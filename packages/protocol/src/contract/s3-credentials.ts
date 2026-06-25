import { z } from 'zod';

import {
	s3CredentialCreateBodySchema,
	s3CredentialCreateResponseSchema,
	s3CredentialListResponseSchema,
	s3CredentialRevokeResponseSchema
} from '../s3-credentials.ts';

import { baseProcedure } from './base.ts';

export const s3CredentialsContract = {
	create: baseProcedure
		.meta({ requires: 's3-credential:create' })
		.route({ method: 'POST', path: '/s3-credentials' })
		.input(s3CredentialCreateBodySchema)
		.output(s3CredentialCreateResponseSchema),

	list: baseProcedure
		.meta({ requires: 's3-credential:list' })
		.route({ method: 'GET', path: '/s3-credentials' })
		.output(s3CredentialListResponseSchema),

	revoke: baseProcedure
		.meta({ requires: 's3-credential:delete' })
		.route({ method: 'DELETE', path: '/s3-credentials/{accessKeyId}' })
		.input(z.strictObject({ accessKeyId: z.string() }))
		.output(s3CredentialRevokeResponseSchema)
};
