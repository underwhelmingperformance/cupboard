import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';

// Node tries each resolved address in turn. By default it moves on to the next
// address after 250 ms, and only the last attempt can wait longer. A lost SYN
// is retransmitted after about one second. On a host without IPv6, every IPv6
// attempt fails at once, so a single lost packet fails the connection long
// before undici's 10-second connect timeout. 2.5 seconds covers one
// retransmission, and two IPv4 and two IPv6 addresses still each get an
// attempt within that timeout. The cost: on a host whose IPv6 route drops
// packets, each new connection waits up to 2.5 seconds before it tries IPv4,
// and only the first four addresses get an attempt within the timeout.
// https://github.com/nodejs/node/issues/54359
const connectionAttemptTimeoutMs = 2500;

/**
Sets the time that each address gets before Node tries the next one, for
every connection that the process opens afterwards, including the
connections of `fetch`, undici and `ws`.
*/
export function configureConnectionAttempts(): void {
	setDefaultAutoSelectFamilyAttemptTimeout(connectionAttemptTimeoutMs);
}
