import { z } from 'zod';

// The Workers runtime can mark a fault through any of these fields.
const runtimeFaultFlagsSchema = z.object({
	retryable: z.boolean().optional(),
	durableObjectReset: z.boolean().optional(),
	overloaded: z.boolean().optional()
});

type RuntimeFaultFlags = z.infer<typeof runtimeFaultFlagsSchema>;

function runtimeFaultFlags(error: unknown): RuntimeFaultFlags | undefined {
	if (!(error instanceof Error)) {
		return undefined;
	}

	const flags = runtimeFaultFlagsSchema.safeParse(error);

	return flags.success ? flags.data : undefined;
}

/**
Whether the runtime marks `error` as a transient runtime fault: a retryable
fault, a Durable Object reset or an overload.
*/
export function isRuntimeRetryable(error: unknown): boolean {
	const flags = runtimeFaultFlags(error);

	return (
		flags?.retryable === true ||
		flags?.durableObjectReset === true ||
		flags?.overloaded === true
	);
}

/**
Whether the runtime marks `error` as an overload of the Durable Object.
*/
export function isDurableObjectOverloaded(error: unknown): boolean {
	return runtimeFaultFlags(error)?.overloaded === true;
}

/**
Whether the consumer can repeat an idempotent Durable Object call after
`error`.

Cloudflare's error-handling guide says that an error with `retryable` set
can be retried when the request is idempotent, and that an error with
`overloaded` set should not be retried, because retrying worsens the
overload. Workers can set both on one error.

The guide does not mention `durableObjectReset`. Workers sets it separately
from `retryable`, so a reset can arrive without `retryable`. The troubleshooting
guide says that a reset discards only in-memory state. The calls that use this
function are idempotent, so they also repeat a call after a reset that is not
an overload.

See https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
and https://developers.cloudflare.com/durable-objects/observability/troubleshooting/.
*/
export function isDurableObjectCallRetryable(error: unknown): boolean {
	const flags = runtimeFaultFlags(error);

	if (flags === undefined || flags.overloaded === true) {
		return false;
	}

	return flags.retryable === true || flags.durableObjectReset === true;
}
