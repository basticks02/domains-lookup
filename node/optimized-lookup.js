import fs from "fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import dotenv from "dotenv";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

dotenv.config();

const GODADDY_API_KEY = process.env.GODADDY_API_KEY;
const GODADDY_API_SECRET = process.env.GODADDY_API_SECRET;

if (!GODADDY_API_KEY || !GODADDY_API_SECRET) {
  console.error("❌ Missing GoDaddy API credentials in .env file");
  process.exit(1);
}

const numberOfLetters = parseInt(process.argv[2], 10);
const tldArg = process.argv[3] || ".com";
const tlds = tldArg
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const maxDomainsArg = process.argv[4];
const MAX_RETRIES = 3;
const BATCH_SIZE = 50;
const CONCURRENCY_LIMIT = parseInt(
  process.env.CONCURRENCY_LIMIT || process.env.CONCURRENCY || "200",
  10,
);

if (!numberOfLetters || numberOfLetters < 1) {
  console.error(
    "❌ Invalid number of letters. Example: node node/optimized-lookup.js 3 .com,.io",
  );
  process.exit(1);
}

if (Number.isNaN(CONCURRENCY_LIMIT) || CONCURRENCY_LIMIT < 1) {
  console.error("❌ Invalid CONCURRENCY_LIMIT. Provide a positive integer.");
  process.exit(1);
}

let MAX_DOMAINS = Infinity;
if (maxDomainsArg !== undefined) {
  const parsedLimit = parseInt(maxDomainsArg, 10);
  if (Number.isNaN(parsedLimit) || parsedLimit < 1) {
    console.error("❌ Invalid max domains limit. Provide a positive integer.");
    process.exit(1);
  }
  MAX_DOMAINS = parsedLimit;
}

console.log(
  `⚙️ Optimized run | ${numberOfLetters}-letter combos | TLDs: ${tlds.join(", ")} | Limit: ${
    MAX_DOMAINS === Infinity ? "no limit" : MAX_DOMAINS
  } | Concurrency: ${CONCURRENCY_LIMIT}`,
);

function generateCombos(length) {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const results = [];
  const recurse = (prefix, depth) => {
    if (depth === length) {
      results.push(prefix);
      return;
    }
    for (const char of letters) recurse(prefix + char, depth + 1);
  };
  recurse("", 0);
  return results;
}

function makeLimiter(max) {
  let active = 0;
  const queue = [];

  const runNext = () => {
    if (active >= max) return;
    const next = queue.shift();
    if (!next) return;
    active += 1;
    next()
      .catch((error) => {
        console.error("⚠️ Task failed:", error.message || error);
      })
      .finally(() => {
        active -= 1;
        runNext();
      });
  };

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push(() => fn().then(resolve, reject));
      runNext();
    });
  };
}

function backoffMs(attempt) {
  const base = 120;
  const cap = 1_200;
  const duration = Math.min(cap, base * 2 ** attempt);
  return duration + Math.floor(Math.random() * 100);
}

const keepAliveHttp = new http.Agent({
  keepAlive: true,
  maxSockets: Math.max(CONCURRENCY_LIMIT, 20),
});
const keepAliveHttps = new https.Agent({
  keepAlive: true,
  maxSockets: Math.max(CONCURRENCY_LIMIT, 20),
});

async function requestWithRetry(url, options, retries = MAX_RETRIES) {
  let attempt = 0;
  let lastError;

  while (attempt < retries) {
    try {
      const response = await requestJSON(url, options);
      if (response.status === 429 || response.status >= 500) {
        const body = response.body || "";
        lastError = new Error(
          `HTTP ${response.status}: ${body || response.statusText || "Server busy"}`,
        );
      } else {
        return response;
      }
    } catch (error) {
      lastError = error;
    }

    attempt += 1;
    if (attempt < retries) {
      const delay = backoffMs(attempt - 1);
      console.warn(
        `🔁 Retry ${attempt}/${retries} in ${delay}ms (${options.method || "GET"} ${url})`,
      );
      await sleep(delay);
    }
  }

  throw lastError ?? new Error("Request failed");
}

function requestJSON(url, { method = "GET", headers = {}, body, timeout = 10_000 }) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https:");
    const lib = isHttps ? https : http;
    const agent = isHttps ? keepAliveHttps : keepAliveHttp;

    const req = lib.request(
      url,
      {
        method,
        headers,
        agent,
        timeout,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: data,
          });
        });
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function checkDomainsBatch(domains) {
  const url = `https://api.ote-godaddy.com/v1/domains/available?checkType=FAST`;

  const payload = JSON.stringify(domains);
  const response = await requestWithRetry(url, {
    method: "POST",
    headers: {
      Authorization: `sso-key ${GODADDY_API_KEY}:${GODADDY_API_SECRET}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
    body: payload,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `HTTP ${response.status}: ${response.body || "Unknown error"}`,
    );
  }

  let data;
  try {
    data = JSON.parse(response.body || "{}");
  } catch (error) {
    throw new Error(`Failed to parse response JSON: ${error.message}`);
  }
  return data.domains || [];
}

async function processBatch(tld, batch, tldMetrics, metrics, availableMap) {
  const requestStart = performance.now();
  let results = [];
  let succeeded = false;

  try {
    results = await checkDomainsBatch(batch);
    succeeded = true;
  } catch (error) {
    console.error(
      `⚠️ ${tld} batch failed (${batch[0]}…): ${error.message || error}`,
    );
  }

  const requestDuration = performance.now() - requestStart;
  metrics.requestDurations.push(requestDuration);
  tldMetrics.requestDurations.push(requestDuration);
  metrics.totalBatches += 1;
  tldMetrics.batches += 1;
  tldMetrics.lastFinish = performance.now();
  console.log(
    `⏱️ ${tld} batch (${batch.length} domains) in ${requestDuration.toFixed(
      0,
    )} ms (${((batch.length / requestDuration) * 1000).toFixed(
      1,
    )} domains/s)`,
  );

  if (!succeeded || !Array.isArray(results) || results.length === 0) {
    return;
  }

  metrics.processedDomains += results.length;
  tldMetrics.domainsChecked += results.length;

  for (const res of results) {
    if (res.available) {
      availableMap[tld].push(res.domain);
      console.log(`🟢 Available: ${res.domain}`);
    } else {
      console.log(`🔴 Taken: ${res.domain}`);
    }
  }

  const processedLimit =
    MAX_DOMAINS === Infinity ? metrics.plannedDomains : MAX_DOMAINS;
  console.log(
    `⏳ Progress: ${metrics.processedDomains}/${processedLimit} domains processed`,
  );
}

async function main() {
  const runStart = performance.now();
  const combos = generateCombos(numberOfLetters);
  console.log(`🧮 ${combos.length.toLocaleString()} possible combinations`);

  const available = {};
  const metrics = {
    plannedDomains: combos.length * tlds.length,
    scheduledDomains: 0,
    processedDomains: 0,
    totalBatches: 0,
    requestDurations: [],
    perTld: {},
    concurrency: CONCURRENCY_LIMIT,
  };

  tlds.forEach((tld) => {
    available[tld] = [];
    metrics.perTld[tld] = {
      scheduledDomains: 0,
      domainsChecked: 0,
      batches: 0,
      requestDurations: [],
      startTime: null,
      lastFinish: null,
      durationMs: 0,
    };
  });

  const limit = makeLimiter(CONCURRENCY_LIMIT);
  let stopRequested = false;
  const tasks = [];

  for (const tld of tlds) {
    if (stopRequested) break;
    console.log(`\n🔍 Scheduling ${tld} domains...`);
    const tldMetrics = metrics.perTld[tld];

    for (let i = 0; i < combos.length && !stopRequested; i += BATCH_SIZE) {
      let batchCombos = combos.slice(i, i + BATCH_SIZE);

      const remaining =
        MAX_DOMAINS === Infinity
          ? Infinity
          : MAX_DOMAINS - metrics.scheduledDomains;
      if (remaining <= 0) {
        stopRequested = true;
        break;
      }
      if (batchCombos.length > remaining) {
        batchCombos = batchCombos.slice(0, remaining);
        stopRequested = true;
      }

      if (batchCombos.length === 0) break;

      const batch = batchCombos.map((combo) => `${combo}${tld}`);
      metrics.scheduledDomains += batch.length;
      tldMetrics.scheduledDomains += batch.length;
      if (tldMetrics.startTime === null) {
        tldMetrics.startTime = performance.now();
      }

    tasks.push(limit(() => processBatch(tld, batch, tldMetrics, metrics, available)));
    }
  }

  await Promise.all(tasks);
  keepAliveHttp.destroy();
  keepAliveHttps.destroy();

  for (const tld of tlds) {
    const tldMetrics = metrics.perTld[tld];
    if (!tldMetrics.startTime) continue;
    const durationMs =
      tldMetrics.durationMs ||
      (tldMetrics.lastFinish
        ? tldMetrics.lastFinish - tldMetrics.startTime
        : 0);
    tldMetrics.durationMs = durationMs;
    const tldSeconds = durationMs / 1000 || 1;
    console.log(
      `⚡ ${tld} processed ${tldMetrics.domainsChecked} domains in ${tldSeconds.toFixed(
        2,
      )}s (${((tldMetrics.domainsChecked / tldSeconds) || 0).toFixed(
        1,
      )} domains/s)`,
    );
  }

  const outputDir = path.resolve("node");
  const outputFile = path.join(outputDir, "available.optimized.json");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(available, null, 2));

  if (MAX_DOMAINS !== Infinity && metrics.processedDomains >= MAX_DOMAINS) {
    console.log(
      `🚧 Stopped early after reaching the ${MAX_DOMAINS}-domain limit.`,
    );
  }

  const totalDuration = performance.now() - runStart;
  const totalSeconds = totalDuration / 1000 || 1;
  const totalPerSecond = metrics.processedDomains / totalSeconds;
  const avgRequestDuration = metrics.requestDurations.length
    ? metrics.requestDurations.reduce((sum, ms) => sum + ms, 0) /
      metrics.requestDurations.length
    : 0;
  const fastestBatch = metrics.requestDurations.length
    ? Math.min(...metrics.requestDurations)
    : 0;
  const slowestBatch = metrics.requestDurations.length
    ? Math.max(...metrics.requestDurations)
    : 0;
  const summaryLine = `Overall: ${totalSeconds.toFixed(2)}s for ${metrics.processedDomains} domains (${totalPerSecond.toFixed(1)} domains/s)`;
  console.log(`\n📈 ${summaryLine}`);
  if (metrics.requestDurations.length) {
    console.log(
      `📉 Avg batch: ${avgRequestDuration.toFixed(
        0,
      )} ms | Fastest batch: ${fastestBatch.toFixed(
        0,
      )} ms | Slowest batch: ${slowestBatch.toFixed(0)} ms`,
    );
  } else {
    console.log("📉 No batch timing data recorded.");
  }

  const benchmarkDir = path.resolve("benchmarking");
  const benchmarkFile = path.join(benchmarkDir, "results.json");
  const benchmarkRecord = {
    implementation: "optimized-node",
    timestamp: new Date().toISOString(),
    letters: numberOfLetters,
    tlds,
    limit: MAX_DOMAINS === Infinity ? null : MAX_DOMAINS,
    plannedDomains: metrics.plannedDomains,
    scheduledDomains: metrics.scheduledDomains,
    processedDomains: metrics.processedDomains,
    durationMs: totalDuration,
    domainsPerSecond: Number.isFinite(totalPerSecond) ? totalPerSecond : 0,
    batches: metrics.totalBatches,
    avgBatchMs: avgRequestDuration,
    fastestBatchMs: fastestBatch,
    slowestBatchMs: slowestBatch,
    concurrency: CONCURRENCY_LIMIT,
    outputFile: path.relative(process.cwd(), outputFile),
    summary: summaryLine,
  };

  try {
    fs.mkdirSync(benchmarkDir, { recursive: true });
    let existing = {
      node: [],
      optimizedNode: [],
    };
    if (fs.existsSync(benchmarkFile)) {
      try {
        const raw = fs.readFileSync(benchmarkFile, "utf-8").trim();
        if (raw) {
          existing = JSON.parse(raw);
        }
      } catch (error) {
        console.warn("⚠️ Could not read benchmarking file, creating a new one.");
      }
    }
    if (!Array.isArray(existing.node)) {
      existing.node = [];
    }
    if (!Array.isArray(existing.optimizedNode)) {
      existing.optimizedNode = [];
    }
    existing.optimizedNode.push(benchmarkRecord);
    fs.writeFileSync(benchmarkFile, JSON.stringify(existing, null, 2));
    console.log("📦 Benchmark saved to benchmarking/results.json");
  } catch (error) {
    console.warn("⚠️ Could not persist benchmark results:", error);
  }

  console.log(
    `✅ Optimized run complete. Results saved to ${path.relative(process.cwd(), outputFile)}`,
  );
}

main().catch((error) => {
  console.error("❌ Optimized lookup failed:", err