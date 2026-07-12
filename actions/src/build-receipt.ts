import { z } from 'zod';

const buildSubjectSchema = z.object({
	storePath: z.string().min(1),
	narHash: z.string().regex(/^[a-f\d]{64}$/u),
	derivation: z.string().endsWith('.drv'),
	attempt: z.number().int().positive(),
	attemptId: z.string().min(1)
});

export const buildReceiptSchema = z.object({
	version: z.literal(1),
	paths: z.array(z.string().min(1)),
	subjects: z.array(buildSubjectSchema)
});

export type BuildReceipt = z.infer<typeof buildReceiptSchema>;
