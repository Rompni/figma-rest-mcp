import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseProjectId, parseTeamId } from "./parse-ids.js";

describe("parseTeamId", () => {
  it("parses team URLs and raw ids", () => {
    assert.equal(parseTeamId("https://www.figma.com/files/team/1535685101263221741"), "1535685101263221741");
    assert.equal(
      parseTeamId("https://www.figma.com/files/181033233908053158/team/1535685101263221741"),
      "1535685101263221741",
    );
    assert.equal(parseTeamId("1535685101263221741"), "1535685101263221741");
  });

  it("explains that /v1/me does not include team_id", () => {
    assert.throws(() => parseTeamId(""), /\/v1\/me/);
    assert.throws(() => parseTeamId("not-a-team"), /\/v1\/me/);
  });
});

describe("parseProjectId", () => {
  it("parses project URLs and raw ids", () => {
    assert.equal(parseProjectId("https://www.figma.com/files/project/99"), "99");
    assert.equal(parseProjectId("figma.com/project/42/Name"), "42");
    assert.equal(parseProjectId("42"), "42");
  });
});
