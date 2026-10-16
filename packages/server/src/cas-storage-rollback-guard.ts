import { DurableObject } from 'cloudflare:workers';

/**
 * Cloudflare forbids rollback across a Durable Object class lifecycle change.
 * Both Workers export this unbound class because earlier CAS writers cannot
 * write the contracted storage interface. No binding can create an instance.
 */
export class CasStorageRollbackGuard extends DurableObject<unknown> {}
