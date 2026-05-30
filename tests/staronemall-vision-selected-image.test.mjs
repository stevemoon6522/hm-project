import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("supabase/functions/staronemall-vision/index.ts", "utf8");
const edgeCopy = readFileSync("edge-functions/staronemall-vision/index.ts", "utf8");

test("staronemall vision extraction accepts an operator-selected detail image", () => {
  for (const [name, text] of [["supabase", source], ["edge", edgeCopy]]) {
    assert.match(text, /image_url\?: unknown/, `${name} body type should accept image_url`);
    assert.match(text, /requestedImageUrl/, `${name} should parse requestedImageUrl`);
    assert.match(text, /requestedImageUrl \?\? pickBestDetailImage/, `${name} should prefer requestedImageUrl over automatic selection`);
    assert.match(text, /!requestedImageUrl/, `${name} cache should be bypassable when a selected image is supplied`);
    assert.match(text, /image_url_used: imageUrl/, `${name} should report the selected image URL used`);
  }
});
