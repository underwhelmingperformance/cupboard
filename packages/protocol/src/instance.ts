import { z } from 'zod';

export const instanceNameSchema = z
	.string()
	.regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
	.brand('InstanceName');
export type InstanceName = z.output<typeof instanceNameSchema>;

export const configuredInstanceSummarySchema = z.strictObject({
	state: z.literal('configured'),
	name: instanceNameSchema
});
export type ParsedConfiguredInstanceSummary = z.output<
	typeof configuredInstanceSummarySchema
>;
export type ConfiguredInstanceSummary = z.input<
	typeof configuredInstanceSummarySchema
>;

export const instanceSummarySchema = z.discriminatedUnion('state', [
	z.strictObject({ state: z.literal('unconfigured') }),
	configuredInstanceSummarySchema
]);
export type ParsedInstanceSummary = z.output<typeof instanceSummarySchema>;
export type InstanceSummary = z.input<typeof instanceSummarySchema>;

export const instanceInitialiseBodySchema = z.strictObject({
	name: instanceNameSchema
});
export type InstanceInitialiseBody = z.input<
	typeof instanceInitialiseBodySchema
>;
