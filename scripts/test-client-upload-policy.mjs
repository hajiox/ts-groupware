import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLIENT_UPLOAD_MAX_BYTES,
  clientUploadAction,
} from "../lib/client-upload.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

assert.equal(clientUploadAction({ size: 1, type: "image/jpeg" }, "compress"), "compress");
assert.equal(clientUploadAction({ size: 1, type: "image/jpeg" }, "compress-if-needed"), "original");
assert.equal(
  clientUploadAction({ size: CLIENT_UPLOAD_MAX_BYTES + 1, type: "image/jpeg" }, "compress-if-needed"),
  "compress",
);
assert.equal(clientUploadAction({ size: 1, type: "image/jpeg" }, "original"), "original");
assert.equal(
  clientUploadAction({ size: CLIENT_UPLOAD_MAX_BYTES + 1, type: "image/jpeg" }, "original"),
  "reject-original-too-large",
);
assert.equal(clientUploadAction({ size: 1, type: "application/pdf" }, "compress"), "original");
assert.equal(
  clientUploadAction({ size: CLIENT_UPLOAD_MAX_BYTES + 1, type: "application/pdf" }, "compress"),
  "reject-too-large",
);
assert.equal(clientUploadAction({ size: 0, type: "image/png" }, "compress"), "reject-empty");

function sourceFiles(directory) {
  return readdirSync(directory)
    .flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? sourceFiles(path) : [path];
    })
    .filter((path) => /\.(?:ts|tsx)$/.test(path));
}

const allowedEndpointFiles = new Set([
  "app/api/upload/route.ts",
  "lib/client-upload.ts",
]);
const bypasses = ["app", "components", "lib"]
  .flatMap((directory) => sourceFiles(join(root, directory)))
  .map((path) => ({ path, relativePath: relative(root, path).replaceAll("\\", "/") }))
  .filter(({ path, relativePath }) => (
    !allowedEndpointFiles.has(relativePath)
    && readFileSync(path, "utf8").includes("/api/upload")
  ));

assert.deepEqual(
  bypasses.map(({ relativePath }) => relativePath),
  [],
  "All browser upload paths must use lib/client-upload.ts",
);

console.log("Client upload policy tests passed");
