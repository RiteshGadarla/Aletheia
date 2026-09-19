#!/usr/bin/env bash
# Load the source registry and the approved parser packs into PostgreSQL.
set -euo pipefail
/opt/aletheia/init/wait-for.sh tcp 127.0.0.1:5432 120
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=aletheia PGDATABASE=aletheia

# Demo source registry. Peers match the replayers; unknown peers stay `unknown:<ip>`.
psql -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO sources (source_id, peers, listener, vendor, product, device_type, timezone) VALUES
  ('fw01',    ARRAY['192.0.2.10'], 'udp:5514', 'Netgate',  'pfSense',   'firewall',  'UTC'),
  ('ids01',   ARRAY['192.0.2.11'], 'udp:5514', 'OISF',     'Suricata',  'ids',       'UTC'),
  ('vpn01',   ARRAY['192.0.2.12'], 'udp:5514', 'OpenVPN',  'OpenVPN',   'vpn',       'UTC'),
  ('proxy01', ARRAY['192.0.2.13'], 'udp:5514', 'Squid',    'Squid',     'proxy',     'UTC'),
  ('asa01',   ARRAY['192.0.2.14'], 'udp:5514', 'Cisco',    'ASA',       'firewall',  'UTC'),
  ('fgt01',   ARRAY['192.0.2.15'], 'udp:5514', 'Fortinet', 'FortiGate', 'firewall',  'UTC'),
  ('cef01',   ARRAY['192.0.2.16'], 'udp:5514', 'Generic',  'CEF',       'waf',       'UTC'),
  ('leef01',  ARRAY['192.0.2.17'], 'udp:5514', 'Generic',  'LEEF',      'waf',       'UTC')
ON CONFLICT (source_id) DO NOTHING;
SQL

# Parser packs: the engine CLI owns pack validation, so registration goes through it.
if [ -d /data/packs ]; then
  shopt -s nullglob
  for p in /data/packs/*.yaml; do
    case "$(basename "$p")" in _*) continue ;; esac
    if aletheia pack-load --pack "$p" --status approved --json >/dev/null 2>&1; then
      echo "[init-packs] registered $(basename "$p")"
    else
      # Fall back to a direct insert so a missing CLI subcommand cannot block startup.
      sum="$(sha256sum "$p" | cut -d' ' -f1)"
      name="$(basename "$p" .yaml)"
      psql -v ON_ERROR_STOP=1 -c \
        "INSERT INTO packs (pack, version, status, yaml, checksum, author, origin)
         SELECT '$name', 1, 'approved', pg_read_file('$p'), '$sum', 'bundled', 'heuristic'
         ON CONFLICT (pack, version) DO NOTHING" >/dev/null 2>&1 \
        || echo "[init-packs] could not register $name (continuing)"
    fi
  done
fi
echo "[init-packs] done"
