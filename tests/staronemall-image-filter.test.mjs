import test from "node:test";
import assert from "node:assert/strict";

import {
  filterStaronemallDetailImageUrls,
  isStaronemallBannerImageUrl,
} from "../supabase/functions/_shared/staronemall-images.ts";

test("isStaronemallBannerImageUrl detects common non-product banner assets", () => {
  const bannerUrls = [
    "https://staronemall2.wisacdn.com/_data/banner/top_banner.jpg",
    "https://staronemall2.wisacdn.com/_data/editor/event/2026_preorder.jpg",
    "https://staronemall2.wisacdn.com/_data/attach/notice_delivery.png",
    "https://staronemall2.wisacdn.com/_data/attach/guide/refund_return.webp",
    "https://staronemall2.wisacdn.com/_data/attach/common/footer_cs.jpg",
  ];
  for (const url of bannerUrls) {
    assert.equal(isStaronemallBannerImageUrl(url), true, url);
  }
});

test("filterStaronemallDetailImageUrls keeps product detail images in order and removes banners", () => {
  const detail1 = "https://staronemall2.wisacdn.com/_data/attach/detail/album_detail_01.jpg";
  const detail2 = "https://staronemall2.wisacdn.com/_data/product/2026/05/product_contents_02.jpg";
  const actual = filterStaronemallDetailImageUrls([
    "https://staronemall2.wisacdn.com/_data/banner/top_banner.jpg",
    detail1,
    "https://staronemall2.wisacdn.com/_data/editor/event/event-banner.jpg",
    detail1,
    detail2,
    "https://staronemall2.wisacdn.com/_data/attach/guide/refund_return.webp",
  ]);

  assert.deepEqual(actual, [detail1, detail2]);
});
