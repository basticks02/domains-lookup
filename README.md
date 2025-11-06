# Domains Lookup - Optimized + Benchmarking

This project benchmarks domain availability lookups against the GoDaddy API. It ships with two Node.js implementations so you can measure the payoff from performance tuning:

- `node/lookup.js` – baseline, sequential batches with conservative pacing.
- `node/optimized-lookup.js` – high-concurrency runner that removes artificial delays, reuses connections, and retries politely, routinely finishing ~98% faster in real runs (e.g., ~48 s → ~0.81 s for 5 runs of 1,000 domains).

The bundled Python harness runs both implementations with identical parameters, validates that their outputs match, and records comparative metrics for easy analysis.

## Setup

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Configure API credentials:**

   Create a `.env` file in the project root:

   ```env
   GODADDY_API_KEY=your_api_key_here
   GODADDY_API_SECRET=your_api_secret_here
   ```

   Get your API credentials from [GoDaddy Developer Portal](https://developer.godaddy.com/keys).

## Usage

Baseline script:

```bash
node node/lookup.js <number_of_letters> [tlds] [max_domains]
```

Optimized script:

```bash
node node/optimized-lookup.js <number_of_letters> [tlds] [max_domains]
```

### Parameters

- `<number_of_letters>` - Length of domain combinations to generate (e.g., 3 for "abc", "xyz")
- `[tlds]` - (Optional) Comma-separated list of TLDs to check (default: `.com`)
- `[max_domains]` - (Optional) Positive integer cap on how many domains to process before stopping

### Examples

**Check 3-letter .com domains:**

```bash
node node/lookup.js 3
```

**Check 3-letter domains across multiple TLDs:**

```bash
node node/lookup.js 3 .com,.io,.dev
```

**Stop after checking the first 1,000 .com domains (baseline):**

```bash
node node/lookup.js 3 .com 1000
```

**Run the optimized script with 300 max domains of .io:**

```bash
CONCURRENCY_LIMIT=200 node node/optimized-lookup.js 3 .io 300
```

## Output

- Baseline script streams progress logs and saves results to `node/available.node.json`
- Optimized script reports per-batch throughput and saves results to `node/available.optimized.json`

```
{
  ".com": ["abcd.com", "efgh.com"],
  ".io": ["abcd.io"]
}
```

### Example Output

```
🧩 Config: 3-letter combos | TLDs: .com, .io | Limit: no limit
🧮 17,576 possible combinations
🔍 Checking .com domains...
⏱️ Batch time: 812 ms (61.6 domains/s)
🟢 Available: xyz.com
🔴 Taken: abc.com
⏳ Processed 150/17,576 for .com
⚡ .com processed 500 domains in 9.88s (50.6 domains/s)

📈 Overall: 19.78s for 1,000 domains (50.6 domains/s)
📉 Avg batch: 812 ms | Fastest batch: 742 ms | Slowest batch: 925 ms
📦 Benchmark saved to benchmarking/results.json
✅ Done! Results saved to node/available.node.json
```

The optimized runner emits similar output but with additional per-batch timing details and higher overall throughput logs.

## Automated Benchmarks

Run multiple back-to-back comparisons (baseline vs optimized) with the helper script:

```bash
python benchmarking/run_benchmarks.py --runs 5 --letters 3 --limit 1000 --tlds ".com,.io,.dev,.app" --tlds-per-run 2 --concurrency 200 --summary-out benchmarking/summary.json
```

- Each iteration uses the same parameters for both scripts and appends their metrics to `benchmarking/results.json`.
- Availability outputs are compared to ensure both implementations return identical results.
- The optional summary file aggregates average durations, speed-ups, and highlights any mismatches. Use `--dry-run` to preview the planned scenarios without executing the Node scripts.

### Sample Benchmark Output

```
🔴 Taken: ank.com
🔴 Taken: anl.com
⏳ Progress: 1000/1000 domains processed
⚡ .com processed 1000 domains in 0.79s (1263.9 domains/s)
🚧 Stopped early after reaching the 1000-domain limit.

📈 Overall: 0.81s for 1000 domains (1230.0 domains/s)
📉 Avg batch: 497 ms | Fastest batch: 433 ms | Slowest batch: 767 ms
📦 Benchmark saved to benchmarking/results.json
✅ Optimized run complete. Results saved to node/available.optimized.json
✅ Speedup: 98.3% (baseline Overall: 48.13s for 1000 domains (20.8 domains/s), optimized Overall: 0.81s for 1000 domains (1230.0 domains/s))

===== Aggregate Summary =====
{
  "executed_at": "2025-11-06T17:38:30.514401Z",
  "run_count": 5,
  "avg_speedup_pct": 98.3850340432159,
  "avg_baseline_duration_ms": 48064.398,
  "avg_optimized_duration_ms": 777.2623666000001,
  "total_mismatched_tlds": 0,
  "total_mismatched_domains": 0
}
```

## Why the Optimized Runner Is Faster

The optimized script preserves the same API contract and batch size as the baseline (`50` domains per request), but removes the inefficiencies that dominate wall time in the original implementation:

- **No fixed inter-batch delay.** The baseline sleeps for `DELAY = 2000ms` after every batch; with 1,000 domains and batch size 50 (20 batches) that alone burns ~40 seconds. The optimized runner eliminates the artificial pause, so wall time mostly reflects actual network work (~0.8s in a sample run).
- **Bounded concurrency.** Instead of awaiting each batch sequentially, the optimized runner uses a semaphore (`CONCURRENCY_LIMIT`, default 200) to keep many batches in flight simultaneously. Wall clock becomes the time of the slowest batch, not the sum of all batches.
- **Connection reuse.** It reuses HTTP/HTTPS agents with `keepAlive` and large socket pools, so you don’t pay a TCP/TLS handshake per request. This makes high concurrency practical.
- **Retry with backoff when needed.** 429/5xx responses trigger exponential backoff + jitter, keeping throughput high without overwhelming the API.
- **Lower-level request control.** Custom `requestJSON` / `requestWithRetry` functions allow explicit timeouts, headers, and pooling, avoiding the overhead of `fetch`’s defaults.

These changes, coupled with identical batching, lead to observed speedups of ~98% in realistic runs (e.g., 48s → 0.81s for 1,000 domains).

## Rate Limiting

The tool includes built-in delays (2 seconds) between batch requests to respect API rate limits. Each batch processes 50 domains at a time.

## Notes

- Currently configured for GoDaddy's OTE (test) environment
- For production use, change the API URL to `https://api.godaddy.com/v1/domains/available`
- Each run appends timing data to `benchmarking/results.json` under the relevant implementation key (`node`, `optimizedNode`, etc.) for side-by-side comparisons.
- Output files live inside the `node/` directory (`available.node.json` for the baseline script and `available.optimized.json` for the optimized script); keep the same convention for any future experiments.
