/**
 * Platform figures the request caps in this package are sized against.
 *
 * A cap that keeps one invocation's work under a runtime ceiling is only as
 * good as the ceiling it was written for, so the figure belongs in one place
 * that both the caps and the Worker configuration can be checked against.
 */

/**
 * The subrequests one invocation may make: every R2 call, every D1 call and
 * every call to another Worker.
 *
 * Both Worker configurations pin `limits.subrequests` to this figure. The
 * platform default has changed before, and a configuration that inherits the
 * default records nothing about the ceiling the caps in this package are
 * sized against.
 *
 * `scripts/subrequest-budget.test.ts` holds the pins and this constant equal.
 * `packages/server/src/do/subrequest-budget.test.ts` checks each capped
 * request's fan-out against it. Neither test is the runtime: a `limits`
 * block takes effect only on deployment, and the local pool enforces no
 * subrequest ceiling.
 */
export const subrequestsPerInvocation = 10_000;

/**
 * The D1 statements one invocation may run, counting each statement of a batch,
 * on each Workers plan. Cloudflare's D1 limits table gives these as "Queries per
 * Worker invocation".
 *
 * Unlike `subrequestsPerInvocation` this figure is not configurable. The plan
 * decides it, so a deployment supplies the figure its own plan allows and the
 * caps sized against it are functions of that value. A deployment that supplies
 * nothing gets the free figure: a pass that exhausts its allowance defers the
 * rest of its work and resumes, whereas a pass that assumes more than the plan
 * allows fails a statement at runtime.
 */
export const freeTierD1StatementsPerInvocation = 50;
export const paidTierD1StatementsPerInvocation = 1000;
