import { z } from 'zod';

// The requests that the test harnesses send to the bindings Worker, and its
// responses. Both sides import these schemas.

const testDatabaseSchema = z.enum(['CUPBOARD_DB', 'CONTROL_DB']);

export type TestDatabase = z.infer<typeof testDatabaseSchema>;

// JSON has no byte strings, so a BLOB parameter is sent as its byte values.
// D1 returns a BLOB column as the same array of byte values, which JSON keeps.
const d1BytesSchema = z.strictObject({
	bytes: z.array(z.number().int().min(0).max(255))
});

const d1ValueSchema = z.union([
	z.string(),
	z.number(),
	z.null(),
	d1BytesSchema
]);

export const boundStatementSchema = z.strictObject({
	sql: z.string(),
	params: z.array(d1ValueSchema)
});

export const statementsRequestSchema = z.strictObject({
	database: testDatabaseSchema,
	statements: z.array(boundStatementSchema)
});

export const queryRequestSchema = z.strictObject({
	database: testDatabaseSchema,
	statement: boundStatementSchema
});

const rowSchema = z.record(z.string(), z.unknown());

export const queryResponseSchema = z.strictObject({
	results: z.array(rowSchema)
});

export const firstRowResponseSchema = z.strictObject({
	row: rowSchema.nullable()
});

// The body of an object write is the object's bytes, so the key and options are
// sent in this header. A header value can contain only Latin-1 characters, so
// the JSON is percent-encoded with `encodeURIComponent`.
export const objectPutHeader = 'x-cupboard-test-object';

export const objectPutSchema = z.strictObject({
	key: z.string(),
	sha256: z.string().optional(),
	contentType: z.string().optional(),
	customMetadata: z.record(z.string(), z.string()).optional()
});

export const objectHeadRequestSchema = z.strictObject({ key: z.string() });

const objectMetadataSchema = z.strictObject({
	contentType: z.string().optional(),
	customMetadata: z.record(z.string(), z.string())
});

export const objectHeadResponseSchema = z.strictObject({
	object: objectMetadataSchema.nullable()
});

export const kvPutRequestSchema = z.strictObject({
	key: z.string(),
	value: z.string()
});

export const manualAlarmRequestSchema = z.strictObject({
	name: z.string(),
	method: z.enum([
		'beginManualAlarms',
		'runAlarmPass',
		'endManualAlarms',
		'isManualAlarmFenceOpen'
	])
});

export type ManualAlarmMethod = z.infer<
	typeof manualAlarmRequestSchema
>['method'];

export const manualAlarmResponseSchema = z.strictObject({
	value: z.boolean()
});
