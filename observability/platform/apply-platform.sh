#!/usr/bin/env bash
# Apply platform observability for hauska-prod-497015 (76e):
# uptime checks for hauska-mcp-server + hauska-retrieval-api, Cloud Run
# metric alert policies (5xx rate, p95 latency, stale-revision drift), and
# optional notification channel wiring.
#
# Usage:
#   PROJECT_ID=hauska-prod-497015 \
#   REGION=us-central1 \
#   NOTIFICATION_CHANNEL=projects/.../notificationChannels/... \
#   MCP_HOST=hauska-mcp-server-h7gvu7rgcq-uc.a.run.app \
#   RETRIEVAL_HOST=hauska-retrieval-api-XXXX-uc.a.run.app \
#   ./observability/platform/apply-platform.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-central1}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"

MCP_SERVICE="${MCP_SERVICE:-hauska-mcp-server}"
RETRIEVAL_SERVICE="${RETRIEVAL_SERVICE:-hauska-retrieval-api}"
MCP_HOST="${MCP_HOST:-}"
RETRIEVAL_HOST="${RETRIEVAL_HOST:-}"

resolve_host() {
  local service="$1"
  gcloud run services describe "$service" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --format='value(status.url)' \
    | sed -E 's#^https://([^/]+)/?$#\1#'
}

if [[ -z "$MCP_HOST" ]]; then
  MCP_HOST="$(resolve_host "$MCP_SERVICE")"
fi
if [[ -z "$RETRIEVAL_HOST" ]]; then
  RETRIEVAL_HOST="$(resolve_host "$RETRIEVAL_SERVICE")"
fi

echo "==> hosts: mcp=$MCP_HOST retrieval=$RETRIEVAL_HOST"

create_uptime() {
  local name="$1"
  local host="$2"
  local path="$3"
  echo "==> uptime check: ${name} (${host}${path})"
  if gcloud monitoring uptime list-configs --project="$PROJECT_ID" \
      --format='value(name)' 2>/dev/null | grep -q "${name}"; then
    echo "   exists, skipping create"
    return
  fi
  gcloud monitoring uptime create "${name}" \
    --project="$PROJECT_ID" \
    --resource-type=uptime-url \
    --resource-labels="host=${host},project_id=${PROJECT_ID}" \
    --path="${path}" \
    --protocol=https \
    --port=443 \
    --period=5 \
    --timeout=10 \
    --status-codes=200 \
    || echo "   !! uptime create failed for ${name}"
}

create_uptime "hauska-mcp-server-healthz" "$MCP_HOST" "/healthz"
create_uptime "hauska-retrieval-api-healthz" "$RETRIEVAL_HOST" "/healthz"

if [[ -n "${NOTIFICATION_CHANNEL:-}" ]]; then
  for policy in cloud-run-5xx-rate cloud-run-p95-latency revision-traffic-drift; do
    echo "==> alert policy: ${policy}"
    sed -e "s#__PROJECT_ID__#${PROJECT_ID}#g" \
        -e "s#__NOTIFICATION_CHANNEL__#${NOTIFICATION_CHANNEL}#g" \
        -e "s#__REGION__#${REGION}#g" \
        -e "s#__MCP_SERVICE__#${MCP_SERVICE}#g" \
        -e "s#__RETRIEVAL_SERVICE__#${RETRIEVAL_SERVICE}#g" \
        "${HERE}/alert-policies/${policy}.json" > "/tmp/hauska-${policy}.json"
    gcloud monitoring policies create --project="$PROJECT_ID" \
      --policy-from-file="/tmp/hauska-${policy}.json" \
      || echo "   !! alert policy ${policy} failed (may already exist)"
  done
else
  echo "!! NOTIFICATION_CHANNEL not set — skipping alert policies."
  echo "   Create one, e.g.:"
  echo "   gcloud beta monitoring channels create --project=$PROJECT_ID \\"
  echo "     --display-name='Hauska platform alerts' --type=email \\"
  echo "     --channel-labels=email_address=ops@hauska.dev"
fi

echo "==> enable Cloud Scheduler API (pre-fire gate)"
gcloud services enable cloudscheduler.googleapis.com --project="$PROJECT_ID" \
  || echo "   !! enable failed — report verbatim to operator"

echo "Done. List uptime checks:"
gcloud monitoring uptime list-configs --project="$PROJECT_ID" --format='table(displayName,httpCheck.path,monitoredResource.labels.host)'
