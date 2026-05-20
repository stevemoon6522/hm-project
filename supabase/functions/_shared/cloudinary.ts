// @ts-nocheck
// Shared Cloudinary signed-upload helper.
//
// Extracted from joom-bridge/index.ts in Step 1a (plan v2.2 §C.0) so that
// the upcoming ingest / starone-crawl / yes24-crawl Edge Functions can
// share the same authenticated upload path. joom-bridge re-imports this
// module unchanged in behavior — the goal of this extraction is purely
// to dedupe before Step 1b adds new consumers.
//
// Codex P1 #7 deploy ordering: this module MUST be deployed alongside
// joom-bridge BEFORE any new function that imports from `_shared/cloudinary.ts`.
// The deployer enforces that order: deploy joom-bridge (with the new import),
// smoke-test it, THEN deploy ingest / crawler functions.
//
// Required env vars on every consuming Edge Function:
//   CLOUDINARY_CLOUD_NAME
//   CLOUDINARY_API_KEY
//   CLOUDINARY_API_SECRET
// Without all three, uploadToCloudinary returns null (caller must handle).

async function sha1Hex(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  // @ts-ignore
  const hashBuffer = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface CloudinaryUploadOptions {
  /** Cloudinary folder path. */
  folder: string;
  /**
   * Optional public_id suffix. When omitted a random `{timestamp}-{rand}`
   * id is generated under `${folder}/`. When provided, used verbatim as
   * `${folder}/${publicIdSuffix}` so callers can build their own naming.
   */
  publicIdSuffix?: string;
  /** MIME type to declare in the multipart form. Defaults to image/jpeg. */
  contentType?: string;
  /** Filename for the multipart part. Defaults to "upload.jpg". */
  filename?: string;
}

export interface CloudinaryUploadResult {
  ok: boolean;
  secure_url?: string;
  public_id?: string;
  bytes?: number;
  width?: number;
  height?: number;
  format?: string;
  error?: string;
}

/**
 * Upload raw bytes to Cloudinary using signed upload.
 *
 * Returns { ok: true, secure_url, public_id, ... } on success.
 * Returns { ok: false, error } when env vars are missing or Cloudinary
 * rejects the upload.
 */
export async function uploadToCloudinary(
  imageData: Uint8Array,
  options: CloudinaryUploadOptions,
): Promise<CloudinaryUploadResult> {
  // @ts-ignore
  const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME") || "";
  // @ts-ignore
  const apiKey = Deno.env.get("CLOUDINARY_API_KEY") || "";
  // @ts-ignore
  const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET") || "";
  if (!cloudName || !apiKey || !apiSecret) {
    return { ok: false, error: "cloudinary_env_missing" };
  }

  const folder = options.folder;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const suffix =
    options.publicIdSuffix ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const publicId = `${folder}/${suffix}`;
  const paramsToSign = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const signature = await sha1Hex(paramsToSign);

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([imageData], { type: options.contentType || "image/jpeg" }),
    options.filename || "upload.jpg",
  );
  formData.append("api_key", apiKey);
  formData.append("timestamp", timestamp);
  formData.append("signature", signature);
  formData.append("public_id", publicId);
  formData.append("folder", folder);

  try {
    const r = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
      { method: "POST", body: formData },
    );
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return {
        ok: false,
        error: `cloudinary_http_${r.status}`,
        secure_url: undefined,
        // pack the response body into error for debugging
        // (Cloudinary returns JSON with {error:{message}})
        ...(text ? { _raw: text.slice(0, 500) } : {}),
      };
    }
    const j = await r.json();
    return {
      ok: true,
      secure_url: j.secure_url as string,
      public_id: j.public_id as string,
      bytes: j.bytes,
      width: j.width,
      height: j.height,
      format: j.format,
    };
  } catch (e) {
    return {
      ok: false,
      error: "cloudinary_exception",
      _raw: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Legacy joom-bridge tile API. Returns only the URL (or null on failure)
 * so existing call sites in joom-bridge can swap import paths without
 * changing call shape.
 *
 * New code should prefer uploadToCloudinary() above for richer error info.
 */
export async function uploadTileToCloudinary(
  imageData: Uint8Array,
): Promise<string | null> {
  const result = await uploadToCloudinary(imageData, {
    folder: "joom-tiles",
    contentType: "image/jpeg",
    filename: "tile.jpg",
  });
  return result.ok ? result.secure_url || null : null;
}
