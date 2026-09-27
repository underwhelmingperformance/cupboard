import { readUserInputSchema } from '@cupboard/shared/http';

export const readTokenBasicUser = readUserInputSchema.parse('cupboard-oidc');
export const readTokenPasswordPrefix = 'cupboard-access+jwt:';
