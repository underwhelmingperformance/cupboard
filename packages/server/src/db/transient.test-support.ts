/**
D1's documented overload message.
*/
export const d1QueueOverloadMessage =
	'D1_ERROR: D1 DB is overloaded. Too many requests queued.';

/**
D1's account-level throttle message. Cloudflare's D1 error list does not
document it.
*/
export const d1AccountThrottleMessage =
	'D1_ERROR: Your account is generating too much load on D1 DBs. Please back off and try again later.';
