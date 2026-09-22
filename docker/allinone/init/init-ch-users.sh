#!/usr/bin/env bash
# Creates the "aletheia" ClickHouse user Grafana, the worker and the sealer all connect as
# (ALETHEIA_CLICKHOUSE_USER/ALETHEIA_CH_PASSWORD). The stock config only ships "default", so
# without this file every one of them would fail to authenticate on first boot.
set -euo pipefail
install -d -m 755 -o aletheia -g aletheia /etc/aletheia/clickhouse/users.d
cat > /etc/aletheia/clickhouse/users.d/aletheia.xml << XML
<clickhouse>
  <users>
    <aletheia>
      <password><![CDATA[${ALETHEIA_CH_PASSWORD:-aletheia}]]></password>
      <networks>
        <ip>::1</ip>
        <ip>127.0.0.1</ip>
      </networks>
      <profile>default</profile>
      <quota>default</quota>
      <access_management>1</access_management>
    </aletheia>
  </users>
</clickhouse>
XML
chown aletheia:aletheia /etc/aletheia/clickhouse/users.d/aletheia.xml
chmod 640 /etc/aletheia/clickhouse/users.d/aletheia.xml
echo "[init-ch-users] wrote users.d/aletheia.xml"
