import { oc } from '@orpc/contract';

/**
 * The declaration each admin procedure carries once, in the contract: the
 * token scope it requires and whether it mutates state behind the
 * maintenance-eligibility bookkeeping. The server's middleware reads these;
 * neither side repeats them.
 */
export interface AdminMeta {
	readonly scope: 'admin' | 'write';
	readonly maintenance?: boolean;
}

/**
 * The base every admin procedure builds on: requires the admin scope unless a
 * procedure overrides its meta, and declares the auth failures every
 * authenticated procedure can answer.
 */
export const adminProcedure = oc.$meta<AdminMeta>({ scope: 'admin' }).errors({
	UNAUTHORIZED: {},
	FORBIDDEN: {}
});
