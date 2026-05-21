#!/usr/bin/env bash
# Apply the Hauska MCP Server observability config to a GCP project:
# the three log-based metrics, the two alert policies, and the operations
# dashboard. Run after the hauska-mcp-server Cloud Run service exists
# (Stream 2D.3).
#
# Usage:
#   PROJECT_ID=<project> \
#   SERVICE=hauska-mcp-server \
#   NOTIFICATION_CHANNEL=projects/<project>/notificationChannels/<id> \
#   ./apply.sh
#
# NOTIFICATION_CHANNEL is optional; without it the alert policies are
# skipped (create an email channel first, then re-run).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
SERVICE="${SERVICE:-hauska-mcp-server}"
HERE="$(cd "$(dirname "$0")" && pwd)"

base_filter="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE}\""

echo "==> log-based metric: mcp_requests_total"
gcloud logging metrics create mcp_requests_total --project="$PROJECT_ID" \
  --description="Completed /mcp requests" \
  --log-filter="${base_filter} AND jsonPayload.event=\"request_completed\"" \
  || gcloud logging metrics update mcp_requests_total --project="$PROJECT_ID" \
       --log-filter="${base_filter} AND jsonPayload.event=\"request_completed\""

echo "==> log-based metric: mcp_request_errors"
err_filter="${base_filter} AND jsonPayload.event=\"request_completed\" AND jsonPayload.response_status>=500"
gcloud logging metrics create mcp_request_errors --project="$PROJECT_ID" \
  --description="Completed /mcp requests with a 5xx response" \
  --log-filter="${err_filter}" \
  || gcloud logging metrics update mcp_request_errors --project="$PROJECT_ID" \
       --log-filter="${err_filter}"

echo "==> log-based metric: mcp_request_latency (distribution)"
sed "s/__SERVICE__/${SERVICE}/g" "${HERE}/log-metrics/latency.yaml" \
  > /tmp/mcp-latency-metric.yaml
gcloud logging metrics create mcp_request_latency --project="$PROJECT_ID" \
  --config-from-file=/tmp/mcp-latency-metric.yaml \
  || gcloud logging metrics update mcp_request_latency --project="$PROJECT_ID" \
       --config-from-file=/tmp/mcp-latency-metric.yaml

if [[ -n "${NOTIFICATION_CHANNEL:-}" ]]; then
  for policy in error-rate p99-latency; do
    echo "==> alert policy: ${policy}"
    sed -e "s#__PROJECT_ID__#${PROJECT_ID}#g" \
        -e "s#__NOTIFICATION_CHANNEL__#${NOTIFICATION_CHANNEL}#g" \
        "${HERE}/alert-policies/${policy}.json" > "/tmp/mcp-alert-${policy}.json"
    gcloud monitoring policies create --project="$PROJECT_ID" \
      --policy-from-file="/tmp/mcp-alert-${policy}.json" \
      || echo "   !! alert policy ${policy} failed to apply; see observability/README.md (MQL note)"
  done
else
  echo "!! NOTIFICATION_CHANNEL not set — skipping alert policies."
  echo "   Create one, e.g.:"
  echo "   gcloud beta monitoring channels create --project=$PROJECT_ID \\"
  echo "     --display-name='MCP alerts' --type=email \\"
  echo "     --channel-labels=email_address=ops@hauska.dev"
fi

echo "==> operations dashboard"
gcloud monitoring dashboards create --project="$PROJECT_ID" \
  --config-from-file="${HERE}/monitoring-dashboard.json" || true

echo "Done. Verify in Cloud Monitoring > Metrics, Alerting, and Dashboards."
