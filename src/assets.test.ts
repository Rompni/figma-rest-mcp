import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertTrustedAssetUrl, downloadTrustedAsset, isTrustedAssetHost } from "./assets.js";

describe("isTrustedAssetHost", () => {
  it("allows Figma and Figma S3 hosts", () => {
    assert.equal(isTrustedAssetHost("figma-alpha-api.s3.us-west-2.amazonaws.com"), true);
    assert.equal(isTrustedAssetHost("s3-us-west-2.amazonaws.com"), true);
    assert.equal(isTrustedAssetHost("www.figma.com"), true);
    assert.equal(isTrustedAssetHost("evil.example"), false);
    assert.equal(isTrustedAssetHost("attacker.amazonaws.com.evil.com"), false);
  });
});

describe("assertTrustedAssetUrl", () => {
  it("rejects http and unknown hosts", () => {
    assert.throws(() => assertTrustedAssetUrl("http://www.figma.com/x"), /non-HTTPS/);
    assert.throws(() => assertTrustedAssetUrl("https://evil.example/x"), /untrusted host/);
  });
});

describe("downloadTrustedAsset", () => {
  it("returns a data URI under the size cap", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const asset = await downloadTrustedAsset("https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/a", {
      timeoutMs: 1000,
      maxBytes: 1000,
      fetchImpl: async () =>
        new Response(bytes, { status: 200, headers: { "content-type": "image/png" } }),
    });
    assert.equal(asset.skipped, undefined);
    assert.equal(asset.byteLength, 4);
    assert.equal(asset.contentType, "image/png");
    assert.equal(asset.dataUri, `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
  });

  it("skips when content-length exceeds the cap", async () => {
    const asset = await downloadTrustedAsset("https://s3-us-west-2.amazonaws.com/figma/a", {
      timeoutMs: 1000,
      maxBytes: 10,
      fetchImpl: async () =>
        new Response("not used", {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "9999" },
        }),
    });
    assert.equal(asset.skipped, true);
    assert.match(asset.reason ?? "", /maxBytes/);
    assert.equal(asset.dataUri, undefined);
  });

  it("refuses redirects off the allowlist", async () => {
    await assert.rejects(
      () =>
        downloadTrustedAsset("https://www.figma.com/redirect", {
          timeoutMs: 1000,
          maxBytes: 1000,
          fetchImpl: async () =>
            new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }),
        }),
      /untrusted host/,
    );
  });
});
