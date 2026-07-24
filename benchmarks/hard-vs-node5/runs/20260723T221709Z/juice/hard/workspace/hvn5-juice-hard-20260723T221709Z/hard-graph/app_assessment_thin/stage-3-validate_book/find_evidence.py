import os
import glob

# Check various paths
paths_to_check = [
    ".",
    "/mnt/d/Coding/my-ai-pen/benchmarks/hard-vs-node5/runs/20260723T221709Z/juice/hard/workspace/hvn5-juice-hard-20260723T221709Z/hard-graph/app_assessment_thin/stage-3-validate_book",
]
for p in paths_to_check:
    print(f"Checking: {p}")
    try:
        for f in os.listdir(p):
            print(f"  {f}")
    except Exception as e:
        print(f"  Error: {e}")
