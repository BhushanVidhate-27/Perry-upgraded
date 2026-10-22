/**
 * B2 Blackblaze cloud storage client for Perry.
 *
 * Wraps B2's native API (authorize, upload, download, list, delete) so Perry
 * can store files on B2 instead of Convex's built-in _storage or the local
 * disk. All functions take explicit credentials rather than reading env, so
 * they work from Convex actions, the local server, and scripts alike.
 *
 * B2's native API:
 *   1. b2_authorize_account  -> apiUrl, downloadUrl, authorizationToken
 *   2. b2_get_upload_url     -> uploadUrl, uploadAuthorizationToken (per bucket)
 *   3. b2_upload_file        -> POST to uploadUrl with the file bytes
 *   4. b2_download_file_by_name -> GET from downloadUrl/file/bucketName/name
 *   5. b2_list_file_names    -> list files in a bucket
 *   6. b2_delete_file_version -> delete a file version
 *
 * Tokens are cached in memory with a timestamp; they expire after 24 hours
 * (B2's default) and are refreshed on the next call.
 */

/** sha1 of a byte array, hex-encoded (B2 requires it on uploads). Uses Web Crypto so it works in Convex and Node.js. */
async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", bytes as unknown as BufferSource);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex;
}

export type B2Creds = {
  keyId: string;
  applicationKey: string;
  bucketName: string;
};

type B2Session = {
  apiUrl: string;
  downloadUrl: string;
  authorizationToken: string;
  accountId: string;
  /** The bucket's id, which every bucket-scoped call needs. A key limited to one bucket reports it here. */
  bucketId: string;
  authorizedAt: number;
};

type B2UploadUrl = {
  uploadUrl: string;
  uploadAuthorizationToken: string;
  bucketId: string;
};

/** In-memory session cache (one per process). */
const sessionCache = new Map<string, B2Session>();
/** In-memory upload URL cache (bucketName -> upload info). */
const uploadUrlCache = new Map<string, B2UploadUrl & { fetchedAt: number }>();

const SESSION_TTL_MS = 20 * 60 * 60 * 1000; // 20 hours (B2 tokens last 24h)
const UPLOAD_URL_TTL_MS = 20 * 60 * 60 * 1000;

/** Authorize with B2, cache the session. */
async function authorize(creds: B2Creds): Promise<B2Session> {
  const cacheKey = `${creds.keyId}:${creds.bucketName}`;
  const cached = sessionCache.get(cacheKey);
  if (cached && Date.now() - cached.authorizedAt < SESSION_TTL_MS) return cached;

  const auth = Buffer.from(`${creds.keyId}:${creds.applicationKey}`).toString("base64");
  const response = await fetch("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
    method: "GET",
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`B2 authorize failed (${response.status}): ${text}`);
  }
  const json = (await response.json()) as {
    apiUrl?: string;
    downloadUrl?: string;
    authorizationToken?: string;
    accountId?: string;
    absoluteMinimumPartSize?: number;
    recommendedPartSize?: number;
    allowed?: { bucketId?: string; bucketName?: string };
  };
  if (!json.apiUrl || !json.downloadUrl || !json.authorizationToken || !json.accountId) {
    throw new Error(`B2 authorize returned incomplete response: ${JSON.stringify(json).slice(0, 200)}`);
  }

  const session: B2Session = {
    apiUrl: json.apiUrl.replace(/\/+$/, ""),
    downloadUrl: json.downloadUrl.replace(/\/+$/, ""),
    authorizationToken: json.authorizationToken,
    accountId: json.accountId,
    bucketId: json.allowed?.bucketId ?? "",
    authorizedAt: Date.now(),
  };
  sessionCache.set(cacheKey, session);
  return session;
}

/** Get an upload URL for a bucket (cached per bucket). */
async function getUploadUrl(creds: B2Creds): Promise<B2UploadUrl> {
  const cacheKey = creds.bucketName;
  const cached = uploadUrlCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < UPLOAD_URL_TTL_MS) {
    return { uploadUrl: cached.uploadUrl, uploadAuthorizationToken: cached.uploadAuthorizationToken, bucketId: cached.bucketId };
  }

  const session = await authorize(creds);
  const response = await fetch(`${session.apiUrl}/b2api/v2/b2_get_upload_url`, {
    method: "POST",
    headers: {
      Authorization: session.authorizationToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ bucketId: session.bucketId || creds.bucketName }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`B2 get_upload_url failed (${response.status}): ${text}`);
  }
  const json = (await response.json()) as {
    uploadUrl?: string;
    uploadAuthorizationToken?: string;
    authorizationToken?: string;
    bucketId?: string;
  };
  const uploadAuthorizationToken = json.uploadAuthorizationToken ?? json.authorizationToken;
  if (!json.uploadUrl || !uploadAuthorizationToken || !json.bucketId) {
    throw new Error(`B2 get_upload_url returned incomplete response: ${JSON.stringify(json).slice(0, 200)}`);
  }

  const info: B2UploadUrl & { fetchedAt: number } = {
    uploadUrl: json.uploadUrl.replace(/\/+$/, ""),
    uploadAuthorizationToken,
    bucketId: json.bucketId,
    fetchedAt: Date.now(),
  };
  uploadUrlCache.set(cacheKey, info);
  return { uploadUrl: info.uploadUrl, uploadAuthorizationToken: info.uploadAuthorizationToken, bucketId: info.bucketId };
}

/** Upload file bytes to B2. Returns the file's B2 id. */
export async function b2Upload(
  creds: B2Creds,
  { fileName, contentType, bytes }: { fileName: string; contentType: string; bytes: Uint8Array },
): Promise<string> {
  const { uploadUrl, uploadAuthorizationToken } = await getUploadUrl(creds);
  const sha1 = await sha1Hex(bytes);

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: uploadAuthorizationToken,
      "X-Bz-File-Name": fileName,
      "Content-Type": contentType,
      "Content-Length": String(bytes.length),
      "X-Bz-Content-Sha1": sha1,
      "X-Bz-Info-Author": "perry",
    },
    body: Buffer.from(bytes),
  });
  if (!response.ok) {
    // Upload URLs expire; refresh once and retry.
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      uploadUrlCache.delete(creds.bucketName);
      const { uploadUrl: retryUrl, uploadAuthorizationToken: retryToken } = await getUploadUrl(creds);
      const retry = await fetch(retryUrl, {
        method: "POST",
        headers: {
          Authorization: retryToken,
          "X-Bz-File-Name": fileName,
          "Content-Type": contentType,
          "Content-Length": String(bytes.length),
          "X-Bz-Content-Sha1": sha1,
          "X-Bz-Info-Author": "perry",
        },
        body: Buffer.from(bytes),
      });
      if (!retry.ok) {
        const retryText = await retry.text().catch(() => "");
        throw new Error(`B2 upload retry failed (${retry.status}): ${retryText}`);
      }
      const json = (await retry.json()) as { fileId?: string; fileName?: string };
      if (!json.fileId) throw new Error(`B2 upload retry returned no fileId: ${JSON.stringify(json).slice(0, 200)}`);
      return json.fileId;
    }
    throw new Error(`B2 upload failed (${response.status}): ${text}`);
  }

  const json = (await response.json()) as { fileId?: string; fileName?: string };
  if (!json.fileId) throw new Error(`B2 upload returned no fileId: ${JSON.stringify(json).slice(0, 200)}`);
  return json.fileId;
}

/** Download a file from B2 by name. Returns the file bytes and content type. */
export async function b2Download(
  creds: B2Creds,
  fileName: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const session = await authorize(creds);
  // The bucket is private: the download host without a token answers 401.
  const response = await fetch(
    `${session.downloadUrl}/file/${encodeURIComponent(creds.bucketName)}/${encodeURIComponent(fileName)}`,
    { headers: { Authorization: session.authorizationToken } },
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`B2 download failed (${response.status}): ${text}`);
  }
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, contentType };
}

/** List files in a bucket, up to `max` entries starting after `startFileName`. */
export async function b2List(
  creds: B2Creds,
  { max = 100, startFileName }: { max?: number; startFileName?: string },
): Promise<Array<{ fileId: string; fileName: string; size: number; contentType?: string; uploadedAt: number }>> {
  const session = await authorize(creds);
  const body: { bucketId: string; maxFileCount?: number; startFileName?: string } = { bucketId: session.bucketId || creds.bucketName, maxFileCount: max };
  if (startFileName) body.startFileName = startFileName;

  const response = await fetch(`${session.apiUrl}/b2api/v2/b2_list_file_names`, {
    method: "POST",
    headers: {
      Authorization: session.authorizationToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`B2 list failed (${response.status}): ${text}`);
  }
  const json = (await response.json()) as {
    files?: Array<{
      fileId?: string;
      fileName?: string;
      size?: number;
      contentLength?: number;
      contentType?: string;
      uploadTimestamp?: number;
    }>;
    nextFileName?: string;
  };
  return (json.files ?? []).map((file) => ({
    fileId: file.fileId ?? "",
    fileName: file.fileName ?? "",
    size: file.size ?? file.contentLength ?? 0,
    contentType: file.contentType,
    uploadedAt: file.uploadTimestamp ?? 0,
  }));
}

/** Delete a file version from B2. */
export async function b2Delete(
  creds: B2Creds,
  { fileId, fileName }: { fileId: string; fileName: string },
): Promise<void> {
  const session = await authorize(creds);
  const response = await fetch(`${session.apiUrl}/b2api/v2/b2_delete_file_version`, {
    method: "POST",
    headers: {
      Authorization: session.authorizationToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ fileId, fileName }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`B2 delete failed (${response.status}): ${text}`);
  }
}

/** Check B2 credentials are valid by authorizing. Returns the account id. */
export async function b2Ping(creds: B2Creds): Promise<string> {
  const session = await authorize(creds);
  return session.accountId;
}

/** Clear cached sessions (useful when credentials change). */
export function b2ClearCache(): void {
  sessionCache.clear();
  uploadUrlCache.clear();
}
