# DocScanner FAX image boundary

The existing `/api/integrations/doc-scanner/fax-received` endpoint retains its integration-secret authentication, fixed FAX board, and TSG君 identity. TSG normalizes EXIF orientation, white background, size, and JPEG encoding. It never infers a document's reading direction from ink position or applies a semantic rotation. DocScanner owns the final page orientation.

## Optional orientation receipt

An image attachment may include exactly these eight fields in `orientation`:

```json
{
  "version": 2,
  "owner": "docscanner",
  "page": 1,
  "sha256": "<SHA256 of the exact incoming image bytes>",
  "rotationDegrees": 0,
  "status": "upright",
  "method": "body-text-pair",
  "confidence": 0.99
}
```

`page` must match the attachment's positive integer `sourcePage`; `sourcePageCount`, when supplied, must be an integer at least that page. `confidence` must be finite within 0–1. `corrected` requires rotationDegrees 180; `upright` and `uncertain` require 0. An uncertain receipt preserves the submitted image and does not assert a successful orientation decision.

TSG checks the receipt against the original incoming bytes before normalization. It stores `receivedSha256` and a separate `storedSha256` for the normalized JPEG uploaded to Drive. The latter is not a thumbnail hash. All images and receipts are validated before any upload; malformed receipts or mismatched bytes return 400. A Drive reference with a receipt must supply retrievable image bytes. Legacy attachments without receipts retain their existing contract, with EXIF-only normalization when image bytes are processed.

Authenticated GET exposes `capabilities.orientationReceiptVersion: 2`, `semanticRotation: false`, and `repairAttachments: true` for producer readiness checks.

## Repair an existing post's attachments

Use the same POST endpoint with `action: "repair-attachments"`, a confirmed `postId`, the exact original `sourceKey`, the ordered `expectedDriveIds` from the current post, and replacement `attachments`. Each replacement uses the ordinary image payload and may include the receipt above.

The target must be a root post by TSG君 in the fixed FAX board, with exactly one matching full `受信ID: <sourceKey>` line. Old Drive IDs, attachment count, page bindings, and any existing logical `docScannerFileHash` must match. Preserve the original logical hash even if OCR changed a local PDF's physical bytes.

TSG uploads replacement images to new Drive IDs, then conditionally updates only `attachments` if the complete old attachment JSON is unchanged. A stale target returns 409; a missing target returns 404. No post insert, Push, or content/summary/date/reply update occurs. If a storage failure or concurrent edit occurs after uploading, an unreferenced replacement Drive file may remain; never retry blindly or overwrite another editor's attachment.

Reload the board after repair because it does not subscribe to attachment changes. Validate the same post ID, creation date, content hash, reply count, and single source-key post, then download the new Drive original and compare its SHA256 to `storedSha256`. Confirm reading direction visually. Do not compare the hash of a Drive thumbnail with the original.
