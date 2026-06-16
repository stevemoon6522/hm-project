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

test("staronemall vision extraction prepares oversize images before Claude", () => {
  for (const [name, text] of [["supabase", source], ["edge", edgeCopy]]) {
    assert.match(text, /const CLAUDE_MAX_IMAGE_EDGE = 8000/, `${name} should encode Claude's documented max edge`);
    assert.match(text, /const CLAUDE_SAFE_IMAGE_EDGE = 7600/, `${name} should leave margin below Claude's max edge`);
    assert.match(text, /async function readImageDimensions/, `${name} should inspect source image dimensions`);
    assert.match(text, /function parseJpegSize/, `${name} should read JPEG dimensions without full image decode`);
    assert.match(text, /function parsePngSize/, `${name} should read PNG dimensions without full image decode`);
    assert.match(text, /function parseWebpSize/, `${name} should read WebP dimensions without full image decode`);
    assert.match(text, /function buildClaudeSafeImageUrls/, `${name} should build Claude-safe image sources`);
    assert.match(text, /c_crop,w_\$\{w\},h_\$\{h\},x_\$\{x\},y_\$\{y\}/, `${name} should split oversized images into crop tiles`);
    assert.match(text, /CLAUDE_MAX_CROP_TILES/, `${name} should cap crop tile fan-out`);
    assert.match(text, /\.\.\.imageSources\.map/, `${name} should send prepared images as multiple Claude image blocks`);
    assert.match(text, /prepareClaudeVisionImages\(imageUrl\)/, `${name} should prepare images before calling Claude`);
    assert.match(text, /callClaudeVision\(visionImages\.sources\)/, `${name} should pass prepared image sources to Claude`);
    assert.match(text, /image_transform_mode/, `${name} should return image transform metadata for diagnosis`);
    assert.match(text, /image_source_count/, `${name} should return image source count for diagnosis`);
    assert.match(text, /image_original_dimensions/, `${name} should return original dimensions for diagnosis`);
  }
});
