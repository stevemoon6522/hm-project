import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCommitBatches,
  extractMappingRows,
  parseCsv,
  validateSkuMappings,
} from "../supabase/functions/_shared/sku-change-logic.ts";

const shops = [
  { region: "SG", shop_id: "1669858301", status: "active" },
  { region: "TW", shop_id: "1234567890", status: "active" },
  { region: "BR", shop_id: "1002269093", status: "banned" },
];

const catalog = [
  {
    region: "SG",
    shop_id: "1669858301",
    item_id: 1001,
    model_id: null,
    has_model: false,
    sku_level: "item",
    item_status: "NORMAL",
    item_name: "No model item",
    current_sku: "OLD-ITEM",
  },
  {
    region: "SG",
    shop_id: "1669858301",
    item_id: 2001,
    model_id: 90001,
    has_model: true,
    sku_level: "model",
    item_status: "NORMAL",
    item_name: "Model item",
    current_sku: "OLD-MODEL-A",
  },
  {
    region: "SG",
    shop_id: "1669858301",
    item_id: 2001,
    model_id: 90002,
    has_model: true,
    sku_level: "model",
    item_status: "NORMAL",
    item_name: "Model item",
    current_sku: "OLD-MODEL-B",
  },
];

test("parseCsv handles quoted cells and normalizes mapping rows", () => {
  const rows = parseCsv('region,shop_id,item_id,model_id,new_sku\nSG,1669858301,2001,90001,"NEW,SKU"\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].new_sku, "NEW,SKU");

  const mappingRows = extractMappingRows({ csv: 'region,item_id,new_sku\nSG,1001,ITEM-NEW\n' });
  assert.equal(mappingRows[0].region, "SG");
  assert.equal(mappingRows[0].item_id, 1001);
  assert.equal(mappingRows[0].new_sku, "ITEM-NEW");
});

test("validateSkuMappings rejects duplicate target SKUs per shop", () => {
  const mappingRows = extractMappingRows({
    mapping: [
      { region: "SG", item_id: 1001, new_sku: "DUP-SKU" },
      { region: "SG", item_id: 2001, model_id: 90001, new_sku: "DUP-SKU" },
    ],
  });
  const result = validateSkuMappings(mappingRows, catalog, shops);
  assert.equal(result.ok, false);
  assert(result.errors.some((e) => e.reason === "duplicate_target_sku"));
});

test("validateSkuMappings enforces banned shop and SKU length rules", () => {
  const mappingRows = extractMappingRows({
    mapping: [
      { region: "BR", shop_id: "1002269093", item_id: 1, new_sku: "BR-SHOULD-NOT-RUN" },
      { region: "SG", item_id: 1001, new_sku: "X".repeat(101) },
      { region: "SG", item_id: 1001, new_sku: "" },
    ],
  });
  const result = validateSkuMappings(mappingRows, catalog, shops);
  assert.equal(result.ok, false);
  assert(result.errors.some((e) => e.reason === "shop_banned"));
  assert(result.errors.some((e) => e.reason === "new_sku_too_long"));
  assert(result.errors.some((e) => e.reason === "new_sku_required"));
});

test("buildCommitBatches groups model updates by item and chunks at 50 models", () => {
  const modelItems = Array.from({ length: 52 }, (_, idx) => ({
    id: idx + 1,
    region: "SG",
    shop_id: "1669858301",
    item_id: 3001,
    model_id: 80000 + idx,
    has_model: true,
    sku_level: "model",
    new_sku: `MODEL-${idx + 1}`,
  }));
  const item = {
    id: 100,
    region: "SG",
    shop_id: "1669858301",
    item_id: 1001,
    model_id: null,
    has_model: false,
    sku_level: "item",
    new_sku: "ITEM-NEW",
  };

  const actions = buildCommitBatches([item, ...modelItems]);
  const itemActions = actions.filter((a) => a.kind === "update_item");
  const modelActions = actions.filter((a) => a.kind === "update_model");

  assert.equal(itemActions.length, 1);
  assert.equal(itemActions[0].endpoint, "/api/v2/product/update_item");
  assert.deepEqual(itemActions[0].payload, { item_id: 1001, item_sku: "ITEM-NEW" });

  assert.equal(modelActions.length, 2);
  assert.equal(modelActions[0].endpoint, "/api/v2/product/update_model");
  assert.equal(modelActions[0].payload.model.length, 50);
  assert.equal(modelActions[1].payload.model.length, 2);
});

test("deterministic API simulation uses official product SKU endpoints", async () => {
  const mappingRows = extractMappingRows({
    mapping: [
      { region: "SG", item_id: 1001, new_sku: "ITEM-NEW" },
      { region: "SG", item_id: 2001, model_id: 90001, new_sku: "MODEL-NEW-A" },
      { region: "SG", item_id: 2001, model_id: 90002, new_sku: "MODEL-NEW-B" },
    ],
  });
  const validation = validateSkuMappings(mappingRows, catalog, shops);
  assert.equal(validation.ok, true);

  const calls = [];
  for (const action of buildCommitBatches(validation.validItems)) {
    calls.push({ endpoint: action.endpoint, payload: action.payload });
  }

  assert.deepEqual(calls.map((c) => c.endpoint).sort(), [
    "/api/v2/product/update_item",
    "/api/v2/product/update_model",
  ]);
  assert.deepEqual(calls.find((c) => c.endpoint.endsWith("update_model")).payload, {
    item_id: 2001,
    model: [
      { model_id: 90001, model_sku: "MODEL-NEW-A" },
      { model_id: 90002, model_sku: "MODEL-NEW-B" },
    ],
  });
});
