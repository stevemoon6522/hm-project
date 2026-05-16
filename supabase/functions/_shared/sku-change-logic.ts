// @ts-nocheck
export const BANNED_SHOP_IDS = new Set(["1002269093"]);
export const DEFAULT_OPERATING_REGIONS = ["SG", "TW", "TH", "MY", "PH", "BR"];
export const MODEL_BATCH_SIZE = 50;
export const SKU_MAX_LENGTH = 100;

export function normalizeRegion(value) {
  return String(value || "").trim().toUpperCase();
}

export function normalizeShopId(value) {
  const out = String(value ?? "").trim();
  return out || "";
}

export function normalizeSku(value) {
  return String(value ?? "").trim();
}

export function parsePositiveInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readCsvCell(text, start) {
  let i = start;
  let out = "";
  if (text[i] === '"') {
    i += 1;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"' && text[i + 1] === '"') {
        out += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        i += 1;
        break;
      }
      out += ch;
      i += 1;
    }
    return { value: out, next: i };
  }
  while (i < text.length && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
    out += text[i];
    i += 1;
  }
  return { value: out.trim(), next: i };
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let i = 0;
  const input = String(text || "").replace(/^\uFEFF/, "");
  while (i < input.length) {
    const cell = readCsvCell(input, i);
    row.push(cell.value);
    i = cell.next;
    if (input[i] === ",") {
      i += 1;
      continue;
    }
    if (input[i] === "\r" && input[i + 1] === "\n") i += 2;
    else if (input[i] === "\r" || input[i] === "\n") i += 1;
    rows.push(row);
    row = [];
  }
  if (row.length > 0) rows.push(row);
  const nonEmpty = rows.filter((r) => r.some((c) => String(c || "").trim() !== ""));
  if (nonEmpty.length === 0) return [];
  const headers = nonEmpty[0].map((h) => String(h || "").trim().toLowerCase());
  return nonEmpty.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => {
      if (h) obj[h] = r[idx] ?? "";
    });
    return obj;
  });
}

export function extractMappingRows(body) {
  const rows = [];
  if (Array.isArray(body?.mapping)) rows.push(...body.mapping);
  if (Array.isArray(body?.rows)) rows.push(...body.rows);
  if (typeof body?.csv === "string" && body.csv.trim()) rows.push(...parseCsv(body.csv));
  return rows.map((raw, idx) => ({
    client_ref: String(raw.client_ref ?? raw.ref ?? raw.id ?? `row-${idx + 1}`),
    region: normalizeRegion(raw.region ?? raw.market),
    shop_id: normalizeShopId(raw.shop_id ?? raw.shopId),
    item_id: parsePositiveInt(raw.item_id ?? raw.itemId),
    model_id: parsePositiveInt(raw.model_id ?? raw.modelId),
    new_sku: normalizeSku(raw.new_sku ?? raw.target_sku ?? raw.sku ?? raw.model_sku ?? raw.item_sku),
    raw,
  }));
}

export function catalogTargetKey(row) {
  return `${normalizeShopId(row.shop_id)}:${Number(row.item_id) || 0}:${Number(row.model_id) || 0}`;
}

export function targetIdentity(row) {
  return `${normalizeShopId(row.shop_id)}:${Number(row.item_id) || 0}:${Number(row.model_id) || 0}`;
}

export function buildCatalogIndex(catalogRows) {
  const out = new Map();
  for (const row of catalogRows || []) {
    out.set(catalogTargetKey(row), row);
  }
  return out;
}

function makeShopIndexes(shops) {
  const byRegion = new Map();
  const byShop = new Map();
  for (const shop of shops || []) {
    const normalized = {
      ...shop,
      region: normalizeRegion(shop.region),
      shop_id: normalizeShopId(shop.shop_id),
      status: String(shop.status || ""),
    };
    if (!normalized.shop_id) continue;
    byShop.set(normalized.shop_id, normalized);
    if (normalized.region && !byRegion.has(normalized.region)) byRegion.set(normalized.region, normalized);
  }
  return { byRegion, byShop };
}

export function resolveMappingShop(row, shops) {
  const { byRegion, byShop } = makeShopIndexes(shops);
  if (row.shop_id && byShop.has(row.shop_id)) return byShop.get(row.shop_id);
  if (row.region && byRegion.has(row.region)) return byRegion.get(row.region);
  if (!row.shop_id && !row.region && shops.length === 1) {
    const only = shops[0];
    return { ...only, region: normalizeRegion(only.region), shop_id: normalizeShopId(only.shop_id) };
  }
  return null;
}

export function validateSkuMappings(mappingRows, catalogRows, shops) {
  const catalog = buildCatalogIndex(catalogRows);
  const errors = [];
  const validItems = [];
  const duplicateTargetSeen = new Map();
  const skuSeen = new Map();

  for (const row of mappingRows || []) {
    const rowErrors = [];
    const shop = resolveMappingShop(row, shops || []);
    if (!shop) rowErrors.push("shop_not_found");
    const region = normalizeRegion(shop?.region || row.region);
    const shopId = normalizeShopId(shop?.shop_id || row.shop_id);
    if (BANNED_SHOP_IDS.has(shopId) || String(shop?.status || "").toLowerCase() === "banned") rowErrors.push("shop_banned");
    if (!DEFAULT_OPERATING_REGIONS.includes(region)) rowErrors.push("region_out_of_scope");
    if (!row.item_id) rowErrors.push("item_id_required");
    if (!row.new_sku) rowErrors.push("new_sku_required");
    if (row.new_sku && row.new_sku.length > SKU_MAX_LENGTH) rowErrors.push("new_sku_too_long");

    const candidate = { ...row, region, shop_id: shopId };
    const targetKey = targetIdentity(candidate);
    if (duplicateTargetSeen.has(targetKey)) {
      rowErrors.push("duplicate_target_row");
      errors.push({ client_ref: duplicateTargetSeen.get(targetKey), target_key: targetKey, reason: "duplicate_target_row" });
    } else {
      duplicateTargetSeen.set(targetKey, row.client_ref);
    }

    const catalogRow = catalog.get(targetKey);
    if (!catalogRow && row.item_id) rowErrors.push("target_not_found_in_catalog");
    if (catalogRow?.has_model && !row.model_id) rowErrors.push("model_id_required_for_model_item");
    if (catalogRow && !catalogRow.has_model && row.model_id) rowErrors.push("model_id_not_allowed_for_item_sku");

    if (row.new_sku) {
      const skuKey = `${shopId}:${row.new_sku.toUpperCase()}`;
      const seen = skuSeen.get(skuKey);
      if (seen && seen.target_key !== targetKey) {
        rowErrors.push("duplicate_target_sku");
        errors.push({ client_ref: seen.client_ref, shop_id: shopId, new_sku: row.new_sku, reason: "duplicate_target_sku" });
      } else if (!seen) {
        skuSeen.set(skuKey, { client_ref: row.client_ref, target_key: targetKey });
      }
    }

    for (const reason of rowErrors) {
      errors.push({ client_ref: row.client_ref, shop_id: shopId || null, region: region || null, item_id: row.item_id, model_id: row.model_id, reason });
    }

    if (rowErrors.length === 0) {
      validItems.push({
        client_ref: row.client_ref,
        region,
        shop_id: shopId,
        item_id: row.item_id,
        model_id: catalogRow.has_model ? row.model_id : null,
        has_model: !!catalogRow.has_model,
        sku_level: catalogRow.has_model ? "model" : "item",
        item_status: catalogRow.item_status || "",
        item_name: catalogRow.item_name || "",
        old_sku: catalogRow.current_sku || "",
        new_sku: row.new_sku,
      });
    }
  }

  return {
    ok: errors.length === 0 && validItems.length > 0,
    errors,
    validItems,
    summary: {
      mapping_rows: (mappingRows || []).length,
      valid_rows: validItems.length,
      error_rows: new Set(errors.map((e) => e.client_ref)).size,
      error_count: errors.length,
    },
  };
}

export function buildCommitBatches(items) {
  const actions = [];
  const modelGroups = new Map();
  for (const item of items || []) {
    if (item.sku_level === "model" || item.has_model) {
      const key = `${item.region}:${item.shop_id}:${item.item_id}`;
      if (!modelGroups.has(key)) {
        modelGroups.set(key, {
          kind: "update_model",
          region: item.region,
          shop_id: item.shop_id,
          item_id: item.item_id,
          items: [],
        });
      }
      modelGroups.get(key).items.push(item);
      continue;
    }
    actions.push({
      kind: "update_item",
      endpoint: "/api/v2/product/update_item",
      region: item.region,
      shop_id: item.shop_id,
      item_id: item.item_id,
      items: [item],
      payload: { item_id: item.item_id, item_sku: item.new_sku },
    });
  }

  for (const group of modelGroups.values()) {
    const sorted = [...group.items].sort((a, b) => Number(a.model_id) - Number(b.model_id));
    for (let i = 0; i < sorted.length; i += MODEL_BATCH_SIZE) {
      const chunk = sorted.slice(i, i + MODEL_BATCH_SIZE);
      actions.push({
        kind: "update_model",
        endpoint: "/api/v2/product/update_model",
        region: group.region,
        shop_id: group.shop_id,
        item_id: group.item_id,
        items: chunk,
        payload: {
          item_id: group.item_id,
          model: chunk.map((item) => ({ model_id: item.model_id, model_sku: item.new_sku })),
        },
      });
    }
  }

  return actions;
}

export function summarizeStatuses(rows) {
  const out = {};
  for (const row of rows || []) {
    const status = row.status || "unknown";
    out[status] = (out[status] || 0) + 1;
  }
  return out;
}

export function isTransientShopeeError(result) {
  const text = `${result?.error || ""} ${result?.message || ""}`.toLowerCase();
  return /system_busy|temporar|timeout|network|too_many|rate|server|inner|internal|unavailable/.test(text);
}
