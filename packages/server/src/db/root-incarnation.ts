import { z } from 'zod';

/**
The incarnation of a retention root: the set of target rows that the root
keeps. A replacement or a removal of the root releases its incarnation, and
the root's next targets belong to a new one. The values come from the
tenant's work sequence, so no two roots in a tenant share one.

A null incarnation belongs to a root that an earlier version of cupboard
wrote and that nothing has replaced since.
*/
export const rootIncarnationSchema = z
	.number()
	.int()
	.positive()
	.max(Number.MAX_SAFE_INTEGER)
	.brand('RootIncarnation');
export type RootIncarnation = z.infer<typeof rootIncarnationSchema>;
