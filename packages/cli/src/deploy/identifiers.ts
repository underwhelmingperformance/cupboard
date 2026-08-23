import { z } from 'zod';

// The deploy pipeline passes Cloudflare identifiers between CLI flags, the
// Wrangler config and the Cloudflare API. A separate brand prevents an account
// id, script name, database id, KV namespace id, zone id or queue id from being
// passed in place of another. These are
// CLI-internal identifiers, so they brand their string without narrowing it
// further.

export const cloudflareAccountIdSchema = z
	.string()
	.brand('CloudflareAccountId');
export type CloudflareAccountId = z.infer<typeof cloudflareAccountIdSchema>;

export const scriptNameSchema = z.string().brand('ScriptName');
export type ScriptName = z.infer<typeof scriptNameSchema>;

export const databaseIdSchema = z.string().brand('DatabaseId');
export type DatabaseId = z.infer<typeof databaseIdSchema>;

export const kvNamespaceIdSchema = z.string().brand('KvNamespaceId');
export type KvNamespaceId = z.infer<typeof kvNamespaceIdSchema>;

export const zoneIdSchema = z.string().brand('ZoneId');
export type ZoneId = z.infer<typeof zoneIdSchema>;

export const queueIdSchema = z.string().brand('QueueId');
export type QueueId = z.infer<typeof queueIdSchema>;
