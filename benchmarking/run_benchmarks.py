#!/usr/bin/env python3
"""
Benchmark orchestrator for comparing baseline and optimized Node lookups.

The script runs both implementations with identical parameters, records their
metrics in `benchmarking/results.json`, and generates a comparison summary
including percentage speed improvements. It can be extended to emit CSV or
visualisations once run data is available.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Tuple

REPO_ROOT = Path(__file__).resolve().parents[1]
RESULTS_PATH = REPO_ROOT / "benchmarking" / "results.json"
BASELINE_OUTPUT = REPO_ROOT / "node" / "available.node.json"
OPTIMIZED_OUTPUT = REPO_ROOT / "node" / "available.optimized.json"


class BenchmarkError(RuntimeError):
  """Raised when a benchmark run fails."""


def load_results() -> Dict[str, List[Dict[str, Any]]]:
  if not RESULTS_PATH.exists():
    return {"node": [], "optimizedNode": []}
  with RESULTS_PATH.open("r", encoding="utf-8") as fh:
    data = json.load(fh)
  data.setdefault("node", [])
  data.setdefault("optimizedNode", [])
  return data


def load_available(path: Path) -> Dict[str, List[str]]:
  if not path.exists():
    return {}
  with path.open("r", encoding="utf-8") as fh:
    return json.load(fh)


def run_command(cmd: List[str], extra_env: Dict[str, str] | None = None) -> None:
  env = os.environ.copy()
  if extra_env:
    env.update(extra_env)
  process = subprocess.run(
    cmd,
    cwd=str(REPO_ROOT),
    env=env,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    check=False,
  )
  if process.returncode != 0:
    raise BenchmarkError(
      f"Command failed ({process.returncode}): {' '.join(cmd)}\n{process.stdout}"
    )
  sys.stdout.write(process.stdout)


def diff_available(
  baseline: Dict[str, List[str]], optimized: Dict[str, List[str]]
) -> Tuple[int, int]:
  """Returns the count of mismatched available domains."""
  total_mismatch = 0
  per_tld_mismatch = 0
  all_tlds = set(baseline.keys()) | set(optimized.keys())
  for tld in sorted(all_tlds):
    base_set = set(baseline.get(tld, []))
    opt_set = set(optimized.get(tld, []))
    if base_set != opt_set:
      per_tld_mismatch += 1
      total_mismatch += len(base_set.symmetric_difference(opt_set))
  return per_tld_mismatch, total_mismatch


def format_speedup(baseline_ms: float, optimized_ms: float) -> float:
  if baseline_ms <= 0:
    return 0.0
  return ((baseline_ms - optimized_ms) / baseline_ms) * 100.0


def random_tlds(pool: List[str], sample_size: int, rng: random.Random) -> List[str]:
  sample_size = max(1, min(sample_size, len(pool)))
  return sorted(rng.sample(pool, sample_size))


def benchmark_once(
  number_of_letters: int,
  tlds: List[str],
  max_domains: int,
  concurrency: int,
  baseline_offset: int,
  optimized_offset: int,
) -> Dict[str, Any]:
  tld_arg = ",".join(tlds)
  baseline_cmd = [
    "node",
    "node/lookup.js",
    str(number_of_letters),
    tld_arg,
    str(max_domains),
  ]
  optimized_cmd = [
    "node",
    "node/optimized-lookup.js",
    str(number_of_letters),
    tld_arg,
    str(max_domains),
  ]

  print(f"👟 Baseline run: letters={number_of_letters}, tlds={tld_arg}, limit={max_domains}")
  run_command(baseline_cmd)
  results = load_results()
  try:
    baseline_entry = results["node"][baseline_offset]
  except IndexError as exc:
    raise BenchmarkError("Baseline run did not append to results.json") from exc

  print(f"⚡ Optimized run: letters={number_of_letters}, tlds={tld_arg}, limit={max_domains}, concurrency={concurrency}")
  run_command(
    optimized_cmd,
    extra_env={"CONCURRENCY_LIMIT": str(concurrency)},
  )
  results = load_results()
  try:
    optimized_entry = results["optimizedNode"][optimized_offset]
  except IndexError as exc:
    raise BenchmarkError("Optimized run did not append to results.json") from exc

  baseline_available = load_available(BASELINE_OUTPUT)
  optimized_available = load_available(OPTIMIZED_OUTPUT)
  mismatched_tlds, mismatched_domains = diff_available(
    baseline_available, optimized_available
  )

  baseline_ms = baseline_entry.get("durationMs", 0.0)
  optimized_ms = optimized_entry.get("durationMs", 0.0)
  speedup_pct = format_speedup(baseline_ms, optimized_ms)

  return {
    "letters": number_of_letters,
    "tlds": tlds,
    "limit": max_domains,
    "concurrency": concurrency,
    "baseline": baseline_entry,
    "optimized": optimized_entry,
    "speedup_pct": speedup_pct,
    "mismatched_tlds": mismatched_tlds,
    "mismatched_domains": mismatched_domains,
  }


def summarise(runs: List[Dict[str, Any]]) -> Dict[str, Any]:
  if not runs:
    return {"runs": [], "summary": {}}

  total_speedup = 0.0
  total_baseline_ms = 0.0
  total_optimized_ms = 0.0
  total_mismatched_tlds = 0
  total_mismatched_domains = 0

  for run in runs:
    total_speedup += run["speedup_pct"]
    total_baseline_ms += run["baseline"].get("durationMs", 0.0)
    total_optimized_ms += run["optimized"].get("durationMs", 0.0)
    total_mismatched_tlds += run["mismatched_tlds"]
    total_mismatched_domains += run["mismatched_domains"]

  count = len(runs)
  summary = {
    "runs": runs,
    "summary": {
      "executed_at": datetime.utcnow().isoformat() + "Z",
      "run_count": count,
      "avg_speedup_pct": total_speedup / count if count else 0.0,
      "avg_baseline_duration_ms": total_baseline_ms / count if count else 0.0,
      "avg_optimized_duration_ms": total_optimized_ms / count if count else 0.0,
      "total_mismatched_tlds": total_mismatched_tlds,
      "total_mismatched_domains": total_mismatched_domains,
    },
  }
  return summary


def save_summary(path: Path, data: Dict[str, Any]) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  with path.open("w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(
    description="Run controlled benchmark passes across baseline and optimized lookup scripts.",
  )
  parser.add_argument("--runs", type=int, default=3, help="Number of benchmark scenarios to execute.")
  parser.add_argument("--letters", type=int, default=3, help="Number of letters per domain combination.")
  parser.add_argument("--limit", type=int, default=500, help="Maximum domains per run.")
  parser.add_argument("--tlds", type=str, default=".com,.io,.dev,.app,.ai,.xyz", help="Comma-separated pool of TLDs to sample from.")
  parser.add_argument("--tlds-per-run", type=int, default=2, help="How many TLDs to include per run (sampled without replacement).")
  parser.add_argument("--concurrency", type=int, default=200, help="Concurrency limit passed to the optimized script.")
  parser.add_argument("--seed", type=int, default=13, help="Random seed for reproducible sampling.")
  parser.add_argument("--summary-out", type=str, help="Optional path to write aggregated summary JSON.")
  parser.add_argument("--dry-run", action="store_true", help="Log planned scenarios without executing node scripts.")
  return parser.parse_args()


def main() -> None:
  args = parse_args()
  rng = random.Random(args.seed)
  tld_pool = [t.strip() for t in args.tlds.split(",") if t.strip()]
  if not tld_pool:
    raise SystemExit("No TLDs provided to sample from.")

  existing_results = load_results()
  baseline_offset = len(existing_results["node"])
  optimized_offset = len(existing_results["optimizedNode"])

  planned_scenarios = []
  for _ in range(args.runs):
    chosen_tlds = random_tlds(tld_pool, args.tlds_per_run, rng)
    planned_scenarios.append(chosen_tlds)

  if args.dry_run:
    print("Planned scenarios (dry-run):")
    for idx, tlds in enumerate(planned_scenarios, start=1):
      print(f"  Run {idx}: letters={args.letters}, limit={args.limit}, tlds={','.join(tlds)}")
    return

  runs: List[Dict[str, Any]] = []
  for idx, tlds in enumerate(planned_scenarios, start=1):
    print(f"\n===== Benchmark {idx}/{len(planned_scenarios)} =====")
    try:
      result = benchmark_once(
        number_of_letters=args.letters,
        tlds=tlds,
        max_domains=args.limit,
        concurrency=args.concurrency,
        baseline_offset=baseline_offset,
        optimized_offset=optimized_offset,
      )
      runs.append(result)
      baseline_offset += 1
      optimized_offset += 1
      print(
        f"✅ Speedup: {result['speedup_pct']:.1f}% "
        f"(baseline {result['baseline']['summary']}, optimized {result['optimized']['summary']})"
      )
      if result["mismatched_domains"]:
        print(
          f"⚠️ Availability mismatch detected: {result['mismatched_domains']} domains across "
          f"{result['mismatched_tlds']} TLDs"
        )
    except BenchmarkError as exc:
      print(f"❌ Benchmark {idx} failed: {exc}")
      break

  summary = summarise(runs)
  print("\n===== Aggregate Summary =====")
  print(json.dumps(summary["summary"], indent=2))

  if args.summary_out:
    save_summary(Path(args.summary_out), summary)
    print(f"📝 Summary written to {args.summary_out}")


if __name__ == "__main__":
  main()
