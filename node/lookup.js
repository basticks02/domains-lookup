import fs from "fs";
import dotenv from "dotenv";
import path from "node:path";
import { performance } from "node:perf_hooks";
dotenv.config();

const GODADDY_API_KEY = process.env.GODADDY_API_KEY;
const GODADDY_API_SECRET = process.env.GODADDY_API_SECRET;

if (!GODADDY_API_KEY || !GODADDY_API_SECRET) {
  console.error("❌ Missing GoDaddy API credentials in .env file");
  process.exit(1);
}

const numberOfLetters = parseInt(process.argv[2]);
const tldArg = process.argv[3] || ".com";
const tlds = tldArg
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const BATCH_SIZE = 50;
const DELAY = 2000;
const maxDomainsArg = process.argv[4];
let MAX_DOMAINS = Infinity;

if (maxDomainsArg !== undefined) {
  const parsedLimit = parseInt(maxDomainsArg, 10);
  if (Number.isNaN(parsedLimit) || parsedLimit < 1) {
    console.error("❌ Invalid max domains limit. Provide a positive integer.");
    process.exit(1);
  }
  MAX_DOMAINS = parsedLimit;
}

if (!numberOfLetters || numberOfLetters < 1) {
  console.error(
    "❌ Invalid number of letters. Example: node node/lookup.js 3 .com,.io",
  );
  process.exit(1);
}

console.log(
  `🧩 Config: ${numberOfLetters}-letter combos | TLDs: ${tlds.join(", ")} | Limit: ${
    MAX_DOMAINS === Infinity ? "no limit" : MAX_DOMAINS
  }`,
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

async function checkDomainsBatch(domains) {
  const url = `https://api.ote-godaddy.com/v1/domains/available?checkType=FAST`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `sso-key ${GODADDY_API_KEY}:${GODADDY_API_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(domains),
  });

  if (!response.ok) {
    console.error("⚠️ API Error:", await response.text());
    return [];
  }

  const data = await response.json();
  return data.domains || [];
}

async function main() {
  const runStart = performance.now();
  const combos = generateCombos(numberOfLetters);
  console.log(`🧮 ${combos.length.toLocaleString()} possible combinations`);

  const available = {};
  tlds.forEach((tld) => (available[tld] = []));
  const metrics = {
    plannedDomains: combos.length * tlds.length,
    processedDomains: 0,
    totalBatches: 0,
    requestDurations: [],
    perTld: {},
  };
  tlds.forEach((tld) => {
    metrics.perTld[tld] = {
      batches: 0,
      requestDurations: [],
      durationMs: 0,
      domainsChecked: 0,
    };
  });

  let stopRequested = false;

  for (const tld of tlds) {
    if (stopRequested) break;
    console.log(`\n🔍 Checking ${tld} domains...`);
    const tldStart = performance.now();
    const tldMetrics = metrics.perTld[tld];
    for (let i = 0; i < combos.length && !stopRequested; i += BATCH_SIZE) {
      let batchCombos = combos.slice(i, i + BATCH_SIZE);

      if (MAX_DOMAINS !== Infinity) {
        const remaining = MAX_DOMAINS - metrics.processedDomains;
        if (remaining <= 0) {
          stopRequested = true;
          break;
        }
        if (batchCombos.length > remaining) {
          batchCombos = batchCombos.slice(0, remaining);
          stopRequested = true;
        }
      }

      if (batchCombos.length === 0) break;

      const batch = batchCombos.map((combo) => `${combo}${tld}`);

      const requestStart = performance.now();
      const results = await checkDomainsBatch(batch);
      const requestDuration = performance.now() - requestStart;
      tldMetrics.requestDurations.push(requestDuration);
      metrics.requestDurations.push(requestDuration);
      tldMetrics.batches += 1;
      metrics.totalBatches += 1;
      metrics.processedDomains += batch.length;
      tldMetrics.domainsChecked += batch.length;
      console.log(
        `⏱️ Batch time: ${requestDuration.toFixed(0)} ms (${(
          (batch.length / requestDuration) *
          1000
        ).toFixed(1)} domains/s)`,
      );

      for (const res of results) {
        if (res.available) {
          available[tld].push(res.domain);
          console.log(`🟢 Available: ${res.domain}`);
        } else {
          console.log(`🔴 Taken: ${res.domain}`);
        }
      }

      console.log(`⏳ Processed ${i + batch.length}/${combos.length} for ${tld}`);
      if (!stopRequested) {
        await new Promise((r) => setTimeout(r, DELAY));
      }
    }
    tldMetrics.durationMs = performance.now() - tldStart;
    const tldSeconds = tldMetrics.durationMs / 1000 || 1;
    console.log(
      `⚡ ${tld} processed ${tldMetrics.domainsChecked} domains in ${tldSeconds.toFixed(
        2,
      )}s (${((tldMetrics.domainsChecked / tldSeconds) || 0).toFixed(
        1,
      )} domains/s)`,
    );
  }

  const outputDir = path.resolve("node");
  const outputFile = path.join(outputDir, "available.node.json");
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
    timestamp: new Date().toISOString(),
    letters: numberOfLetters,
    tlds,
    limit: MAX_DOMAINS === Infinity ? null : MAX_DOMAINS,
    plannedDomains: metrics.plannedDomains,
    processedDomains: metrics.processedDomains,
    durationMs: totalDuration,
    domainsPerSecond: Number.isFinite(totalPerSecond) ? totalPerSecond : 0,
    batches: metrics.totalBatches,
    avgBatchMs: avgRequestDuration,
    fastestBatchMs: fastestBatch,
    slowestBatchMs: slowestBatch,
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
    existing.node.push(benchmarkRecord);
    fs.writeFileSync(benchmarkFile, JSON.stringify(existing, null, 2));
    console.log("📦 Benchmark saved to benchmarking/results.json");
  } catch (error) {
    console.warn("⚠️ Could not persist benchmark results:", error);
  }

  console.log(`✅ Done! Results saved to ${path.relative(process.cwd(), outputFile)}`);
}

main().catch((error) => {
  console.error("❌ Lookup failed:", error);
  process.exit(1);
});
