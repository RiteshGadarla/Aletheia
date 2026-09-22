#!/usr/bin/env bash
# Makes ALETHEIA_DEMO_AUTOSTART real. It was documented in the README and set in the image, but
# nothing read it, so a judge opening the UI saw empty dashboards until they clicked a scenario.
#
# Starting the generators through the Studio's own API rather than spawning them here keeps one
# code path: the Demo Console's start/stop buttons and this service manage the same processes,
# so stopping a generator in the UI actually stops it.
set -u
exec 2>&1

[ "${ALETHEIA_DEMO_AUTOSTART:-true}" = "true" ] || { echo "[demo-autostart] disabled"; exit 0; }

/opt/aletheia/init/wait-for.sh http http://127.0.0.1:8081/healthz 120 || {
  echo "[demo-autostart] studio never became ready; skipping"; exit 0
}

samples="$(echo "${ALETHEIA_DEMO_SAMPLES:-asa,fortigate,cef}" | tr ',' ' ')"
n_samples=$(set -- $samples; echo $#); [ "$n_samples" -lt 1 ] && n_samples=1

for sid in $samples; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
           -X POST "http://127.0.0.1:8081/api/v1/demo/samples/${sid}/start" 2>/dev/null || echo 000)
  case "$code" in
    200)
      # ALETHEIA_DEMO_RATE was documented in the README but read by nothing. The generators
      # expose a rate control, so apply it and divide the budget across the started samples.
      if [ -n "${ALETHEIA_DEMO_RATE:-}" ]; then
        per=$(( ALETHEIA_DEMO_RATE / n_samples )); [ "$per" -lt 1 ] && per=1
        curl -sS -o /dev/null --max-time 10 -X POST -H 'Content-Type: application/json' \
          -d "{\"rate\": ${per}}" \
          "http://127.0.0.1:8081/api/v1/demo/samples/${sid}/control" 2>/dev/null \
          && echo "[demo-autostart] started ${sid} at ${per} eps" \
          || echo "[demo-autostart] started ${sid} (rate not applied)"
      else
        echo "[demo-autostart] started ${sid}"
      fi
      ;;
    *)   echo "[demo-autostart] ${sid} did not start (http ${code})" ;;
  esac
done

# Never fail the boot over demo traffic: the pipeline is the product, this is the shop window.
exit 0
