-- =============================================================================
-- 006 - Users, roles and tamper-evident audit log (Phase 6)
-- =============================================================================
CREATE TABLE users (
  username       text PRIMARY KEY,
  password_hash  text NOT NULL,              -- scrypt$N$r$p$salt$hash
  role           text NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login     timestamptz,
  disabled       boolean NOT NULL DEFAULT false
);

-- Append-only audit log. Each row stores the SHA-256 of (previous hash + row
-- content): modifying or deleting any past row breaks the chain, which
-- /api/audit/verify detects.
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  time       timestamptz NOT NULL DEFAULT now(),
  actor      text NOT NULL,                  -- username, "auto:twin", "system"
  role       text,
  ip         text,
  action     text NOT NULL,                  -- login, command, policy, ack, relearn, user...
  target     text,
  result     text NOT NULL,                  -- ok | denied | error
  details    jsonb,
  prev_hash  text NOT NULL,
  hash       text NOT NULL
);

-- The database itself refuses UPDATE and DELETE on the audit log.
CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
