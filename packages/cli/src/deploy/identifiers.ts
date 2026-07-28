import { z } from 'zod';

// The Cloudflare identifiers the deploy pipeline threads between the CLI flags,
// the wrangler config and the Cloudflare API. Each carries its own brand so an
// account id, a script name, a database id, a KV namespace id, a zone id and a
// queue id cannot stand in for one another at a call site. They are
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
