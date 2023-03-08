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

3. RDS and OpenSearch are notoriously slow to provision, so development might slow down, especially when recreating resources.

> **Note**

> See [final implementation](#final-implementation) to see how the project was built in the end.

## Usage

### Prerequisites

1. Node.js

    This project assumes you have Node.js (>= 16.x) installed. If you do not, please download and install it from https://nodejs.org

2. AWS account and credentials

    You should have AWS credentials set up to run and deploy the project. If you do not, please follow the instructions on https://docs.aws.amazon.com/general/latest/gr/aws-sec-cred-types.html#access-keys-and-secret-access-keys

3. Git

    To clone this project, you will need `git`. If you do not, please follow the instructions on https://github.com/git-guides/install-git

### Steps

1. Clone this project –

    ```bash
    git clone https://github.com/paambaati/fold-backend-assignment
    ```

2. Install all dependencies –

    ```bash
    npm i
    ```

3. To run and develop locally –

    ```bash
    npm run dev
    ```

    > **Note**

    > Note that this _does_ provision everything to AWS, with a live reloading connection set up that proxies all logs to your local console. When you are ready to deploy to production, these same resources are updated accordingly.

4. (Optional) To deploy to production –

    ```bash
    npm run deploy
    ```

5. (Optional) To tear down everything –

    ```bash
    npm run remove
    ```

## Final Implementation

1. PostgreSQL 13.x as data source on RDS (with logical replication turned on).

2. AWS DMS is configured to continously replicate changes on PostgreSQL ("source") to a Kinesis data stream ("target").

    The AWS DMS replication instance is currently set up manually because of a long-standing Terraform (or perhaps AWS) bug – see https://github.com/hashicorp/terraform-provider-aws/issues/7602

3. The DMS target has a Lambda handler function that decisions each CDC record from DMS and syncs them to OpenSearch.

4. Another Lambda function serves the primary user-facing APIs and queries data from OpenSearch.

## Development Log

### Day 1 (2023 March 06)

1. Design and document approaches and implementation draft (~ 1 hour).

2. Set up SST bootstrap repository (~30 minutes).

3. Start reading about and setting up DMS (~4 hours).

    1. Set up RDS (~ 15 minutes).

    2. Set up DMS source & target endpoints and replicator instance manually and test them out (~ 2 hours).

        a. Turn on logical replication on RDS for DMS.

        b. Create PG source endpoint and make sure it can connect.

        c. Create OpenSearch target endpoint and make sure it can connect.

        d. Create replication task that connects source endpoint to target endpoint.

    3. SNAG: DMS engine 3.4.7 would not work correctly with security boundaries. (~2 hours).
    
        FIX: Downgrade to 3.4.6 means we need to downgrade PostgreSQL to 13.x as well, as support for PostgreSQL 14.x was added only in DMS engine 3.4.7 – see https://docs.aws.amazon.com/dms/latest/userguide/CHAP_ReleaseNotes.html#CHAP_ReleaseNotes.DMS346 (~ 2 hours).


### Day 2 (2023 March 07)

1. Set up core resources in SST stack, including VPC + SG, RDS, DMS, Lambda functions (~1.5 hour).

2. Quick spike of DMS using new infra brought up by SST stack (~3 hours).

    Had to adjust VPC and security groups.

    SNAG: Hit a Terraform (or is it AWS?) bug – see https://github.com/hashicorp/terraform-provider-aws/issues/7602. Basically Terraform would keep placing the DMS replicator task in the default VPC and not the one we created.

    ~~FIX~~ WORKAROUND: For now skip DMS replication instance provisioning via CDK/SST and do it manually.

3. Turn on replication (~1 hour).

    Tried to write a initializer script that would automatically install the `pglogical` extension on RDS.

    SNAG: Took too long, especially with RDS creation/re-creation cycles.

    ~~FIX~~ WORKROUND: The extension installation is being done manually via directly-executed SQL.

4. Revisit previous assumptions (~30 minutes).

### Day 3 (2023 March 08)

1. Set up OpenSearch domain in SST stack (~45 minutes).

    Had to adjust/re-adjust the fine-grained access policies so that CloudFormation would agree to spin up the domain.

2. Write core logic to filter DMS public schema updates and write them to OpenSearch as documents (~ 2 hours).

3. Figure out how to cross-join data across indexes (~1 hour).

    SNAG: Some of the documentation is out of date, but from what I can gather, for cross-index join queries to work (previously called relationships to model, well, relationships), looks like a mapping should be set up – https://www.elastic.co/guide/en/elasticsearch/reference/current/joining-queries.html

    Looks like I might not have enough time to do this.

4. Record demo video (~10 minutes).
