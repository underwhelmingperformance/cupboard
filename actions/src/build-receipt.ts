import { sha256HexDigestSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

const buildSubjectSchema = z.object({
	storePath: z.string().min(1),
	narHash: sha256HexDigestSchema,
	derivation: z.string().endsWith('.drv'),
	attempt: z.number().int().positive(),
	attemptId: z.string().min(1)
});

export const buildReceiptSchema = z.object({
	version: z.literal(1),
	paths: z.array(z.string().min(1)),
	subjects: z.array(buildSubjectSchema)
});

// The unbranded construction shape: `build.ts` assembles receipts directly
// and never parses its own output. Reading a receipt back goes through
// `buildReceiptSchema.parse`, whose output carries the branded hash.
export type BuildReceipt = z.input<typeof buildReceiptSchema>;
