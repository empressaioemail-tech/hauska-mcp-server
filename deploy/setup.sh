#!/usr/bin/env bash
# One-time GCP setup for the Hauska MCP Server.
#
# Run once after the operator has created the hauska-prod project and
# linked a billing account. Enables APIs, creates the Artifact Registry
# repo, the runtime service account, the GCS log bucket, and the six
# Secret Manager secrets (empty; the operator adds versions after).
#
#   PROJECT_ID=hauska-prod ./deploy/setup.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID, e.g. hauska-prod}"
REGION="${REGION:-us-central1}"
AR_REPO="${AR_REPO:-hauska-mcp}"
RUNTIME_SA="${RUNTIME_SA:-hauska-mcp-runtime}"
GCS_LOG_BUCKET="${GCS_LOG_BUCKET:-hauska-mcp-logs}"
SA_EMAIL="${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "==> Enable APIs"
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com logging.googleapis.com monitoring.googleapis.com \
  --project="$PROJECT_ID"

echo "==> Artifact Registry repo: $AR_REPO"
gcloud artifacts repositories create "$AR_REPO" \
  --project="$PROJECT_ID" --location="$REGION" --repository-format=docker \
  --description="Hauska MCP Server container images" \
  || echo "   (repo already exists)"

echo "==> Runtime service account: $SA_EMAIL"
gcloud iam service-accounts create "$RUNTIME_SA" \
  --project="$PROJECT_ID" --display-name="Hauska MCP Server runtime" \
  || echo "   (service account already exists)"

echo "==> GCS log bucket: gs://$GCS_LOG_BUCKET"
gcloud storage buckets create "gs://$GCS_LOG_BUCKET" \
  --project="$PROJECT_ID" --location="$REGION" --uniform-bucket-level-access \
  || echo "   (bucket already exists)"
gcloud storage buckets add-iam-policy-binding "gs://$GCS_LOG_BUCKET" \
  --member="serviceAccount:$SA_EMAIL" --role="roles/storage.objectAdmin"

echo "==> Secret Manager secrets (created empty; add versions after)"
for s in HAUSKA_ENGINE_API_KEY LEGACY_BACKEND_API_KEY LEGACY_SNAPSHOT_SECRET \
         DATABASE_URL UPSTASH_REDIS_REST_TOKEN HAUSKA_ADMIN_BOOTSTRAP_KEY; do
  gcloud secrets create "$s" --project="$PROJECT_ID" \
    --replication-policy=automatic || echo "   ($s already exists)"
  gcloud secrets add-iam-policy-binding "$s" --project="$PROJECT_ID" \
    --member="serviceAccount:$SA_EMAIL" \
    --role="roles/secretmanager.secretAccessor" >/dev/null
done

echo "==> Grant the Cloud Build service account deploy permissions"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
# New projects may run builds as the Compute Engine default SA instead of
# the legacy Cloud Build SA. Grant both so the build can deploy either way.
for CB_SA in "${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" \
             "${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"; do
  for role in roles/run.admin roles/iam.serviceAccountUser \
              roles/artifactregistry.writer roles/logging.logWriter; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
      --member="serviceAccount:$CB_SA" --role="$role" >/dev/null 2>&1 || true
  done
done

cat <<NEXT

Setup complete for project $PROJECT_ID.

Remaining operator steps before the first deploy (see deploy/README.md):

  1. Add a version to each secret (values: deploy/secrets.md). Example:
       printf '%s' '<value>' | gcloud secrets versions add DATABASE_URL \\
         --project=$PROJECT_ID --data-file=-

  2. Apply database migrations:
       DATABASE_URL='<value>' npm run migrate

  3. Deploy:
       gcloud builds submit --project=$PROJECT_ID --config=cloudbuild-mcp.yaml \\
         --substitutions=_HAUSKA_BACKEND_URL=<engine-url>,_UPSTASH_REDIS_REST_URL=<upstash-url>

  4. Apply observability (observability/apply.sh) and map mcp.hauska.dev.
NEXT
