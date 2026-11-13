import { type Context } from 'hono';

import { withinReadDeadline, withoutForwardDeadline } from '../do/deadline.ts';

import { type WorkerHonoEnv } from './hono-env.ts';

/**
How long a forwarded read waits for the tenant object's response headers.
`admission-budget`: what admission left of the 20-second read budget, so
admission, the check of a read token and the forwarded read together end
before the CLI's attempt. Choose it only when the capped worst case of the
object's work fits within that budget. `none`: no deadline, for a read whose
work grows with the request or whose capped worst case exceeds the budget.
*/
export type ReadDeadline = 'admission-budget' | 'none';

/**
Runs `send`, which forwards a replay-safe read to the tenant Durable Object,
with the deadline that `deadline` chooses.
*/
export function forwardRead<T>(
	context: Context<WorkerHonoEnv>,
	deadline: ReadDeadline,
	send: () => Promise<T>
): Promise<T> {
	return deadline === 'admission-budget'
		? withinReadDeadline(context.get('admissionDeadline'), send)
		: withoutForwardDeadline(send);
}
