# Recipe: multi-step HTTP with session tool

Instead of:

```bash
curl -c jar -b jar -d 'user=a&pass=b' URL/login
curl -b jar URL/next
```

Use:

```text
session(op=chain, steps=[
  { method: "POST", url: "/login", body: "user=a&pass=b", headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  { method: "GET", url: "/challenge" }
])
session(op=jar_get)   # inspect cookies
session(op=history, limit=10)
```

Then book any proven flag with `finding(confirm)+evidence_ids` from the session evidence ids.
