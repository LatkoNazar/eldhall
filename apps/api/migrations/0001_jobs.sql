CREATE TABLE jobs (
  id uuid NOT NULL PRIMARY KEY,
  text text NOT NULL,
  operation varchar(20) NOT NULL,
  status varchar(20) NOT NULL,
  result text,
  error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT job_status CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  CONSTRAINT job_operation CHECK (operation IN ('uppercase', 'reverse'))
);
