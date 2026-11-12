import { afterPendingCallbacks } from '@cupboard/shared/keep-alive-fetch';
import { fetch as undiciFetch } from 'undici';

/**
The `undici` package's `fetch` with the connection reuse of
`keepAliveFetch`. The substituter client uses the package's own `fetch`
because a proxy dispatcher has to come from the same package version.
*/
export const keepAliveUndiciFetch: typeof undiciFetch =
	afterPendingCallbacks(undiciFetch);
