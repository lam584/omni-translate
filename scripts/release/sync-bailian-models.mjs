import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = "bailian-model-metadata/v1";
export const DEFAULT_METADATA_PATH = path.join("contracts", "bailian-model-metadata.generated.json");

export const ALLOWED_HOST_PATTERNS = [
  "dashscope.aliyuncs.com",
  "*.cn-beijing.maas.aliyuncs.com",
  "dashscope-intl.aliyuncs.com",
  "*.ap-southeast-1.maas.aliyuncs.com",
];

const VALID_MODALITIES = new Set(["Text", "Image", "Audio", "Video"]);
const MODALITY_CASE_MAP = new Map([
  ["text", "Text"],
  ["image", "Image"],
  ["audio", "Audio"],
  ["video", "Video"],
]);

export function isAllowedHost(hostname) {
  if (typeof hostname !== "string" || !hostname) return false;
  const host = hostname.trim().toLowerCase();
  return ALLOWED_HOST_PATTERNS.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      if (!host.endsWith(suffix)) return false;
      const prefix = host.slice(0, -suffix.length);
      return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(prefix);
    }
    return host === pattern;
  });
}

export function sanitizeErrorMessage(message) {
  if (typeof message !== "string") return String(message);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/gi, "[REDACTED_API_KEY]");
}

export function normalizeModality(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const canonical = MODALITY_CASE_MAP.get(trimmed.toLowerCase());
  return canonical || (VALID_MODALITIES.has(trimmed) ? trimmed : null);
}

export function normalizeModalitiesList(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,/|]/);
  const normalized = new Set();
  for (const item of list) {
    const norm = normalizeModality(item);
    if (norm) normalized.add(norm);
  }
  return [...normalized].sort();
}

export function normalizeCategories(rawCategories) {
  if (!Array.isArray(rawCategories)) return [];
  const set = new Set();
  for (const item of rawCategories) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) set.add(trimmed);
    } else if (item && typeof item === "object") {
      const code = item.category ?? item.category_code ?? item.code ?? item.name;
      if (typeof code === "string") {
        const trimmed = code.trim();
        if (trimmed) set.add(trimmed);
      }
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function parseBailianModel(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid model item: expected an object");
  }
  const modelId = raw.model ?? raw.model_id ?? raw.id;
  if (typeof modelId !== "string" || !modelId.trim()) {
    throw new Error("Model item missing valid exact model identifier (model, model_id, or id)");
  }

  const categories = normalizeCategories(raw.capabilities);
  const requestModalities = normalizeModalitiesList(
    raw.inference_metadata?.request_modality ?? raw.request_modality,
  );
  const responseModalities = normalizeModalitiesList(
    raw.inference_metadata?.response_modality ?? raw.response_modality,
  );

  return {
    modelId: modelId.trim(),
    categories,
    requestModalities,
    responseModalities,
  };
}

export function transformBailianModelsResponse(modelsArray) {
  if (!Array.isArray(modelsArray)) {
    throw new Error("Expected output.models to be an array");
  }
  const models = modelsArray.map(parseBailianModel);
  models.sort((a, b) => a.modelId.localeCompare(b.modelId));
  return models;
}

export function validateBailianModelMetadata(data) {
  const errors = [];
  if (!data || typeof data !== "object") {
    return ["Metadata root must be an object"];
  }
  if (data.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`Invalid schemaVersion: expected ${SCHEMA_VERSION}, got ${data.schemaVersion}`);
  }
  if (data.fetchedAt !== null && (typeof data.fetchedAt !== "string" || Number.isNaN(Date.parse(data.fetchedAt)))) {
    errors.push(`Invalid fetchedAt timestamp: ${data.fetchedAt}`);
  }
  if (data.fetchedAt === null && Array.isArray(data.models) && data.models.length > 0) {
    errors.push("fetchedAt cannot be null when models are present");
  }
  if (data.region !== null && typeof data.region !== "string") {
    errors.push("region must be a string or null");
  }
  if (data.workspaceId !== null && typeof data.workspaceId !== "string") {
    errors.push("workspaceId must be a string or null");
  }
  if (!Array.isArray(data.models)) {
    errors.push("models must be an array");
    return errors;
  }

  let previousId = "";
  for (let i = 0; i < data.models.length; i++) {
    const item = data.models[i];
    if (!item || typeof item !== "object") {
      errors.push(`models[${i}] must be an object`);
      continue;
    }
    if (typeof item.modelId !== "string" || !item.modelId.trim()) {
      errors.push(`models[${i}].modelId must be a non-empty string`);
    } else {
      if (previousId && item.modelId.localeCompare(previousId) < 0) {
        errors.push(`models must be sorted deterministically: ${item.modelId} appeared after ${previousId}`);
      } else if (previousId === item.modelId) {
        errors.push(`duplicate modelId found: ${item.modelId}`);
      }
      previousId = item.modelId;
    }
    if (!Array.isArray(item.categories) || item.categories.some((c) => typeof c !== "string")) {
      errors.push(`models[${i}].categories must be an array of strings`);
    }
    if (
      !Array.isArray(item.requestModalities) ||
      item.requestModalities.some((m) => !VALID_MODALITIES.has(m))
    ) {
      errors.push(`models[${i}].requestModalities contains invalid modality (must be Text, Image, Audio, Video)`);
    }
    if (
      !Array.isArray(item.responseModalities) ||
      item.responseModalities.some((m) => !VALID_MODALITIES.has(m))
    ) {
      errors.push(`models[${i}].responseModalities contains invalid modality (must be Text, Image, Audio, Video)`);
    }
  }

  return errors;
}

export function resolveEndpointAndRegion(options = {}) {
  const rawUrl = options.endpoint || options.baseUrl || "https://dashscope.aliyuncs.com/api/v1/models";
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid endpoint URL: ${rawUrl}`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`Disallowed protocol ${parsed.protocol}; only https: is permitted`);
  }

  if (!isAllowedHost(parsed.hostname)) {
    throw new Error(`Host "${parsed.hostname}" is not in the Bailian allowlist: ${ALLOWED_HOST_PATTERNS.join(", ")}`);
  }
  if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash ||
      !["/api/v1", "/api/v1/", "/api/v1/models", "/compatible-mode/v1", "/compatible-mode/v1/", "/compatible-mode/v1/models"].includes(parsed.pathname)) {
    throw new Error("Disallowed model metadata endpoint path or URL parameters");
  }

  let region = options.region || null;
  let workspaceId = options.workspaceId || null;

  if (parsed.hostname.includes("cn-beijing")) {
    region = region || "cn-beijing";
  } else if (parsed.hostname.includes("ap-southeast-1")) {
    region = region || "ap-southeast-1";
  } else if (parsed.hostname === "dashscope.aliyuncs.com") {
    region = region || "cn-beijing";
  } else if (parsed.hostname === "dashscope-intl.aliyuncs.com") {
    region = region || "ap-southeast-1";
  }

  if (!workspaceId && parsed.hostname.endsWith(".maas.aliyuncs.com")) {
    const parts = parsed.hostname.split(".");
    if (parts.length >= 5) {
      workspaceId = parts[0];
    }
  }

  const expectedHost = workspaceId
    ? `${workspaceId}.${region}.maas.aliyuncs.com`
    : region === "cn-beijing" ? "dashscope.aliyuncs.com" : "dashscope-intl.aliyuncs.com";
  if (parsed.hostname !== expectedHost) {
    throw new Error("Model metadata endpoint does not match the configured region and workspace");
  }
  const basePath = "/api/v1/models";
  return {
    hostname: parsed.hostname,
    basePath,
    region,
    workspaceId,
  };
}

export function resolveApiKey(options = {}) {
  const envCandidates = ["DASHSCOPE_API_KEY", "BAILIAN_API_KEY", "OMNI_TEST_DASHSCOPE_API_KEY"];
  for (const envName of envCandidates) {
    const val = process.env[envName];
    if (val && typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed && !/^<.*>$/.test(trimmed)) {
        return trimmed;
      }
    }
  }
  return null;
}

export async function fetchBailianModels(options = {}) {
  if (options.fixture) {
    return loadFixtureModels(options.fixture, options);
  }

  const apiKey = resolveApiKey(options);
  if (!apiKey) {
    throw new Error(
      "No Bailian/DashScope API key found in environment (DASHSCOPE_API_KEY, BAILIAN_API_KEY, or OMNI_TEST_DASHSCOPE_API_KEY).",
    );
  }

  const { hostname, basePath, region, workspaceId } = resolveEndpointAndRegion(options);
  const pageSize = Number.isInteger(options.pageSize) && options.pageSize > 0 ? options.pageSize : 100;
  let pageNo = 1;
  const rawModels = [];
  let expectedTotal = null;

  while (true) {
    const query = `page_no=${pageNo}&page_size=${pageSize}`;
    const requestPath = `${basePath}?${query}`;
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    };
    if (workspaceId) {
      headers["X-DashScope-WorkSpace"] = workspaceId;
    }

    const pageData = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname,
          path: requestPath,
          method: "GET",
          headers,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            if (res.statusCode !== 200) {
              return reject(
                new Error(`API responded with HTTP ${res.statusCode}`),
              );
            }
            try {
              const parsed = JSON.parse(body);
              resolve(parsed);
            } catch (err) {
              reject(new Error(`Failed to parse response JSON: ${err.message}`));
            }
          });
        },
      );
      req.on("error", (err) => reject(new Error(sanitizeErrorMessage(err.message))));
      req.end();
    });

    if (!pageData || typeof pageData !== "object") {
      throw new Error("Invalid API response: payload is not an object");
    }
    if (pageData.code && pageData.code !== "200" && pageData.code !== 200 && pageData.code !== "Success") {
      throw new Error(
        sanitizeErrorMessage(`API error: ${pageData.code} - ${pageData.message ?? "Unknown error"}`),
      );
    }
    const output = pageData.output;
    if (!output || typeof output !== "object") {
      throw new Error("API response is missing output object");
    }
    if (!Array.isArray(output.models)) {
      throw new Error("API response output.models is not an array");
    }

    if (!Number.isSafeInteger(output.total) || output.total < 0 || output.total > 100_000 ||
        (expectedTotal !== null && output.total !== expectedTotal) ||
        (output.page_no !== undefined && output.page_no !== pageNo)) {
      throw new Error("Invalid or inconsistent output.total/page_no in model metadata response");
    }
    expectedTotal = output.total;
    rawModels.push(...output.models);
    if (rawModels.length === expectedTotal) break;
    if (rawModels.length > expectedTotal || output.models.length === 0 || pageNo >= 1000) {
      throw new Error("Incomplete or inconsistent model metadata pagination");
    }
    pageNo += 1;
  }

  if (expectedTotal !== null && rawModels.length !== expectedTotal) {
    throw new Error(
      `Incomplete model list: expected ${expectedTotal} models from output.total, but received ${rawModels.length} models across pages`,
    );
  }

  const models = transformBailianModelsResponse(rawModels);
  return {
    schemaVersion: SCHEMA_VERSION,
    fetchedAt: new Date().toISOString(),
    region,
    workspaceId,
    models,
  };
}

export function loadFixtureModels(fixturePath, options = {}) {
  const fullPath = path.resolve(process.cwd(), fixturePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Fixture file not found: ${fixturePath}`);
  }
  const content = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  let rawModels = [];
  let expectedTotal = null;
  let region = options.region ?? "cn-beijing";
  let workspaceId = options.workspaceId ?? null;

  if (Array.isArray(content)) {
    for (const page of content) {
      if (page.output && Array.isArray(page.output.models)) {
        if (expectedTotal === null && typeof page.output.total === "number") {
          expectedTotal = page.output.total;
        }
        rawModels.push(...page.output.models);
      } else if (Array.isArray(page.models)) {
        rawModels.push(...page.models);
      } else {
        rawModels.push(page);
      }
    }
  } else if (content.output && Array.isArray(content.output.models)) {
    if (typeof content.output.total === "number") {
      expectedTotal = content.output.total;
    }
    rawModels = content.output.models;
  } else if (Array.isArray(content.models)) {
    rawModels = content.models;
  } else {
    throw new Error("Unrecognized fixture format: expected output.models array or pages array");
  }

  if (expectedTotal !== null && rawModels.length !== expectedTotal) {
    throw new Error(
      `Incomplete model list: expected ${expectedTotal} models from output.total, but received ${rawModels.length} models across pages`,
    );
  }

  const models = transformBailianModelsResponse(rawModels);
  return {
    schemaVersion: SCHEMA_VERSION,
    fetchedAt: options.fetchedAt ?? (models.length > 0 ? "2026-09-29T00:00:00.000Z" : null),
    region,
    workspaceId,
    models,
  };
}

export function formatMetadataDocument(doc) {
  return JSON.stringify(doc, null, 2) + "\n";
}

export async function runCli(argv = process.argv.slice(2)) {
  const checkOnly = argv.includes("--check");
  let outputPath = DEFAULT_METADATA_PATH;
  let fixturePath = null;
  let endpoint = null;
  let region = null;
  let workspaceId = null;
  let pageSize = 100;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" && i + 1 < argv.length) {
      outputPath = argv[++i];
    } else if (arg === "--fixture" && i + 1 < argv.length) {
      fixturePath = argv[++i];
    } else if (arg === "--endpoint" && i + 1 < argv.length) {
      endpoint = argv[++i];
    } else if (arg === "--region" && i + 1 < argv.length) {
      region = argv[++i];
    } else if (arg === "--workspace-id" && i + 1 < argv.length) {
      workspaceId = argv[++i];
    } else if (arg === "--page-size" && i + 1 < argv.length) {
      pageSize = parseInt(argv[++i], 10);
    }
  }

  const targetPath = path.resolve(process.cwd(), outputPath);

  if (checkOnly && !fixturePath && !resolveApiKey()) {
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Baseline metadata file missing: ${outputPath}`);
    }
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(targetPath, "utf8"));
    } catch (err) {
      throw new Error(`Invalid JSON in ${outputPath}: ${err.message}`);
    }
    const errors = validateBailianModelMetadata(existing);
    if (errors.length > 0) {
      throw new Error(`Validation failed for ${outputPath}:\n- ${errors.join("\n- ")}`);
    }
    console.log(`Bailian model metadata baseline verified (offline): ${existing.models.length} models in ${outputPath}`);
    return { status: "verified-offline", modelCount: existing.models.length };
  }

  const result = await fetchBailianModels({
    fixture: fixturePath,
    endpoint,
    region,
    workspaceId,
    pageSize,
  });

  const validationErrors = validateBailianModelMetadata(result);
  if (validationErrors.length > 0) {
    throw new Error(`Result validation failed:\n- ${validationErrors.join("\n- ")}`);
  }

  if (checkOnly) {
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Target file does not exist for --check: ${outputPath}`);
    }
    const actual = fs.readFileSync(targetPath, "utf8");
    const expected = formatMetadataDocument(result);
    if (actual !== expected) {
      throw new Error(`Metadata mismatch in ${outputPath}: file is stale compared to synced result`);
    }
    console.log(`Bailian model metadata verified: ${result.models.length} models match ${outputPath}`);
    return { status: "verified-match", modelCount: result.models.length };
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, formatMetadataDocument(result), "utf8");
  console.log(`Bailian model metadata synced: ${result.models.length} models written to ${outputPath}`);
  return { status: "written", modelCount: result.models.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((err) => {
    console.error(sanitizeErrorMessage(err.message));
    process.exitCode = 1;
  });
}
