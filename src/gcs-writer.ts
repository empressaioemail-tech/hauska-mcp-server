// Google Cloud Storage writer for the structured-log archive.
//
// Isolated in its own module so @google-cloud/storage is loaded only when
// GCS logging is actually enabled (GCS_LOG_BUCKET set in production).
// index.ts dynamic-imports this module behind that env check; log-sink.ts
// depends only on the GcsWriter interface, so the unit tests never touch
// this package.
//
// Auth is Application Default Credentials. On Cloud Run the runtime
// service account supplies them with no key file, the same ADC path
// cortex-api uses for object storage.

import { Storage } from "@google-cloud/storage";

import type { GcsWriter } from "./log-sink.js";

export function createGcsWriter(bucketName: string): GcsWriter {
  const bucket = new Storage().bucket(bucketName);
  return {
    async write(objectPath, body, contentType): Promise<void> {
      await bucket.file(objectPath).save(body, {
        contentType,
        // Log batches are small; a single-shot upload avoids the
        // resumable-session round-trips.
        resumable: false,
      });
    },
  };
}
