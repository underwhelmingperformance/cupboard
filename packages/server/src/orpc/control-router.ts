import { controlContract } from '@cupboard/protocol/contract';
import { implement } from '@orpc/server';

import {
	controlAuthenticate,
	controlCheck,
	controlKeyRetire,
	controlKeyRotate,
	controlKeys,
	controlMembershipRebuild,
	controlOidcTrustAdd,
	controlOidcTrustGet,
	controlOidcTrustList,
	controlOidcTrustRemove,
	controlTenantClearReadCredential,
	controlTenantCreate,
	controlTenantList,
	controlTenantOffboard,
	controlTenantResume,
	controlTenantRotateReadCredential,
	controlTenantSetReadMode,
	controlTenantSuspend
} from '../control/control-plane.ts';

import { authoriseRequest } from './authorise.ts';
import { bridgedError } from './error-bridge.ts';

// The control plane has no pending-upload rows; resource resolution never needs
// a pending-cache lookup, so the resolver always reports absence.
const noPendingCache = (): Promise<string | undefined> =>
	Promise.resolve(undefined);

/** What a control procedure needs: the request (for auth and the public origin) and the Worker env. */
export interface ControlOrpcContext {
	readonly request: Request;
	readonly env: Env;
}

// Every control procedure runs behind the error bridge and the grant authoriser:
// a control-issued token is verified, then the operation the procedure declares
// is checked against the grants it carries before any handler runs.
const os = implement(controlContract)
	.$context<ControlOrpcContext>()
	.use(async ({ next }) => {
		try {
			return await next();
		} catch (error) {
			throw bridgedError(error);
		}
	})
	.use(async ({ context, procedure, next }, input) => {
		const claims = await controlAuthenticate(context.request, context.env);

		await authoriseRequest(
			claims,
			procedure['~orpc'].meta,
			input,
			noPendingCache
		);

		return next({ context: { claims } });
	});

export const controlRouter = os.router({
	check: os.check.handler(({ context }) => controlCheck(context.env)),
	keys: {
		list: os.keys.list.handler(({ context }) => controlKeys(context.env)),
		rotate: os.keys.rotate.handler(({ context }) =>
			controlKeyRotate(context.env)
		),
		retire: os.keys.retire.handler(({ input, context }) =>
			controlKeyRetire(context.env, input.kid)
		)
	},
	tenants: {
		list: os.tenants.list.handler(({ context }) =>
			controlTenantList(context.env)
		),
		create: os.tenants.create.handler(({ input, context }) =>
			controlTenantCreate(
				context.env,
				input,
				new URL(context.request.url).origin
			)
		),
		suspend: os.tenants.suspend.handler(({ input, context }) =>
			controlTenantSuspend(context.env, input.id)
		),
		resume: os.tenants.resume.handler(({ input, context }) =>
			controlTenantResume(context.env, input.id)
		),
		setReadMode: os.tenants.setReadMode.handler(({ input, context }) =>
			controlTenantSetReadMode(context.env, input.id, input.readMode)
		),
		rotateReadCredential: os.tenants.rotateReadCredential.handler(
			({ input, context }) =>
				controlTenantRotateReadCredential(context.env, input.id, input.read)
		),
		clearReadCredential: os.tenants.clearReadCredential.handler(
			({ input, context }) =>
				controlTenantClearReadCredential(context.env, input.id)
		),
		remove: os.tenants.remove.handler(({ input, context }) =>
			controlTenantOffboard(context.env, input.id)
		)
	},
	membership: {
		rebuild: os.membership.rebuild.handler(({ context }) =>
			controlMembershipRebuild(context.env)
		)
	},
	oidcTrust: {
		list: os.oidcTrust.list.handler(({ context }) =>
			controlOidcTrustList(context.env)
		),
		get: os.oidcTrust.get.handler(({ input, context }) =>
			controlOidcTrustGet(context.env, input.id)
		),
		add: os.oidcTrust.add.handler(({ input, context }) =>
			controlOidcTrustAdd(context.env, input)
		),
		remove: os.oidcTrust.remove.handler(({ input, context }) =>
			controlOidcTrustRemove(context.env, input.id)
		)
	}
});
