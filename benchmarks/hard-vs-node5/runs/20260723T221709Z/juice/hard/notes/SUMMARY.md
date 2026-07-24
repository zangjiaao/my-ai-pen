# Hard arm — Juice P1 (Hard vs Node5)

**Graph:** `app_assessment_thin` Hard Graph thin  
**Target:** http://127.0.0.1:3010 (`juice-hvn5-hard`, clean)  
**Stamp:** `20260723T221709Z`  
**Model:** deepseek / deepseek-v4-flash  
**Node SHA:** f373c68  
**Branch:** research/node5-lab-invocation-juice-dvwa  
**Terminal:** completed (`hard_graph_completed`)  
**Booked findings:** 2  
**Wall-clock:** ~779s  

## Stages

See `hard-graph-run-result.json` / stage `result.json` under workspace.

## Booked findings (titles)

1. high — Sensitive File Exposure - Encryption Keys (`http://127.0.0.1:3010/encryptionkeys/`)
2. critical — SQL Injection in Login Endpoint (Auth Bypass) (`http://127.0.0.1:3010/rest/user/login`)
