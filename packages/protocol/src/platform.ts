/**
 * Platform figures the request caps in this package are sized against.
 *
 * Request caps use the Workers Free internal-service call allowance. Cloudflare
 * applies the ceiling for the account's plan when a Worker is deployed.
 */

/**
 * The internal-service calls one Workers Free invocation may make. The Paid
 * default is 10,000. The request caps use the Free figure for both plans.
 */
export const subrequestsPerInvocation = 1000;
