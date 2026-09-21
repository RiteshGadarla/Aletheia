import pytest

from studio.chat.guard import GuardError, validate_sql

OK = [
    "SELECT count() FROM events",
    "SELECT src_ip, count() AS n FROM events WHERE action_id = 2 GROUP BY src_ip ORDER BY n DESC LIMIT 10",
    "SELECT toStartOfMinute(recv_time) AS t, count(*) FROM aletheia.events WHERE recv_time > now() - INTERVAL 60 MINUTE GROUP BY t",
]
BAD = [
    "DROP TABLE events", "SELECT * FROM events", "SELECT raw_verbatim FROM events",
    "SELECT 1; DROP TABLE events", "SELECT count() FROM system.users",
    "SELECT url('http://x') FROM events", "SELECT count() FROM events LIMIT 99999",
    "SELECT count() FROM events -- x", "INSERT INTO events VALUES (1)",
    "SELECT count() FROM events, default.foo", "SELECT src_ip FROM events INTO OUTFILE 'x'",
    "SELECT count() FROM file('/etc/passwd')",
]


@pytest.mark.parametrize("q", OK)
def test_allows(q):
    validate_sql(q)


@pytest.mark.parametrize("q", BAD)
def test_refuses(q):
    with pytest.raises(GuardError):
        validate_sql(q)
