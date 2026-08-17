import { z } from 'zod';

import systems from './nix-systems.json' with { type: 'json' };

const nixArchitectureSchema = z.enum(['x86_64', 'aarch64']);
const nixOperatingSystemSchema = z.enum(['linux', 'darwin']);

/**
A Nix system supported by Cupboard's flake and generated settings tables.
*/
export const nixSystemSchema = z.templateLiteral([
	nixArchitectureSchema,
	'-',
	nixOperatingSystemSchema
]);

export type NixSystem = z.infer<typeof nixSystemSchema>;

/**
The supported Nix systems, in the order used for generated outputs.
*/
export const nixSystems: readonly NixSystem[] = z
	.array(nixSystemSchema)
	.parse(systems);
