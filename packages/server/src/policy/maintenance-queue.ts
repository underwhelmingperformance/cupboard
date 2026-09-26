// How long a failed maintenance message waits before the queue delivers it
// again.
export const maintenanceQueueRetryDelaySeconds = 60;

// The maintenance consumer's `max_retries` in wrangler.jsonc. A message that
// fails this many redeliveries moves to the dead-letter queue.
export const maintenanceQueueMaxRetries = 3;

// Cloudflare ends a queue consumer invocation after 15 minutes of wall time,
// so no delivery of a maintenance message runs for longer.
// https://developers.cloudflare.com/queues/platform/limits/
export const queueConsumerWallClockMs = 15 * 60 * 1000;
