import { tenantIdSchema } from '@cupboard/nix/scalars';

export const fixtureTenant = tenantIdSchema.parse('v1');
