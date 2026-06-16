import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("supabase/functions/staronemall-vision/index.ts", "utf8");
const edgeCopy = readFileSync("edge-functions/staronemall-vision/index.ts", "utf8");
const imageFilter = readFileSync("supabase/functions/_shared/staronemall-images.ts", "utf8");

test("staronemall vision extraction accepts operator-selected detail images", () => {
  for (const [name, text] of [["supabase", source], ["edge", edgeCopy]]) {
    assert.match(text, /image_url\?: unknown/, `${name} body type should accept image_url`);
    assert.match(text, /image_urls\?: unknown/, `${name} body type should accept image_urls`);
    assert.match(text, /requestedImageUrl/, `${name} should parse requestedImageUrl`);
    assert.match(text, /parseRequestedImageUrls/, `${name} should parse selected image URL arrays`);
    assert.match(text, /imageUrlsToUse\[0\] \?\? pickBestDetailImage/, `${name} should prefer selected image URLs over automatic selection`);
    assert.match(text, /return pool\[pool\.length - 1\] \|\| null/, `${name} automatic fallback should prefer the last product-detail image`);
    assert.match(text, /!hasRequestedImages/, `${name} cache should be bypassable when selected images are supplied`);
    assert.match(text, /image_url_used: imageUrl/, `${name} should report the selected image URL used`);
    assert.match(text, /image_urls_used: imageUrls/, `${name} should report all selected image URLs used`);
    assert.match(text, /multi_image:\$\{modes\.join\("\+"\)\}/, `${name} should label multi-image extraction mode`);
  }
});

test("staronemall vision filters StarOneMall order-process guide images", () => {
  assert.match(imageFilter, /a1533f8be6b07bff4669533902948b19/, "shared image filter should remove the known order-process guide image");
  assert.match(edgeCopy, /a1533f8be6b07bff4669533902948b19/, "edge copy should remove the known order-process guide image");
});

test("staronemall vision extraction prepares oversize images before Claude", () => {
  for (const [name, text] of [["supabase", source], ["edge", edgeCopy]]) {
    assert.match(text, /const CLAUDE_MAX_IMAGE_EDGE = 8000/, `${name} should encode Claude's documented max edge`);
    assert.match(text, /const CLAUDE_SAFE_IMAGE_EDGE = 7600/, `${name} should leave margin below Claude's max edge`);
    assert.match(text, /const IMAGE_DIMENSION_PROBE_BYTES = 262143/, `${name} should read past large JPEG metadata blocks`);
    assert.match(text, /async function readImageDimensions/, `${name} should inspect source image dimensions`);
    assert.match(text, /function parseJpegSize/, `${name} should read JPEG dimensions without full image decode`);
    assert.match(text, /function parsePngSize/, `${name} should read PNG dimensions without full image decode`);
    assert.match(text, /function parseWebpSize/, `${name} should read WebP dimensions without full image decode`);
    assert.match(text, /function buildClaudeSafeImageUrls/, `${name} should build Claude-safe image sources`);
    assert.match(text, /c_crop,w_\$\{w\},h_\$\{h\},x_\$\{x\},y_\$\{y\}/, `${name} should split oversized images into crop tiles`);
    assert.match(text, /CLAUDE_MAX_CROP_TILES/, `${name} should cap crop tile fan-out`);
    assert.match(text, /\.\.\.imageSources\.map/, `${name} should send prepared images as multiple Claude image blocks`);
    assert.match(text, /prepareClaudeVisionImages\(selectedImageUrl\)/, `${name} should prepare selected images before calling Claude`);
    assert.match(text, /callClaudeVision\(visionImages\.sources\)/, `${name} should pass prepared image sources to Claude`);
    assert.match(text, /image_transform_mode/, `${name} should return image transform metadata for diagnosis`);
    assert.match(text, /image_source_count/, `${name} should return image source count for diagnosis`);
    assert.match(text, /image_original_dimensions/, `${name} should return original dimensions for diagnosis`);
  }
});

test("staronemall vision extraction retries blocked image URLs as base64 tiles", () => {
  for (const [name, text] of [["supabase", source], ["edge", edgeCopy]]) {
    assert.match(text, /function parseClientImageDataUrls/, `${name} should accept browser-prepared image tiles`);
    assert.match(text, /image_data_urls\?: unknown/, `${name} request body should accept image_data_urls`);
    assert.match(text, /image_transform_mode: "client_base64_tiles"/, `${name} should label client base64 tile extraction`);
    assert.match(text, /type: "base64"; media_type: "image\/jpeg" \| "image\/png" \| "image\/webp"; data: string/, `${name} should support Claude base64 image sources`);
    assert.match(text, /function isClaudeDownloadError/, `${name} should detect Claude URL download failures`);
    assert.match(text, /async function fetchImageBytes/, `${name} should fetch blocked CDN images server-side`);
    assert.match(text, /async function fetchImageBytesByRange/, `${name} should recover CDN images that reset full downloads`);
    assert.match(text, /function edgeFetchImageUrl/, `${name} should normalize wisacdn fetches for the Edge runtime`);
    assert.match(text, /Range: "bytes=0-0"/, `${name} should probe range support before full image fallback`);
    assert.match(text, /Range: `bytes=\$\{start\}-\$\{end\}`/, `${name} should download fallback images in chunks`);
    assert.match(text, /const IMAGE_FETCH_CHUNK_BYTES = 1024 \* 1024/, `${name} should keep range chunks small enough for flaky CDNs`);
    assert.match(text, /prepareClaudeVisionCloudinaryUploadImages/, `${name} should upload CDN-blocked images before retrying Claude`);
    assert.match(text, /uploadToCloudinary|uploadVisionImageToCloudinary/, `${name} should use signed Cloudinary upload for heavy fallback images`);
    assert.match(text, /cloudinary_upload_crop_tiles/, `${name} should tile uploaded Cloudinary images without Edge-side decoding`);
    assert.match(text, /prepareClaudeVisionBase64Images/, `${name} should prepare a base64 fallback`);
    assert.match(text, /deno\.land\/x\/imagescript@1\.3\.0/, `${name} should decode and tile images in the Edge runtime`);
    assert.match(text, /tile\.crop\(x, y, w, h\)/, `${name} should crop oversized images before base64 upload`);
    assert.match(text, /tile\.encodeJPEG\(90\)/, `${name} should re-encode fallback tiles as JPEG`);
    assert.match(text, /image_transform_mode: tileCount > 1 \? "base64_crop_tiles" : "base64_jpeg"/, `${name} should expose base64 fallback mode`);
    assert.match(text, /if \(!isClaudeDownloadError\(urlError\)\) throw urlError/, `${name} should only retry expected download failures`);
    assert.match(text, /componentsEn = await callClaudeVision\(visionImages\.sources\)/, `${name} should call Claude again with fallback sources`);
  }
});
