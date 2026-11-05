# `cupboard confirm` can need several requests

A tenant now checks only as many store paths in one confirm request as the
invocation's subrequests can cover, and answers the paths that it checked. The
CLI sends the other paths in later requests. Earlier releases checked every path
in the request, and a large request could use up the subrequests and fail with
status 500.

A tenant answers only part of a request in two cases:

- On Workers Free, the request has more than 425 paths.
- On either plan, many of the request's paths need their narinfo object
  repaired. Each repair can take up to eight more calls. Repairs are needed
  after R2 loses narinfo objects, or after recovery moves a NAR that other
  caches also use.

`cupboard confirm` from v0.0.46 or later sends the paths that an answer left
out. `cupboard confirm` from v0.0.45 or earlier does not. It reports only the
paths that the tenant answers, for example 425 of each 1,000-path page on
Workers Free, and exits with status 0. The other paths keep their previous grace
deadline, and the output doesn't list them. Garbage collection can therefore
remove those paths at their old deadline, although the job reported success.

Upgrade every CLI that runs `cupboard confirm`, including the ones in CI, to
v0.0.46 or later. From v0.0.52, the CLI also sizes each request by the limit
that the tenant advertises, so it doesn't send the left-out paths again in every
request. With v0.0.46 or later, this command confirms every path in the file:

```sh
cupboard confirm https://cupboard.example.workers.dev/t/acme --paths-file paths.txt
```
