### Server telemetry on spans

The Workers record routine request and storage telemetry as span attributes
instead of log records, and no longer write Workers invocation logs. A saved
Workers Logs query, dashboard or alert that matches one of the removed records
stops matching after the upgrade. Query the spans instead:

| Removed record                                                | Now recorded as                                                                                                                                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invocation logs                                               | The invocation's root span, with `cloudflare.outcome`, `wall_time_ms`, `http.request.method`, `url.full`, `http.response.status_code` and `server.address`                               |
| `request started`, `request completed`                        | The `cupboard.request` span                                                                                                                                                              |
| `request finished`                                            | `cupboard.cost.*` attributes and `http.route` on the request's span                                                                                                                      |
| `method finished`                                             | `cupboard.cost.*` attributes on the `maintenance-pass` span (`cupboard.maintenance.pass`), the `maintenance-queue-message` span (`cupboard.maintenance.job`), or the root span of an RPC |
| `R2 get started`, `R2 get attempt started`, `R2 get returned` | The `r2-get` span                                                                                                                                                                        |
| `publication accepted`                                        | The `publication` span                                                                                                                                                                   |
| `upload planning finished`                                    | `cupboard.upload.paths` and `cupboard.cache.generation` on the request's span                                                                                                            |
| `read access acquired`                                        | `cupboard.access.resources` on the request's span                                                                                                                                        |
| `commit socket closed`                                        | `cupboard.socket.close_code` and `cupboard.socket.was_clean` on the `commit.socket.close` span                                                                                           |

`request finished` and `method finished` are still logged, at their old levels,
for an operation that no recording span could take. Error and warning records
keep their messages and fields, and add the active span's `trace_id`, `span_id`
and `trace_flags`. A failed database statement's message keeps its SQL text but
no longer includes its bound parameters.

Spans are sampled with their trace. `cupboard deploy` leaves the trace sampling
rate at Cloudflare's default, which keeps every trace. [Running a
deployment][running] describes the spans and their attributes. The push
diagnostic at this release's tag reads both forms, so it can report on telemetry
from before and after the upgrade.

[running]: ../running.md#logs
