import { controlContract } from '@cupboard/protocol/contract';
import { implement } from '@orpc/server';

import {
	controlCheck,
	controlKeyRetire,
	controlKeyRotate,
	controlKeys,
	controlTenantClearReadCredential,
	controlTenantCreate,
	controlTenantList,
	controlTenantOffboard,
	controlTenantResume,
	controlTenantRotateReadCredential,
	controlTenantSetReadMode,
	controlTenantSuspend,
	requireControlAdmin
} from '../control/control-plane.ts';

import { bridgedError } from './error-bridge.ts';

/** What a control procedure needs: the request (for auth and the public origin) and the Worker env. */
export interface ControlOrpcContext {
	readonly request: Request;
	readonly env: Env;
}

// Every control procedure runs behind the error bridge and the control-admin
// gate; only a control-issued admin token reaches a handler.
const os = implement(controlContract)
	.$context<ControlOrpcContext>()
	.use(async ({ next }) => {
		try {
			return await next();
		} catch (error) {
			throw bridgedError(error);
		}
	})
	.use(async ({ context, next }) => {
		await requireControlAdmin(context.request, context.env);

		return next();
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
	}
});
