import { DurableObject } from 'cloudflare:workers';

/**
 * Cloudflare refuses rollback across a Durable Object class lifecycle change.
 * Both Workers export this class without a binding so the control database
 * cutover cannot restore legacy authority through a dashboard rollback.
 */
export class ControlDatabaseRollbackGuard extends DurableObject<unknown> {}
