// The `cupboard` control-plane Worker entrypoint. The tenant Durable Object lives
// in the separate `cupboard-tenant` script and is reached through a binding; this
// script serves the control surface and the tenant read/dispatch front.
export { default } from './routing/handler.ts';
