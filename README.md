# PGSQL ↔ Elastic Sync Engine + Query API

## Problem Statement

Build a sync engine that takes all changes from a given PostgreSQL database instance and syncs them with Elastic Search. This Elastic Search data then needs to be query-able with a REST API.

## Initial Design

### High-level design

The "sync engine" at the heart of the solution will ideally be a CDC (change data capture) system like [Debezium](https://debezium.io/), [pgSync](https://pgsync.com/) or [AWS DMS](https://aws.amazon.com/dms/) that continually "watches" for changes (ideally all kinds of operations like `INSERT`, `UPDATE`, `DELETE` and other such DML statements) to a PostgreSQL DB instance and "syncs" those changes to ElasticSearch (by creating a 1:1 mapping of a ES record for each DB record).

These ES records are then made query-able using a HTTP API that uses the ES API to lookup and fetch records from ES.

### Assumptions

1. It is assumed the CDC is required, and that we do not control the writer to the database (see question 1 below).

2. It is assumed the infra is on AWS.

3. It is assumed that one of the key goals is to keep the system simple to reason about and easy to scale.

### Questions

1. Do we even need CDC?

    CDC is a complex problem to solve, and introduces too many complexities – including additional moving parts, additional running costs and o11y challenges.

    **I would urge we try to eliminate CDC**, and if we control the database writer, rather write to ElasticSearch from the same writer. Frequent single-record writes to ElasticSearch might be slow, so if overall application response latency is an issue, the writes might be committed on separate green threads or a queueing/logging system like Kafka or SQS. This also comes with the additional bonus of more flexibility and power in what _exactly_ we write to ElasticSearch.

### Low-level implementation

The low-level implementation will focus on spinning up a PostgreSQL DB instance on AWS RDS and a DMS replication task (full CDC and ongoing replication) that uses PostgreSQL as a source and OpenSearch (AWS's forked version of ElasticSeach) as a target.

Once this is working, we build a Lambda API that queries OpenSearch according to the original spec.

#### Initial considerations

1. Perhaps a local-first spike of a full setup end-to-end?

    This will include a local copy of PostgreSQL, pgSync and ElasticSearch – this will show if the sync can work.

    ❌ – might be complex to productionize this, as we'd generally want discrete systems running inside their own infra boundaries. Might be better to develop directly against AWS.

#### Tasks

1. Bootstrap an [SST](https://sst.dev) project
2. Create RDS and DMS constructs
3. Verify that DMS source and target endpoints work
4. Build API endpoint to query OpenSearch

#### Risks

1. Newer AWS infrastructure is infamously hard to develop against (especially in a 3-day window), and DMS, although well documented, does not seem like a particularly well known product. I might be stuck in IAM/Network ACL hell, so better to timebox each task.

2. Unclear how exactly the DMS OpenSearch target endpoint will handle CDC operations, and how easily it is to control indexing and record transformation (if need be). If this is too complex, we'd be better off writing a Kinesis target endpoint and a Lambda consumer that handles the OpenSearch syncing.