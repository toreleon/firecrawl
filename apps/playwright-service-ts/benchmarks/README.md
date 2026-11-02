# Pinned WAF retrieval fixtures

`frontier-2026-10-30.json` contains the 100 literal targets from
[Web Data Frontier at commit 1ae0cf5](https://github.com/usestring/web-data-frontier-benchmark/blob/1ae0cf5fa11f6a80587fdba57cac3efbb75836df/src/tests.const.ts).
The TypeScript array was parsed as data using the TypeScript compiler AST; no
downloaded source was executed. Original names, URLs, expected text, industries
and protection labels are retained. Source bytes were checked against the
GitHub Git-blob SHA; that identifier and their SHA-256 are recorded in the JSON.
See `FRONTIER-LICENSE.txt` for the upstream MIT notice.

The protection labels describe the publisher's classification. They do not
prove which protection products or rules were active during a later request.
The pinned set has 20 DataDome, 20 Akamai, 15 Cloudflare, 9 PerimeterX and 13
unclassified targets, plus other smaller groups. Do not combine these fixtures
with a newer target list while presenting the results as one frozen run.

The marker assertion is a retrieval check, not a full-page completeness or
field-accuracy check. Some expected markers appear in JSON or metadata rather
than ordinary page text; preserve both the compatible and screened scores.
