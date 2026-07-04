---
name: sql-injection
description: Use when a request has database-looking parameters, numeric IDs, search/filter/sort fields, login forms, error messages, timing differences, or scanner output suggesting SQL injection.
---

# SQL Injection

Work from a captured or exact request.

1. Identify injectable surfaces: query params, form fields, JSON keys, headers, cookies.
2. Probe safely with `http` using baseline and mutated values; compare status, length, errors, timing, and semantic changes.
3. Use `scan(scanner="sqlmap")` only against a precise URL/request candidate and keep it scoped.
4. Confirm only with evidence showing database-specific behavior, boolean differential, time delay under control, or safe metadata extraction.
5. Mark coverage for each tested `(endpoint, param, sql-injection)` tuple.

A login page, reflected input, or generic 500 is not confirmation by itself.
