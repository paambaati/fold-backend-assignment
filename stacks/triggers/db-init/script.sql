-- Database initialization.
-- Install the `pglogical` extension.
CREATE EXTENSION IF NOT EXISTS pglogical;

-- Verify `pglogical` is actually installed.
SELECT CASE
  WHEN (COUNT(*) > 0) THEN true
  ELSE false
 END AS installed
FROM pg_catalog.pg_extension WHERE extname = 'pglogical';
