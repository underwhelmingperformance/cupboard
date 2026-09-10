import { z } from 'zod';

export const rootRetentionRuleSetIdSchema = z
	.number()
	.int()
	.positive()
	.max(Number.MAX_SAFE_INTEGER)
	.brand('RootRetentionRuleSetId');
export type RootRetentionRuleSetId = z.infer<
	typeof rootRetentionRuleSetIdSchema
>;

export const emptyRootRetentionRuleSetId =
	rootRetentionRuleSetIdSchema.parse(1);
