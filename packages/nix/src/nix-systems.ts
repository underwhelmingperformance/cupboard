import { z } from 'zod';

import systems from './nix-systems.json' with { type: 'json' };

const nixArchitectureSchema = z.enum(['x86_64', 'aarch64']);
const nixOperatingSystemSchema = z.enum(['linux', 'darwin']);

export const nixSystemSchema = z.templateLiteral([
	nixArchitectureSchema,
	'-',
	nixOperatingSystemSchema
]);

export type NixSystem = z.infer<typeof nixSystemSchema>;

export const nixSystems: readonly NixSystem[] = z
	.array(nixSystemSchema)
	.parse(systems);
