import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { messageForStatus, parseRetryAfter } from "./errors.js";

describe("messageForStatus", () => {
  it("explains 401 as REST auth, not official MCP quota", () => {
    const msg = messageForStatus(401, { err: "Invalid token" });
    assert.match(msg, /401 Unauthorized/);
    assert.match(msg, /official MCP/);
    assert.match(msg, /Invalid token/);
    assert.doesNotMatch(msg, /seat\/tool-call quota from Figma's official MCP\.$/);
  });

  it("explains 403 as REST permission, not official MCP quota", () => {
    const msg = messageForStatus(403, { err: "Not allowed" });
    assert.match(msg, /403 Forbidden/);
    assert.match(msg, /not a seat\/tool-call quota from Figma's official MCP/);
  });

  it("explains webhook 403 as missing webhooks scope or plan", () => {
    const msg = messageForStatus(403, { err: "Invalid scope" }, undefined, "/v2/webhooks");
    assert.match(msg, /Webhooks v2/);
    assert.match(msg, /webhooks:read/);
    assert.match(msg, /webhooks:write/);
  });

  it("explains variables 403 as Enterprise + file_variables:read", () => {
    const msg = messageForStatus(403, { err: "Forbidden" }, undefined, "/v1/files/x/variables/local");
    assert.match(msg, /Enterprise/);
    assert.match(msg, /file_variables:read/);
    assert.match(msg, /get_variable_defs/);
  });

  it("explains 429 as REST rate limit with Retry-After", () => {
    const msg = messageForStatus(429, null, 12);
    assert.match(msg, /429 Too Many Requests/);
    assert.match(msg, /REST rate limit/);
    assert.match(msg, /not a seat\/tool-call quota/);
    assert.match(msg, /Retry after 12/);
  });
});

describe("parseRetryAfter", () => {
  it("parses integer seconds", () => {
    assert.equal(parseRetryAfter("8"), 8);
  });

  it("returns undefined for missing header", () => {
    assert.equal(parseRetryAfter(null), undefined);
  });
});
