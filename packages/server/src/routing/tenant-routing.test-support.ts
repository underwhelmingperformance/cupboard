import { tenantIdSchema } from '@cupboard/nix-store/scalars';

export const fixtureTenant = tenantIdSchema.parse('v1');
