"""Offline eval harness (docs/planning/IMPLEMENTATION_PLAN.md §8): corpus ingest, datasets, metrics.

It runs the service's own code in-process against the smartdoc_eval database; data lives in the
repository's eval/ folder. Nothing here is imported by the running services.
"""
