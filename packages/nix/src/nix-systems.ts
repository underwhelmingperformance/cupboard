import { z } from 'zod';

import configuredSystems from './nix-systems.json' with { type: 'json' };

const nixArchitectureSchema = z.enum(['x86_64', 'aarch64']);
const nixOperatingSystemSchema = z.enum(['linux', 'darwin']);

/**
 * A Nix system supported by Cupboard's flake and generated settings.
 */
export const nixSystemSchema = z.templateLiteral([
	nixArchitectureSchema,
	'-',
	nixOperatingSystemSchema
]);

export type NixSystem = z.infer<typeof nixSystemSchema>;

export const nixSystemRunnerSchema = z.strictObject({
	system: nixSystemSchema,
	runner: z.string().min(1)
});

export type NixSystemRunner = z.infer<typeof nixSystemRunnerSchema>;

/**
 * Maps each supported Nix system to the GitHub-hosted runner used for release
 * publication.
 */
export const nixSystemRunners: readonly NixSystemRunner[] = z
	.array(nixSystemRunnerSchema)
	.parse(configuredSystems);

/**
 * Lists supported Nix systems in output-generation order.
 */
export const nixSystems: readonly NixSystem[] = z
	.array(nixSystemSchema)
	.parse(nixSystemRunners.map(({ system }) => system));
