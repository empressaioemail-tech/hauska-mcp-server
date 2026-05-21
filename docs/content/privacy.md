# Privacy

Version 1, 2026-05-21. How the Hauska MCP Server handles request data.

## What is collected

For each call to the Service, the following is logged:

- the tool called and its parameters (truncated if very large);
- the jurisdiction and atoms involved;
- the caller's IP address;
- a one-way hash of the API key, when a key is presented (never the raw
  key);
- the tier, the response status, and the latency.

The Service does not ask for or store names, accounts beyond an issued
API key, or payment data. API keys are stored only as a SHA-256 hash.

## How it is used

Collected data is used to:

- operate the Service: route requests, enforce rate limits, and keep the
  system healthy;
- detect abuse and identify commercial-scale use that has outgrown the
  free tier;
- produce aggregate analytics (calls by tool, jurisdiction, and tier).

## Training-data use — please read

Logged requests and responses are also retained as a corpus used to
**improve and train models**: tuning retrieval quality, building
evaluation sets, and fine-tuning. Treat anything you send to the Service
as potentially retained for that purpose. Do not send secrets, personal
data, or anything confidential in tool parameters. Tool parameters are
building-code queries by design; keep them that way.

## Retention and storage

Structured request logs are kept in a Postgres index; fuller request and
response records are archived to Google Cloud Storage. Both are retained
for the operational and training purposes above. Data is stored on Google
Cloud infrastructure.

## Sharing

Request data is not sold. It is not shared with third parties except the
infrastructure providers that run the Service (Google Cloud, and the
rate-limit store), and except where required by law.

## Your choices

The free unauthenticated tier is bucketed by IP; an API key ties usage to
a key hash rather than an IP. To request information about, or deletion
of, data associated with your key hash, contact us.

## Contact

[hello@hauska.dev](mailto:hello@hauska.dev).
