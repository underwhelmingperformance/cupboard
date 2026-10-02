import { DurableObject } from 'cloudflare:workers';

/**
 * Cloudflare forbids rollback across a Durable Object class lifecycle change.
 * Both Workers export this unbound class to prevent rollback across reference
 * revocation. No binding can create an instance of this class.
 */
export class PathReadAuthorityRollbackGuard extends DurableObject<unknown> {}
