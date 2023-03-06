CREATE TABLE IF NOT EXISTS users(
    id BIGSERIAL PRIMARY KEY,
    "name" VARCHAR,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hashtags(
    id BIGSERIAL PRIMARY KEY,
    "name" VARCHAR,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects(
    id BIGSERIAL PRIMARY KEY,
    "name" VARCHAR,
    slug VARCHAR,
    "description" TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_hashtags(
    hashtag_id INT NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
    project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_projects(
    project_id INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);

-- Sample data.
INSERT INTO users ("name") VALUES('Akash') RETURNING *;
INSERT INTO users ("name") VALUES('Utkarsh') RETURNING *;
INSERT INTO users ("name") VALUES('Shakti') RETURNING *;
INSERT INTO users ("name") VALUES('GP') RETURNING *;
INSERT INTO users ("name") VALUES('Maggi') RETURNING *;
INSERT INTO users ("name") VALUES('Mochi') RETURNING *;
INSERT INTO users ("name") VALUES('Burfi') RETURNING *;
INSERT INTO users ("name") VALUES('Finn') RETURNING *;
INSERT INTO users ("name") VALUES('Arun') RETURNING *;
INSERT INTO users ("name") VALUES('Rama') RETURNING *;
INSERT INTO users ("name") VALUES('Sandy') RETURNING *;
INSERT INTO users ("name") VALUES('Mithra') RETURNING *;
INSERT INTO users ("name") VALUES('Aneesh') RETURNING *;
INSERT INTO users ("name") VALUES('Arathi') RETURNING *;
INSERT INTO users ("name") VALUES('Karthika') RETURNING *;
INSERT INTO users ("name") VALUES('Vetri') RETURNING *;
INSERT INTO users ("name") VALUES('Amrita') RETURNING *;
INSERT INTO users ("name") VALUES('Nimeet') RETURNING *;
INSERT INTO users ("name") VALUES('Vaibhavi') RETURNING *;

INSERT INTO hashtags ("name") VALUES('oss') RETURNING *;
INSERT INTO hashtags ("name") VALUES('proprietary') RETURNING *;

INSERT INTO projects ("name", slug, "description") VALUES('Devfolio', 'devfolio', 'Your one application to the best hackathons');
INSERT INTO projects ("name", slug, "description") VALUES('Fold', 'fold', 'Manage your money with Fold');
INSERT INTO projects ("name", slug, "description") VALUES('X', 'x', 'Top-secret project');

INSERT INTO project_hashtags (project_id, hashtag_id) WITH t1 AS (SELECT id FROM projects WHERE "name" = 'Devfolio'), t2 AS (SELECT id FROM hashtags WHERE "name" = 'oss') SELECT t1.id, t2.id FROM t1, t2 RETURNING *;
INSERT INTO project_hashtags (project_id, hashtag_id) WITH t1 AS (SELECT id FROM projects WHERE "name" = 'Fold'), t2 AS (SELECT id FROM hashtags WHERE "name" = 'proprietary') SELECT t1.id, t2.id FROM t1, t2 RETURNING *;
INSERT INTO project_hashtags (project_id, hashtag_id) WITH t1 AS (SELECT id FROM projects WHERE "name" = 'X'), t2 AS (SELECT id FROM hashtags WHERE "name" = 'oss') SELECT t1.id, t2.id FROM t1, t2 RETURNING *;

INSERT INTO user_projects (user_id, project_id) WITH t1 AS (SELECT id FROM users WHERE "name" = 'Shakti'), t2 AS (SELECT id FROM projects WHERE "name" = 'Devfolio') SELECT t1.id, t2.id FROM t1, t2 RETURNING *;
INSERT INTO user_projects (user_id, project_id) WITH t1 AS (SELECT id FROM users WHERE "name" = 'Shakti'), t2 AS (SELECT id FROM projects WHERE "name" = 'Fold') SELECT t1.id, t2.id FROM t1, t2 RETURNING *;
INSERT INTO user_projects (user_id, project_id) WITH t1 AS (SELECT id FROM users WHERE "name" = 'GP'), t2 AS (SELECT id FROM projects WHERE "name" = 'X') SELECT t1.id, t2.id FROM t1, t2 RETURNING *;

-- Replication
-- Needs to be executed once on RDS before logical replication (and so CDC) can kick in.

CREATE EXTENSION IF NOT EXISTS pglogical;

-- Verify `pglogical` is in result.
SELECT * FROM pg_catalog.pg_extension;
-- Verify `rds.logical_replication` is `1` and `wal_level` is `logical` in result.
SELECT name, setting FROM pg_settings WHERE name IN ('wal_level','rds.logical_replication');
