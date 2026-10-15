-- Idempotent: creates/updates the application role and database. Values come from env vars
-- (never on the command line, so passwords do not show up in `ps`).
\set ON_ERROR_STOP on
\getenv app_db APP_DB
\getenv app_user APP_USER
\getenv app_password APP_PASSWORD

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec

SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 30',
              :'app_user', :'app_password') \gexec

SELECT format('CREATE DATABASE %I OWNER %I ENCODING %L TEMPLATE template0', :'app_db', :'app_user', 'UTF8')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'app_db') \gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'app_db') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'app_db', :'app_user') \gexec

\connect :"app_db"
SELECT format('ALTER SCHEMA public OWNER TO %I', :'app_user') \gexec
REVOKE ALL ON SCHEMA public FROM PUBLIC;
\echo 'Database ready.'
