import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  SCHEMA_VERSION,
  DEFAULT_METADATA_PATH,
  isAllowedHost,
  sanitizeErrorMessage,
  normalizeModality,
  normalizeModalitiesList,
  normalizeCategories,
  parseBailianModel,
  transformBailianModelsResponse,
  validateBailianModelMetadata,
  resolveEndpointAndRegion,
  loadFixtureModels,
  runCli,
} from "../release/sync-bailian-models.mjs";

test("checked-in baseline file matches schema with fetchedAt: null and contains no secrets", () => {
  assert.equal(fs.existsSync(DEFAULT_METADATA_PATH), true, "baseline file must exist");
  const baseline = JSON.parse(fs.readFileSync(DEFAULT_METADATA_PATH, "utf8"));
  assert.equal(baseline.schemaVersion, SCHEMA_VERSION);
  assert.equal(baseline.fetchedAt, null, "empty baseline must have fetchedAt: null");
  assert.equal(Array.isArray(baseline.models), true);
  assert.equal(baseline.models.length, 0);
  const errors = validateBailianModelMetadata(baseline);
  assert.deepEqual(errors, []);

  const fileContent = fs.readFileSync(DEFAULT_METADATA_PATH, "utf8");
  assert.equal(/sk-[a-zA-Z0-9_-]{8,}/.test(fileContent), false);
  assert.equal(/bearer/i.test(fileContent), false);
});

test("isAllowedHost strictly enforces Bailian and DashScope allowlist", () => {
  assert.equal(isAllowedHost("dashscope.aliyuncs.com"), true);
  assert.equal(isAllowedHost("dashscope-intl.aliyuncs.com"), true);
  assert.equal(isAllowedHost("ws-12345.cn-beijing.maas.aliyuncs.com"), true);
  assert.equal(isAllowedHost("team-alpha.ap-southeast-1.maas.aliyuncs.com"), true);

  assert.equal(isAllowedHost("api.openai.com"), false);
  assert.equal(isAllowedHost("dashscope.aliyuncs.com.attacker.com"), false);
  assert.equal(isAllowedHost("evil.cn-beijing.maas.aliyuncs.com.cn"), false);
  assert.equal(isAllowedHost("localhost"), false);
  assert.equal(isAllowedHost(""), false);
  assert.equal(isAllowedHost(null), false);
});

test("resolveEndpointAndRegion parses endpoint, region, workspaceId and rejects disallowed hosts/protocols", () => {
  const defaultRes = resolveEndpointAndRegion({});
  assert.equal(defaultRes.hostname, "dashscope.aliyuncs.com");
  assert.equal(defaultRes.region, "cn-beijing");
  assert.equal(defaultRes.workspaceId, null);
  assert.equal(defaultRes.basePath, "/api/v1/models");

  const wsRes = resolveEndpointAndRegion({
    endpoint: "https://ws-team-beta.cn-beijing.maas.aliyuncs.com/api/v1/models",
  });
  assert.equal(wsRes.hostname, "ws-team-beta.cn-beijing.maas.aliyuncs.com");
  assert.equal(wsRes.workspaceId, "ws-team-beta");
  assert.equal(wsRes.region, "cn-beijing");

  const intlRes = resolveEndpointAndRegion({
    endpoint: "https://dashscope-intl.aliyuncs.com/api/v1/models",
  });
  assert.equal(intlRes.region, "ap-southeast-1");

  assert.throws(() => resolveEndpointAndRegion({ endpoint: "http://dashscope.aliyuncs.com/api/v1/models" }), /only https: is permitted/);
  assert.throws(() => resolveEndpointAndRegion({ endpoint: "https://evil.com/api/v1/models" }), /not in the Bailian allowlist/);
  assert.equal(resolveEndpointAndRegion({ endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/models" }).basePath, "/api/v1/models");
  assert.throws(() => resolveEndpointAndRegion({ endpoint: "https://dashscope.aliyuncs.com/api/v1/models?token=secret" }), /Disallowed model metadata endpoint/);
  assert.throws(() => resolveEndpointAndRegion({ endpoint: "https://dashscope.aliyuncs.com/api/v1/models", region: "ap-southeast-1" }), /does not match/);
  assert.throws(() => resolveEndpointAndRegion({ endpoint: "https://ws-team-beta.cn-beijing.maas.aliyuncs.com/api/v1/models", workspaceId: "other-team" }), /does not match/);
});

test("modality and actual category codes normalization work deterministically", () => {
  assert.equal(normalizeModality("text"), "Text");
  assert.equal(normalizeModality("IMAGE"), "Image");
  assert.equal(normalizeModality("Audio"), "Audio");
  assert.equal(normalizeModality("video"), "Video");
  assert.equal(normalizeModality("unknown_modality"), null);

  assert.deepEqual(normalizeModalitiesList(["text", "Audio", "IMAGE", "video"]), ["Audio", "Image", "Text", "Video"]);
  assert.deepEqual(normalizeModalitiesList("text,Audio"), ["Audio", "Text"]);

  const rawActualCaps = [
    { category: "TG" },
    { category_code: "ASR" },
    { code: "Realtime-Audio-Translate" },
    "TTS",
    { name: "Realtime-Omni" },
    null,
    { invalid: 123 },
  ];
  assert.deepEqual(
    normalizeCategories(rawActualCaps),
    ["ASR", "Realtime-Audio-Translate", "Realtime-Omni", "TG", "TTS"],
  );
});

test("parseBailianModel extracts exact model, actual category codes and modalities", () => {
  const raw = {
    model: "qwen3.8-livetranslate-flash-realtime",
    capabilities: [{ category: "Realtime-Audio-Translate" }, { code: "ASR" }],
    inference_metadata: {
      request_modality: ["Audio", "Text"],
      response_modality: ["Audio", "Text"],
    },
  };
  const parsed = parseBailianModel(raw);
  assert.deepEqual(parsed, {
    modelId: "qwen3.8-livetranslate-flash-realtime",
    categories: ["ASR", "Realtime-Audio-Translate"],
    requestModalities: ["Audio", "Text"],
    responseModalities: ["Audio", "Text"],
  });

  assert.throws(() => parseBailianModel({}), /Model item missing valid exact model identifier/);
});

test("transformBailianModelsResponse deterministically sorts by modelId", () => {
  const list = [
    { model: "qwen-plus", capabilities: [{ category: "TG" }] },
    { model: "cosyvoice-v3", capabilities: [{ category: "TTS" }] },
    { model: "qwen3.5-flash", capabilities: [{ category: "TG" }] },
  ];
  const transformed = transformBailianModelsResponse(list);
  assert.deepEqual(
    transformed.map((m) => m.modelId),
    ["cosyvoice-v3", "qwen-plus", "qwen3.5-flash"],
  );
});

test("validateBailianModelMetadata rejects corrupt or non-compliant shapes", () => {
  assert.ok(validateBailianModelMetadata(null).length > 0);
  assert.ok(validateBailianModelMetadata({ schemaVersion: "other/v1" }).length > 0);
  assert.ok(validateBailianModelMetadata({ schemaVersion: SCHEMA_VERSION, fetchedAt: "invalid-date", models: [] }).length > 0);
  assert.ok(
    validateBailianModelMetadata({
      schemaVersion: SCHEMA_VERSION,
      fetchedAt: null,
      models: [
        { modelId: "qwen", categories: [], requestModalities: [], responseModalities: [] },
      ],
    }).some((e) => e.includes("fetchedAt cannot be null")),
  );
  assert.ok(
    validateBailianModelMetadata({
      schemaVersion: SCHEMA_VERSION,
      fetchedAt: "2026-09-29T00:00:00.000Z",
      models: [
        { modelId: "z-model", categories: [], requestModalities: [], responseModalities: [] },
        { modelId: "a-model", categories: [], requestModalities: [], responseModalities: [] },
      ],
    }).some((e) => e.includes("sorted")),
  );
  assert.ok(
    validateBailianModelMetadata({
      schemaVersion: SCHEMA_VERSION,
      fetchedAt: "2026-09-29T00:00:00.000Z",
      models: [
        { modelId: "qwen", categories: [], requestModalities: ["NotAModality"], responseModalities: [] },
      ],
    }).some((e) => e.includes("invalid modality")),
  );
});

test("loadFixtureModels fails closed when output.total does not match models count", () => {
  const tempFixturePath = path.resolve(process.cwd(), "target", "temp-mismatch-fixture.json");
  fs.mkdirSync(path.dirname(tempFixturePath), { recursive: true });
  fs.writeFileSync(
    tempFixturePath,
    JSON.stringify({
      output: {
        total: 10,
        models: [{ model: "model-1" }],
      },
    }),
    "utf8",
  );
  try {
    assert.throws(
      () => loadFixtureModels(tempFixturePath),
      /Incomplete model list: expected 10 models from output.total, but received 1/,
    );
  } finally {
    fs.unlinkSync(tempFixturePath);
  }
});

test("sanitizeErrorMessage strips bearer tokens and api keys", () => {
  const msg = "Failed request with Bearer secret-token-123456 and key sk-998877665544332211";
  const sanitized = sanitizeErrorMessage(msg);
  assert.equal(sanitized.includes("secret-token-123456"), false);
  assert.equal(sanitized.includes("sk-998877665544332211"), false);
  assert.ok(sanitized.includes("Bearer [REDACTED]"));
  assert.ok(sanitized.includes("[REDACTED_API_KEY]"));
});

test("runCli --check offline validates existing baseline without needing API key", async () => {
  const result = await runCli(["--check"]);
  assert.equal(result.status, "verified-offline");
  assert.equal(result.modelCount, 0);
});

test("runCli with fixture writes and validates file with actual category codes deterministically", async () => {
  const fixturePath = "scripts/testing/fixtures/bailian-models-api-fixture.json";
  const tempOut = path.resolve(process.cwd(), "target", "fixture-test-metadata.json");
  fs.mkdirSync(path.dirname(tempOut), { recursive: true });
  try {
    const writeResult = await runCli(["--fixture", fixturePath, "--out", tempOut]);
    assert.equal(writeResult.status, "written");
    assert.equal(writeResult.modelCount, 3);

    const writtenData = JSON.parse(fs.readFileSync(tempOut, "utf8"));
    const qwenVl = writtenData.models.find((m) => m.modelId === "qwen-vl-max");
    assert.deepEqual(qwenVl.categories, ["Realtime-Omni", "TG"]);

    const checkResult = await runCli(["--check", "--fixture", fixturePath, "--out", tempOut]);
    assert.equal(checkResult.status, "verified-match");
    assert.equal(checkResult.modelCount, 3);
  } finally {
    if (fs.existsSync(tempOut)) {
      fs.unlinkSync(tempOut);
    }
  }
});

test("runCli fails closed with clear message when attempting live fetch without credentials", async () => {
  const oldKey = process.env.DASHSCOPE_API_KEY;
  const oldBailian = process.env.BAILIAN_API_KEY;
  const oldOmni = process.env.OMNI_TEST_DASHSCOPE_API_KEY;
  try {
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.BAILIAN_API_KEY;
    delete process.env.OMNI_TEST_DASHSCOPE_API_KEY;

    await assert.rejects(
      () => runCli(["--out", "target/should-not-exist.json"]),
      /No Bailian\/DashScope API key found in environment/,
    );
  } finally {
    if (oldKey) process.env.DASHSCOPE_API_KEY = oldKey;
    if (oldBailian) process.env.BAILIAN_API_KEY = oldBailian;
    if (oldOmni) process.env.OMNI_TEST_DASHSCOPE_API_KEY = oldOmni;
  }
});
