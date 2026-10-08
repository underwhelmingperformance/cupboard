import { type Context, type Next } from 'hono';

import { TokenRateLimitedError } from '../errors.ts';

import { type WorkerHonoEnv } from './hono-env.ts';

/**
 * The surface of a token, signup or revocation request. Each surface has its
 * own budget for each client.
 */
export type TokenRequestSurface =
	| { readonly kind: 'control' }
	| { readonly kind: 'tenant'; readonly tenant: string };

const ipv6PrefixGroups = 4;
const ipv4MappedPrefix = [0, 0, 0, 0, 0, 0xff_ff] as const;

// An IPv6 client usually controls at least a /64. Keying by the full address
// could give that client 2^64 budgets.
function rateLimitClient(address: string): string {
	const groups = ipv6Groups(address);

	if (groups === undefined) {
		return address;
	}

	if (ipv4MappedPrefix.every((group, index) => groups[index] === group)) {
		const [high = 0, low = 0] = groups.slice(6);

		return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
	}

	const prefix = groups
		.slice(0, ipv6PrefixGroups)
		.map((group) => group.toString(16))
		.join(':');

	return `${prefix}::/64`;
}

// URL parsing validates an IPv6 address and serialises it in its compressed
// form, with hexadecimal groups only. Expand that form to eight groups.
function ipv6Groups(address: string): readonly number[] | undefined {
	let hostname: string;

	try {
		hostname = new URL(`http://[${address}]/`).hostname;
	} catch {
		return undefined;
	}

	const [head = '', tail] = hostname.slice(1, -1).split('::', 2);
	const leading = head === '' ? [] : head.split(':');
	const trailing = tail === undefined || tail === '' ? [] : tail.split(':');
	const elided = tail === undefined ? 0 : 8 - leading.length - trailing.length;

	return [
		...leading,
		...Array.from({ length: elided }, () => '0'),
		...trailing
	].map((group) => Number.parseInt(group, 16));
}

/**
 * Refuses the request when its client has spent the budget for its surface.
 * The request body is not read.
 */
export async function limitTokenRequests(
	context: Context<WorkerHonoEnv>,
	surface: TokenRequestSurface,
	next: Next
): Promise<void> {
	const address = context.req.header('cf-connecting-ip');
	const { success } = await context.env.TOKEN_RATE_LIMITER.limit({
		key: JSON.stringify({
			...surface,
			address: address === undefined ? undefined : rateLimitClient(address)
		})
	});

	if (!success) {
		throw new TokenRateLimitedError();
	}

	await next();
}
