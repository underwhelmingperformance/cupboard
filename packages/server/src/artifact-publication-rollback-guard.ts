import { DurableObject } from 'cloudflare:workers';

/**
 * Both Workers export this unbound class because earlier artifact publishers
 * and cleanup code cannot participate in the activated lifecycle. Cloudflare
 * refuses rollback across the class lifecycle change.
 */
export class ArtifactPublicationRollbackGuard extends DurableObject<unknown> {}
